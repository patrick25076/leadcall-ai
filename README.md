<div align="center">

# GRAI

### The Voice of Your Business

**AI-powered outreach that finds your ideal customers, crafts personalized pitches, and reaches out via voice calls and email — all from a single URL.**

[Live Demo](https://leadcall-ai.onrender.com/) &nbsp;&middot;&nbsp; Built for the EU &nbsp;&middot;&nbsp; GDPR-native

---

<br/>

```
  paste your website URL  -->  AI analyzes your business
                                      |
                           discovers ideal leads
                                      |
                      generates personalized pitches
                                      |
                    reaches out via AI voice calls + email
```

<br/>

</div>

## How It Works

GRAI runs a **3-agent AI pipeline** that turns a website URL into qualified leads with ready-to-send outreach:

| Step | Agent | What It Does |
|------|-------|-------------|
| **1** | **Website Analyzer** | Crawls your site, detects language, country, business model (B2B/B2C/online), and extracts key selling points |
| **2** | **Lead Finder** | Searches Google Maps + Brave across multiple industries, scores and ranks 15-20 qualified prospects |
| **3** | **Pitch Generator** | Writes personalized call scripts + email drafts for each lead, self-reviews quality, and rewrites anything below a 7/10 |

Once the pipeline completes, you review the leads, approve outreach, and GRAI handles the rest — AI voice calls powered by ElevenLabs, emails sent from your own Gmail account.

## Features

- **One-URL onboarding** — Paste your website, GRAI figures out the rest
- **Intelligent lead discovery** — Google Maps + Brave Search, scored and ranked
- **AI voice calls** — Natural-sounding outbound calls via ElevenLabs
- **Personalized pitches** — Every call script and email tailored to the prospect
- **Caller ID verification** — Calls show your real business number (Twilio Verified Caller ID)
- **Gmail integration** — Outreach emails sent from your own account
- **Real-time activity feed** — Watch agents work with live SSE streaming
- **Campaign management** — Multiple campaigns, each with their own leads and outreach
- **Call transcripts & analytics** — Full results dashboard with outcomes and recordings
- **GDPR compliance** — Consent tracking, 90-day data expiry, right-to-erasure endpoints

## Architecture

```
Next.js 15 + React 19 + Tailwind CSS 4
              |
         Supabase Auth (JWT)
              |
    FastAPI Backend (Python 3.11+)
         /        \
  Google ADK       External APIs
  (Gemini 2.5      |-- Google Maps Places
   Flash)          |-- Brave Search
                   |-- Firecrawl
                   |-- ElevenLabs (Voice AI)
                   |-- Twilio (Calling + Caller ID)
                   |-- Gmail OAuth
                   |
              PostgreSQL (Supabase)
```

### Frontend

| | |
|---|---|
| **Framework** | Next.js 15, React 19, TypeScript (strict) |
| **Styling** | Tailwind CSS 4 — dark theme, emerald accents |
| **Auth** | Supabase (Google OAuth + email/password) |
| **Analytics** | PostHog (EU cloud) — session replay, funnels, retention |
| **Errors** | Sentry — source maps, auto-capture |

### Backend

| | |
|---|---|
| **Framework** | FastAPI with async throughout |
| **AI** | Google ADK agents, Gemini 2.5 Flash |
| **Streaming** | Server-Sent Events (SSE) for real-time agent output |
| **Database** | SQLite (dev) / PostgreSQL via Supabase (prod) |
| **Observability** | Orq.ai — full execution traces, cost tracking per run |
| **Security** | SSRF prevention, phone validation, rate limiting, CORS lockdown |

## Project Structure

```
frontend/
  app/
    page.tsx                  # Entry point — auth routing
    admin/page.tsx            # Admin dashboard
  components/
    OnboardingWizard.tsx      # 4-step signup flow
    Dashboard.tsx             # Main app (tabs: Activity, Leads, Outreach, Results, Logs)
    CampaignList.tsx          # Campaign manager
    LeadTable.tsx             # Sortable/filterable lead grid
    OutreachPanel.tsx         # Test calls & emails, approve outreach
    ResultsDashboard.tsx      # Call outcomes, transcripts, analytics
    ActivityFeed.tsx          # Real-time agent progress
  lib/
    supabase.ts               # Supabase client (lazy-init, SSR-safe)
    api.ts                    # Authenticated fetch wrapper
    analytics.ts              # PostHog event tracking

backend/
  server.py                   # FastAPI app — SSE streaming, WebSocket, all endpoints
  agents/
    agent.py                  # Agent definitions & pipeline composition
    tools.py                  # All tool implementations with Orq tracing
  db.py                       # Database layer with GDPR compliance
  auth.py                     # Supabase JWT middleware
  security.py                 # SSRF prevention, phone validation, rate limiting
  gmail_oauth.py              # Gmail OAuth for sending from user's account
  phone_setup.py              # Twilio Verified Caller ID
  verification.py             # Domain ownership verification
  observability.py            # Request timing, cost tracking per pipeline run
```

## Getting Started

### Prerequisites

- **Node.js 18+** and **Python 3.11+**
- A [Supabase](https://supabase.com) project (free tier works)
- API keys for: Google Gemini, Google Maps, Brave Search

### 1. Clone & install

```bash
git clone https://github.com/your-org/leadcall-ai.git
cd leadcall-ai

# Frontend
cd frontend && npm install

# Backend
cd ../backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configure environment

```bash
# Backend — copy and fill in your keys
cp backend/.env.example backend/.env
```

Frontend env vars (set in `.env.local` or Vercel):

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_API_URL=http://localhost:8000
```

### 3. Run

```bash
# Terminal 1 — Backend
cd backend && source .venv/bin/activate
uvicorn server:app --reload --port 8000

# Terminal 2 — Frontend
cd frontend && npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## External Services

| Service | Purpose | Required |
|---------|---------|----------|
| **Google Gemini 2.5 Flash** | LLM for all agents | Yes |
| **Google Maps Places API** | Local business discovery | Yes |
| **Brave Search API** | Web search for leads | Yes |
| **Supabase** | Auth + PostgreSQL database | Yes |
| **Firecrawl** | Multi-page website crawling | Optional (falls back to BS4) |
| **ElevenLabs** | Voice AI agents for phone calls | For voice calls |
| **Twilio** | Outbound calling + Caller ID verification | For voice calls |
| **Gmail OAuth** | Send outreach from user's own email | For email outreach |
| **Orq.ai** | Agent tracing & monitoring | Recommended |
| **PostHog** | User analytics (EU cloud) | Recommended |
| **Sentry** | Error tracking | Recommended |
| **Resend** | Platform emails (welcome, notifications) | Optional |

## Verification

```bash
# Backend tests
cd backend && python -m pytest tests/ -v --tb=short

# TypeScript check (must pass with zero errors)
cd frontend && npx tsc --noEmit

# Production build
cd frontend && npm run build
```

## Deployment

- **Frontend** — Vercel (auto-deploys from `main`)
- **Backend** — Render (auto-deploys from `main`)
- **Database** — Supabase (managed PostgreSQL)

Both services deploy automatically on push to `main`. No feature branches — ship directly.

## Security & Compliance

- All URLs validated via SSRF prevention before any HTTP request
- All phone numbers validated before Twilio calls
- Rate limiting on all API endpoints
- CORS locked to known origins
- Supabase JWT required in production
- No API keys in responses, logs, or error messages
- **GDPR**: Consent tracking, 90-day data expiry, right-to-erasure endpoints, consent audit log
- AI nature disclosed on all outbound calls where legally required

## License

Proprietary. All rights reserved.

---

<div align="center">
<br/>

**GRAI** — Enterprise-grade AI outreach. EU-first. GDPR-native.

<br/>
</div>
