# GRAI — The Voice of Your Business

## Workflow

- **Always work on `main` branch.** No feature branches.
- **Always push after completing work.** `git add` + `git commit` + `git push origin main`.
- Vercel (frontend) and Render (backend) auto-deploy from main.

## Site Password Gate

The frontend has a password gate via Next.js middleware (`frontend/middleware.ts`).
- Set `SITE_PASSWORD` env var on Vercel to enable (any string).
- If `SITE_PASSWORD` is not set, the gate is disabled (open access).
- Password is checked via `/api/unlock` route and stored in an httpOnly cookie (30 days).
- This is a dev-phase lock — remove when launching publicly.

## Brand Identity

**GRAI** is an AI-powered outreach platform that finds ideal customers, crafts personalized pitches, and reaches out via AI voice calls and email — all from a single URL input.

- **Feel**: Luxury, exclusive, enterprise-grade. Think Rolls-Royce of AI sales outreach.
- **Tone**: Professional, confident, precise. Never startup-y, never casual.
- **Design**: Dark theme, subtle emerald accents, generous whitespace, premium typography.
- **Target**: Sales managers, founders, agency owners. Non-technical users.
- **Market**: EU-first, GDPR-native. Enterprise validated (JET CTO interest).

## Architecture

```
Frontend (Next.js 15 + React 19 + Tailwind)
    ↓ Supabase Auth (JWT)
FastAPI Backend (Python 3.11+)
    ↓ Google ADK (Gemini 2.5 Flash)
    ↓ Multi-agent pipeline
    ↓ External APIs (Maps, Brave, ElevenLabs, Twilio)
    ↓ SQLite (dev) → PostgreSQL/Supabase (prod)
```

### Backend: `backend/`
- `server.py` — FastAPI app, SSE streaming, WebSocket voice, all endpoints
- `agents/agent.py` — Agent definitions, pipeline composition (3-agent pipeline)
- `agents/tools.py` — All tool implementations with Orq tracing
- `db.py` — Database layer with GDPR compliance (erasure, consent, expiry)
- `security.py` — SSRF prevention, phone validation, rate limiting
- `auth.py` — Supabase Auth middleware
- `gmail_oauth.py` — Gmail OAuth for sending from user's own account
- `phone_setup.py` — Twilio Verified Caller ID
- `verification.py` — Domain ownership verification

### Frontend: `frontend/`
- `app/page.tsx` — Entry point: auth check → onboarding OR dashboard
- `components/OnboardingWizard.tsx` — 4-step signup flow
- `components/Dashboard.tsx` — Main app with tabs (Activity, Leads, Outreach, Results, Logs)
- `components/ActivityFeed.tsx` — User-friendly real-time progress
- `components/LeadTable.tsx` — Sortable/filterable lead manager
- `components/OutreachPanel.tsx` — Test calls/emails, approve outreach
- `components/ResultsDashboard.tsx` — Call outcomes, transcripts, analytics
- `lib/supabase.ts` — Supabase client

### Pipeline (3 agents, sequential)
1. **WebsiteAnalyzer** — Crawl, detect language/country/business model (B2B/B2C/online)
2. **LeadFinder** — Search Google Maps + Brave, score leads
3. **PitchGenerator** — Write call scripts + email drafts, self-review, feedback loop

### External Services
| Service | Purpose |
|---------|---------|
| Google Gemini 2.5 Flash | LLM for all agents |
| Google Maps Places API | Local business discovery |
| Brave Search API | Web search for leads |
| Firecrawl | Website crawling |
| ElevenLabs | Voice AI agents |
| Twilio | Outbound calling + Caller ID |
| Supabase | Auth + Database |
| Resend | Platform emails (not outreach) |
| Orq AI | Tracing & monitoring |

## Coding Standards

### General
- **No hardcoded locations, countries, or business assumptions.** Agents must detect or ask.
- **No `any` types in TypeScript.** Use proper types or `Record<string, unknown>`.
- **No bare `except:` in Python.** Always catch specific exceptions.
- **No `print()` in Python.** Use `logging.getLogger(__name__)`.
- **No internal errors exposed to users.** Generic messages only.
- **All user-facing text must be professional.** No "oops", no "something went wrong", no placeholder text.

### Python (Backend)
- Type hints on all functions
- Async where possible (FastAPI is async)
- `@traced` decorator on all tool functions (Orq)
- Structured logging with `logger.info/warning/error`
- All database operations through `db.py` (never raw SQL in tools)

### TypeScript (Frontend)
- Strict mode enforced
- `String()` for rendering `unknown` values in JSX (not `as string`)
- `? ... : null` ternary pattern for conditional JSX (not `&&` with unknown)
- Fragment with key for list items with multiple elements
- All API calls through a consistent pattern (fetch with error handling)

### Security (MANDATORY)
- ALL URLs validated via `security.is_safe_url()` before HTTP requests
- ALL phone numbers validated via `security.validate_phone_number()` before calls
- ALL API endpoints rate-limited via middleware
- CORS locked to known origins (ALLOWED_ORIGINS env var)
- No API keys in responses, logs, or error messages
- Supabase JWT required in production (REQUIRE_AUTH=true)

### EU/GDPR Compliance
- All leads have `consent_basis` field
- Lead data expires after 90 days
- Right-to-erasure endpoints: DELETE /api/leads/:id, DELETE /api/campaigns/:id
- Consent audit log on all data operations
- All outbound calls must disclose AI nature where legally required

### Agent Design Rules
- **Never hardcode locations.** If business is online, detect or ask user.
- **Detect B2B vs B2C.** Adjust lead-finding strategy accordingly.
- **B2C products → find B2B partnerships**, not individual consumers.
- **Online businesses → search multiple markets**, don't default to any country.
- **Agents read shared state via `get_pipeline_state()`**, not context variables.
- **All agent instructions are generic** — no industry/location-specific examples hardcoded.

## What NOT To Do
- Do NOT hardcode Romania, US, or any country as a default
- Do NOT use `allow_origins=["*"]` in CORS
- Do NOT expose raw exceptions to API clients
- Do NOT use SQLite `check_same_thread=False`
- Do NOT skip phone validation before Twilio calls
- Do NOT log phone numbers, emails, or PII
- Do NOT use ADK context variables (`output_key`) for passing data between agents — they're unreliable. Use `get_pipeline_state()` tool instead.
- Do NOT add placeholder or "coming soon" text in user-facing UI
- Do NOT use casual/startup language in UI copy

## Verification Commands

```bash
# Run ALL backend tests (52 tests: security, tools, API)
cd backend && python -m pytest tests/ -v --tb=short

# TypeScript check (must pass with zero errors)
cd frontend && npx tsc --noEmit

# Build frontend (catches runtime issues)
cd frontend && npm run build

# Single test file
cd backend && python -m pytest tests/test_security.py -v

# Python syntax check
python -c "import ast; ast.parse(open('backend/server.py', encoding='utf-8').read())"
```

## Development

```bash
# Backend
cd backend && source .venv/bin/activate  # or .venv\Scripts\activate on Windows
uvicorn server:app --reload --port 8000

# Frontend
cd frontend && npm run dev
```

## Common Gotchas

- ADK `output_key` context variables are unreliable — ALWAYS use `get_pipeline_state()` tool
- Supabase JWT tokens expire after 1 hour in dev
- ElevenLabs API has 100 req/min rate limit
- Twilio Verified Caller ID requires manual phone verification before first call
- SQLite `check_same_thread` must NEVER be used — each thread gets its own connection
- Orq requires `ORQ_API_KEY` env var at import time — set before imports in tests
- `judged_pitches` and `pitches` are separate arrays — Dashboard merges them for display
- Always `String()` when rendering `unknown` values in TSX (not `as string`)

## Observability Stack

### Agent Observability (Orq.ai)
- **Every tool function** has `@traced` decorator — captures inputs, outputs, latency, tokens
- Orq dashboard shows full execution trees per pipeline run
- Cost tracking per run via `observability.py` middleware
- Prompt versioning: use Orq Deployments to version and A/B test prompts
- Datasets: store golden test cases in Orq for regression testing
- **Always add `@traced` to new tool functions**

### User Analytics (PostHog — EU cloud)
- Session replay, heatmaps, funnels, retention cohorts
- Custom events tracked via `lib/analytics.ts`
- **When adding user-facing features, ALWAYS add analytics events:**
  - `analytics.trackEvent("feature_name_action", { relevant_properties })`
  - Track: started, completed, errored, abandoned
- Key funnels to monitor: onboarding completion, first analysis, first outreach

### Error Tracking (Sentry)
- Auto-captures unhandled errors, API failures, slow endpoints
- Source maps for readable stack traces
- **When catching errors, ALWAYS report to Sentry** (not just logger)

### Backend Cost Tracking (`observability.py`)
- `RequestTimingMiddleware` logs slow requests (> 5s)
- `PipelineRunTracker` estimates cost per run (LLM tokens + API calls)
- `X-Request-Duration` header on all responses

## Admin Dashboard Requirements

**IMPORTANT**: Build a secure admin dashboard (`/admin`) that is ONLY accessible to verified admin users.

The admin dashboard must show:
- **Pipeline Analytics**: Runs per day, success/failure rate, avg duration, avg cost
- **User Analytics**: Active users, new signups, retention by cohort, churn
- **Agent Performance**: Per-agent success rate, avg tokens used, avg latency
- **Cost Dashboard**: Total spend (LLM + APIs), cost per user, cost per pipeline run
- **Feature Usage**: Which tabs are used most, which features are popular
- **Error Log**: Recent errors from Sentry, grouped by type
- **Flow Breakpoints**: Where users drop off (from PostHog funnels)
- **Lead Quality**: Avg score, grade distribution, conversion to outreach
- **Outreach Results**: Calls made, emails sent, meetings booked, response rate

When building ANY new feature:
1. Add Orq tracing to backend tools
2. Add PostHog events to frontend actions
3. Add the metric to the admin dashboard
4. Add error handling that reports to Sentry

## Kilo.ai Integration (Optional)

Patrick has 6-month KiloClaw + $100 Kilo Gateway credits.
- **Kilo Gateway**: Universal AI model proxy (500+ models, OpenAI-compatible API). Could be used as a fallback LLM provider or for model comparison.
- **KiloClaw**: Hosted AI agent (OpenClaw) for chat platforms. Could be used for a Telegram/Discord bot for GRAI.
- These are separate from Orq.ai — different companies, different purposes.

## Brand Colors (for design reference)
- Background: `#0a0a0f` (near-black)
- Surface: `#0d0d14` (dark panels)
- Border: `zinc-800`
- Primary: `emerald-500` / `emerald-400`
- Text: `white` (headings), `zinc-300` (body), `zinc-500` (secondary)
- Accent: `emerald-500/10` (highlights), `emerald-500/20` (hover)
- Error: `red-400`
- Warning: `amber-400`
