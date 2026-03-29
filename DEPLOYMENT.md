# GRAI Deployment Guide

## Frontend: Vercel (grai.run)

### Setup
1. Push repo to GitHub
2. Import project in Vercel → select `frontend/` as root directory
3. Add domain `grai.run` in Vercel project settings
4. Set environment variables in Vercel:

```
NEXT_PUBLIC_API_URL=https://leadcall-backend.onrender.com
NEXT_PUBLIC_SUPABASE_URL=https://cgicbhfgqnkpvyzishru.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-supabase-anon-key>
NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_jPzzjthLlaUKpZtneLLiANT3vrhIdrlSywXYyAUinsF
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
SENTRY_AUTH_TOKEN=<your-sentry-auth-token>
```

### After Deploy
- Verify: `https://grai.run/health` (should proxy to backend)
- Verify: `https://grai.run/admin` (admin dashboard loads)

## Backend: Render (leadcall-backend.onrender.com)

### Setup
1. Create Web Service in Render
2. Connect to GitHub repo
3. Root directory: `backend/`
4. Build command: `pip install -r requirements.txt`
5. Start command: `uvicorn server:app --host 0.0.0.0 --port $PORT`
6. Set environment variables:

```
# Core AI
GOOGLE_API_KEY=<key>
GOOGLE_GENAI_USE_VERTEXAI=false

# Lead Discovery
GOOGLE_MAPS_API_KEY=<key>
BRAVE_API_KEY=<key>
FIRECRAWL_API_KEY=<key>

# Voice & Calling
ELEVENLABS_API_KEY=<key>
TWILIO_ACCOUNT_SID=<sid>
TWILIO_AUTH_TOKEN=<token>
TWILIO_PHONE_NUMBER=<number>

# Email
RESEND_API_KEY=<key>
GOOGLE_OAUTH_CLIENT_ID=<id>
GOOGLE_OAUTH_CLIENT_SECRET=<secret>
GOOGLE_OAUTH_REDIRECT_URI=https://cgicbhfgqnkpvyzishru.supabase.co/auth/v1/callback

# Database & Auth
SUPABASE_URL=https://cgicbhfgqnkpvyzishru.supabase.co
SUPABASE_ANON_KEY=<key>

# Observability
ORQ_API_KEY=<key>

# Infrastructure
WEBHOOK_BASE_URL=https://leadcall-backend.onrender.com
ALLOWED_ORIGINS=https://grai.run,https://www.grai.run,http://localhost:3000
REQUIRE_AUTH=true
```

## Post-Deploy Checklist

- [ ] Backend /health returns 200
- [ ] Frontend loads at grai.run
- [ ] Google OAuth login works
- [ ] Supabase redirect URL includes grai.run
- [ ] Pipeline analysis works end-to-end
- [ ] Admin dashboard loads at /admin
- [ ] PostHog receiving events
- [ ] Sentry receiving errors
- [ ] Orq.ai traces visible

## Services to Update After Deploy

### Supabase
- Add `https://grai.run` to Auth > URL Configuration > Redirect URLs
- Add `https://grai.run` to Auth > URL Configuration > Site URL

### Google Cloud Console
- Add `https://grai.run/auth/callback` to OAuth redirect URIs
- Add `https://grai.run` to authorized JavaScript origins

### Twilio
- Update WEBHOOK_BASE_URL if using a new backend URL
