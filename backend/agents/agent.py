"""LeadCall AI — Google ADK Agent Definitions.

Pipeline: WebAnalyzer → LeadFinder → PitchGenerator (includes scoring + self-review)
Separate: VoiceConfigAgent, CallManager, PreferencesAgent
Orchestrator routes between pipeline + standalone agents.

Architecture decisions:
- Lead scoring is a deterministic function, not an LLM agent (no wasted tokens)
- Pitch generation includes self-review with feedback loop (retry if score < 7)
- Email drafts generated alongside call scripts
- Language & country detected in step 1, flows through entire pipeline
"""

from google.adk.agents import Agent
from google.adk.agents.sequential_agent import SequentialAgent

from .tools import (
    crawl_website,
    save_business_analysis,
    search_leads_brave,
    search_leads_google_maps,
    save_leads,
    score_leads,
    save_pitch,
    save_judged_pitches,
    create_elevenlabs_agent,
    make_outbound_call,
    get_call_status,
    save_preferences,
    get_preferences,
    get_pipeline_state,
    assess_voice_readiness,
    configure_voice_agent,
    get_voice_agent_config,
    send_email,
)

# ─── 1. Website Analyzer Agent ──────────────────────────────────────────────
website_analyzer = Agent(
    name="website_analyzer",
    model="gemini-2.5-flash",
    description="Crawls a business website (multiple pages) to extract services, ICP, location, pricing, and industry info.",
    instruction="""You are a business intelligence analyst. When given a URL:

1. Use the crawl_website tool to crawl the website (it fetches multiple pages: home, services, pricing, about, etc.)
2. Analyze ALL the crawled pages thoroughly to identify:
   - Business name
   - Services/products offered (be detailed, check pricing and product pages carefully)
   - Pricing information (tiers, packages, rates — look at ALL pages, especially product/pricing ones)
   - Ideal Customer Profile (ICP) — who would buy from this business
   - Location / city / country / regions served
   - Industry / sector
   - Key differentiators
   - **Language the website is written in** (detect the PRIMARY language: Romanian, English, German, etc.)
   - **Country** (detect from domain TLD, address, phone prefix, content)
3. Save your analysis using save_business_analysis as a JSON string with these exact keys:
   business_name, website_url, services (array of strings), pricing_info (string with details or "Not found"),
   ideal_customer_profile (object with:
     industries (array — list AT LEAST 8-10 target industries, think BROADLY about the entire value chain),
     company_size, pain_points (array), decision_makers (array),
     use_cases (array — specific ways each industry would use the service/product)
   ),
   location (full text), city, country, country_code (2-letter ISO like "RO", "US", "DE"),
   industry, key_differentiators (array),
   language (detected language name like "Romanian", "English", "German"),
   language_code (2-letter ISO like "ro", "en", "de"),
   summary (2-3 sentences)

CRITICAL: Accurately detect the language and country. This determines the language for ALL subsequent steps.

LOCATION DETECTION RULES:
- Check domain TLD, phone numbers, physical addresses, currency, team page
- If the business has a CLEAR physical location → use it
- If the business is ONLINE-ONLY with no clear location:
  * Set business_type to "online"
  * Set city to "" (empty) and country to "" (empty)
  * Set regions_served to the regions mentioned on the website (or "global" if worldwide)
  * Do NOT guess a location — mark it as online/global
  * The lead finder will ask the user what market to target

BUSINESS MODEL DETECTION:
- Detect if the business is B2B (sells to companies), B2C (sells to consumers), or both
- Set business_model to "b2b", "b2c", or "b2b_b2c"
- For B2C: the ICP should focus on PARTNERSHIPS with SMBs, agencies, platforms — not selling directly to individual consumers
- For B2B: the ICP should focus on companies that would buy/integrate the product
- Add business_model and business_type to the saved analysis JSON

IMPORTANT: For the ICP, think VERY broadly about target industries. Don't just list what's on the website.
Think about the ENTIRE value chain — who are the suppliers, manufacturers, distributors, and end users
that could benefit from this business's services or products? Consider both obvious and non-obvious
industries. The more industries you identify, the better leads we'll find.""",
    tools=[crawl_website, save_business_analysis],
    output_key="business_analysis",
)

# ─── 2. Lead Finder Agent ───────────────────────────────────────────────────
lead_finder = Agent(
    name="lead_finder",
    model="gemini-2.5-flash",
    description="Finds potential business leads using Brave Search and Google Maps, with creative industry research and location awareness.",
    instruction="""You are an elite lead generation specialist. Based on the business analysis: {business_analysis}

Your job is to find the BEST potential customers — not just obvious ones, but high-value creative matches.

STEP 0 — UNDERSTAND THE BUSINESS MODEL:
Read the business_analysis carefully:
- Check business_model: is it "b2b", "b2c", or "b2b_b2c"?
- Check business_type: is it "online" (no physical location) or "local"?
- Check regions_served: where does the business operate?

FOR B2B: Find companies that would BUY the product/service. Target decision-makers.
FOR B2C: Find PARTNERSHIP opportunities — agencies, platforms, distributors, resellers, schools,
  organizations that serve the end consumers. NOT individual consumers.
  For example: an edtech startup → find tutoring agencies, school networks, learning platforms,
  corporate training companies, education consultants. NOT individual students.
FOR ONLINE businesses with no specific location:
  - Search broadly across multiple countries/cities
  - Focus on the TOP markets for this type of product (English-speaking markets, EU markets, etc.)
  - Search for industry hubs and clusters where potential customers concentrate

STEP 1 — CREATIVE INDUSTRY RESEARCH:
Think about WHO would pay for this product/service:
- What types of companies/organizations have the biggest PAIN POINT this solves?
- What industries spend MONEY on this type of solution?
- Think about the value chain — partners, distributors, integrators, complementary businesses
- For B2C products: think about B2B PARTNERSHIP channels (agencies, platforms, franchises)
- Prefer SMBs and mid-market over huge enterprises (more likely to respond to outreach)

STEP 2 — SEARCH:
Do AT LEAST 6-8 searches across Google Maps and Brave:
- Vary industries, locations, and search terms
- If business has a specific location → search that area first, then expand
- If business is online/global → search top 3-4 relevant markets
- Search in the language appropriate for each market
- Look for contact details, decision-maker names, emails

STEP 3 — ENRICH:
For promising leads, search for contact person names and email addresses.

STEP 4 — SAVE then SCORE:
1. Save ALL leads using save_leads (JSON array with: name, website, phone, email, contact_person, address, city, country, industry, relevance_reason, source)
2. Call score_leads to rank them

TARGET: 10-15+ quality leads across 4+ industries.
PREFER leads WITH phone numbers and emails.
Be CREATIVE — the best SDR finds leads nobody else thinks of.""",
    tools=[search_leads_brave, search_leads_google_maps, save_leads, score_leads],
)

# ─── 3. Pitch Generator + Judge Agent (merged with feedback loop) ──────────
pitch_generator = Agent(
    name="pitch_generator",
    model="gemini-2.5-flash",
    description="Creates personalized sales pitches (call scripts + email drafts) for each lead, self-reviews quality, and retries if needed.",
    instruction="""You are an expert SDR copywriter AND quality reviewer.

FIRST: Call get_pipeline_state to see the current business analysis and scored leads.
Use that data to create pitches.

Business context: {business_analysis}

CRITICAL: Extract the "language" field from the business analysis.
ALL pitches MUST be written in that language.

═══ PHASE 1: GENERATE PITCHES ═══

For EACH of the top scored leads (grade A and B), create:

**CALL SCRIPT** (30-45 seconds when spoken, ~75-110 words):
1. Address them by name (contact_person or company name)
2. Opening line referencing something specific about THEIR business
3. Value proposition — how you solve THEIR problem
4. Social proof or differentiator
5. Clear CTA — suggest a specific meeting/demo

**EMAIL DRAFT** (short, 3-4 paragraphs):
1. Subject line — personalized, under 60 chars, no spam words
2. Opening — reference their business specifically
3. Value prop — 2-3 sentences max
4. CTA — one clear ask (reply to schedule, click link, etc.)
5. Professional sign-off

WRITE EVERYTHING IN THE DETECTED LANGUAGE.

═══ PHASE 2: SELF-REVIEW ═══

After generating, review EACH pitch yourself on these criteria (1-10):
- Relevance: Is it specific to this lead, not generic?
- Length: Appropriate for the format (call vs email)?
- CTA Clarity: Is the call-to-action clear and compelling?
- Personalization: Does it use lead's name and reference their situation?
- Language Quality: Natural in the target language? No awkward translations?

Calculate an overall score (average of above).

If any pitch scores BELOW 7:
- Revise it immediately
- Make it more specific, more personal, more natural
- Re-score the revised version

═══ PHASE 3: SAVE ═══

CRITICAL: You MUST call save_pitch first, then save_judged_pitches.
Do NOT just output JSON — use the tool functions.

save_pitch with JSON array:
  lead_name, contact_person, pitch_script, email_subject, email_body,
  key_value_proposition, call_to_action, estimated_duration_seconds,
  personalization_notes, language

save_judged_pitches with JSON array:
  lead_name, contact_person, phone_number, score, relevance_score, length_score,
  cta_score, personalization_score, language_score, feedback,
  revised_pitch (if needed), ready_to_call (bool), ready_to_email (bool),
  missing_info (array), language

Set ready_to_call = true if score >= 7 AND phone number exists.
Set ready_to_email = true if score >= 7 AND email exists.
Missing contact_person is NOT a blocker.""",
    tools=[save_pitch, save_judged_pitches, get_pipeline_state],
    output_key="pitch_judgments",
)

# ─── 4. Call Manager Agent ──────────────────────────────────────────────────
call_manager = Agent(
    name="call_manager",
    model="gemini-2.5-flash",
    description="Creates personalized ElevenLabs voice agents with dynamic variables and manages outbound calls.",
    instruction="""You manage outbound sales calls using ElevenLabs voice agents with per-lead personalization.

When asked to set up/create voice agents:
1. Use get_voice_agent_config to get the saved voice configuration AND ready leads.
2. Use get_pipeline_state to review current pipeline data.
3. Extract from voice config: caller_name, call_style, objective, closing_cta, pricing_override, language.
4. For each ready lead, create an ElevenLabs agent with create_elevenlabs_agent:
   - agent_name: "SDR for [Lead Name]"
   - first_message: Use {{contact_person}} variable — write the greeting IN THE DETECTED LANGUAGE.
     Include the caller_name from voice config.
   - system_prompt: Include the full pitch with {{variables}} for personalization.
     Incorporate the call_style, objective, and closing_cta from voice config.
     If pricing_override was provided, use that instead of website pricing.
     Write ALL instructions in the DETECTED LANGUAGE.
   - Pass ALL personalization fields: lead_name, lead_company, lead_industry,
     contact_person, your_company, your_services, pitch_script, call_objective, language
   - Set language parameter to the detected language_code (e.g. "ro", "en", "de")

5. Report back what agents were created with their dynamic variables.

When asked to make a call:
1. Confirm the phone number and agent_id.
2. Use make_outbound_call with the agent_id, phone number, and any additional dynamic_variables_json.

When asked about results:
1. Use get_call_status to check outcomes, transcripts, and analysis.
2. Present results clearly: lead name, call duration, objective met, interest level, key data extracted.""",
    tools=[
        create_elevenlabs_agent,
        make_outbound_call,
        get_call_status,
        get_pipeline_state,
        get_voice_agent_config,
    ],
)

# ─── 5. Preferences Agent ───────────────────────────────────────────────────
preferences_agent = Agent(
    name="preferences_agent",
    model="gemini-2.5-flash",
    description="Configures user preferences: pricing, calendar, call style, language, and campaign settings.",
    instruction="""You are a configuration assistant. You help the user set up their SDR campaign preferences.

Ask about and configure:
- **Pricing info**: What do their services cost? Any packages or tiers?
- **Calendar link**: Where should leads book meetings?
- **Call style**: Formal or casual? Aggressive or consultative?
- **Language**: What language should calls be in? (auto-detected, can be overridden)
- **Business hours**: When is it okay to call leads?
- **Objective**: What's the goal? (book demo, qualify lead, schedule visit)

Use save_preferences to store each preference as the user provides it.
Use get_preferences to show current settings.
Be conversational and helpful.""",
    tools=[save_preferences, get_preferences, get_pipeline_state],
)

# ─── 6. Voice Config Agent ─────────────────────────────────────────────────
voice_config_agent = Agent(
    name="voice_config_agent",
    model="gemini-2.5-flash",
    description="Assesses readiness for voice calls, gathers missing info from the user, and configures ElevenLabs voice agents.",
    instruction="""You are a voice campaign configuration specialist. Your job is to make sure we have
EVERYTHING needed to create effective ElevenLabs voice agents before any calls are made.

**STEP 1 — ASSESS READINESS:**
Start by calling assess_voice_readiness to get a complete checklist.

**STEP 2 — GATHER MISSING INFO:**
Based on the readiness report, ask the user about (one or two at a time):
- Caller name, pricing (if missing), call objective, call style, opening approach,
  closing CTA, availability/booking rules, business hours, additional context

**STEP 3 — REVIEW & CONFIRM:**
Once you have all info, use configure_voice_agent to save. Present a summary to the user.

**STEP 4 — CREATE AGENTS (if confirmed):**
If the user confirms, create ElevenLabs agents for each ready lead using create_elevenlabs_agent.
Write all agent content IN THE DETECTED LANGUAGE.

IMPORTANT RULES:
- NEVER create agents without first gathering caller_name and objective
- If pricing was not found on the website, you MUST ask
- If the user asks to create agents or call, DO IT — don't redirect to another agent
- NEVER tell the user to go back to another agent""",
    tools=[
        assess_voice_readiness,
        configure_voice_agent,
        get_voice_agent_config,
        get_pipeline_state,
        save_preferences,
        get_preferences,
        create_elevenlabs_agent,
        make_outbound_call,
        get_call_status,
        send_email,
    ],
)

# ─── 7. Voice Config Live Agent (real-time audio via Live API) ────────────
voice_config_live_agent = Agent(
    name="voice_config_live",
    model="gemini-2.5-flash-native-audio-preview-12-2025",
    description="Live audio version of voice config agent for real-time voice conversation.",
    instruction="""You are a voice campaign configuration specialist having a LIVE VOICE CONVERSATION.
You are helping the user set up their ElevenLabs voice agents for outbound sales calls.

Start by calling assess_voice_readiness and get_voice_agent_config to understand what data we have.

Then have a natural voice conversation to gather missing information:
- Caller name, prices/packages, call goal, agent tone, availability, closing CTA

Ask ONE question at a time. Keep responses SHORT — this is voice, not email.

Once complete, use configure_voice_agent to save. Confirm with the user.""",
    tools=[
        assess_voice_readiness,
        configure_voice_agent,
        get_voice_agent_config,
        get_pipeline_state,
        save_preferences,
    ],
)

# ─── Main Pipeline (Sequential) ─────────────────────────────────────────────
# Reduced from 5 agents to 3:
# - Lead scoring moved into lead_finder (deterministic function, no LLM needed)
# - Pitch judging merged into pitch_generator (self-review with feedback loop)
analysis_pipeline = SequentialAgent(
    name="analysis_pipeline",
    description="Full SDR pipeline: crawl website → find & score leads → generate & review pitches + emails. Language flows automatically from step 1.",
    sub_agents=[website_analyzer, lead_finder, pitch_generator],
)

# ─── Root Orchestrator ───────────────────────────────────────────────────────
root_agent = Agent(
    name="leadcall_orchestrator",
    model="gemini-2.5-flash",
    description="Main orchestrator for LeadCall AI SDR platform.",
    instruction="""You are LeadCall AI, an intelligent SDR (Sales Development Representative) platform.

You help users:
1. **Analyze a business website** — crawl, detect language & country, understand services/pricing/ICP
2. **Find & score leads** — discover clients via Google Maps + Brave Search, auto-score by fit
3. **Generate pitches** — personalized call scripts + email drafts in detected language, self-reviewed
4. **Configure voice agents** — assess readiness, gather info, configure ElevenLabs settings
5. **Make calls** — create voice agents and initiate outbound calls

ROUTING RULES:
- URL or "analyze a website" → transfer to analysis_pipeline (runs full pipeline)
- "preferences", "pricing", "calendar" → transfer to preferences_agent
- Voice/call setup, readiness, "create agents", "make calls", "call them" → transfer to voice_config_agent
- General status questions → answer directly using get_pipeline_state

IMPORTANT:
- voice_config_agent handles everything voice-related (config + create + call)
- NEVER tell the user to "ask another agent"
- Be concise and action-oriented""",
    sub_agents=[analysis_pipeline, voice_config_agent, preferences_agent, call_manager],
    tools=[get_pipeline_state],
)
