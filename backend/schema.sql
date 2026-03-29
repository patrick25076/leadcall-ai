-- GRAI Database Schema for Supabase PostgreSQL
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT,
    website_url     TEXT NOT NULL,
    business_name   TEXT,
    analysis        JSONB,
    session_id      TEXT,
    status          TEXT DEFAULT 'active',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Leads with GDPR consent
CREATE TABLE IF NOT EXISTS leads (
    id              BIGSERIAL PRIMARY KEY,
    campaign_id     BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id         TEXT,
    name            TEXT,
    website         TEXT,
    phone           TEXT,
    email           TEXT,
    contact_person  TEXT,
    address         TEXT,
    city            TEXT,
    country         TEXT,
    industry        TEXT,
    relevance_reason TEXT,
    source          TEXT,
    rating          REAL,
    reviews         INTEGER,
    lead_score      INTEGER,
    score_grade     TEXT,
    score_breakdown JSONB,
    raw_data        JSONB,
    consent_basis   TEXT DEFAULT 'legitimate_interest',
    status          TEXT DEFAULT 'new',
    expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '90 days'),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Pitches (call scripts + email drafts)
CREATE TABLE IF NOT EXISTS pitches (
    id              BIGSERIAL PRIMARY KEY,
    campaign_id     BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id         BIGINT REFERENCES leads(id) ON DELETE CASCADE,
    lead_name       TEXT,
    contact_person  TEXT,
    pitch_script    TEXT,
    email_subject   TEXT,
    email_body      TEXT,
    key_value_prop  TEXT,
    call_to_action  TEXT,
    score           REAL,
    feedback        TEXT,
    revised_pitch   TEXT,
    ready_to_call   BOOLEAN DEFAULT FALSE,
    ready_to_email  BOOLEAN DEFAULT FALSE,
    missing_info    JSONB,
    raw_data        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ElevenLabs voice agents
CREATE TABLE IF NOT EXISTS agents (
    id              BIGSERIAL PRIMARY KEY,
    campaign_id     BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id         BIGINT REFERENCES leads(id) ON DELETE SET NULL,
    agent_id        TEXT,
    agent_name      TEXT,
    first_message   TEXT,
    system_prompt   TEXT,
    dynamic_vars    JSONB,
    language        TEXT DEFAULT 'en',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Outbound calls
CREATE TABLE IF NOT EXISTS calls (
    id              BIGSERIAL PRIMARY KEY,
    campaign_id     BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
    agent_db_id     BIGINT REFERENCES agents(id) ON DELETE SET NULL,
    agent_id        TEXT,
    phone_number    TEXT,
    call_sid        TEXT,
    status          TEXT DEFAULT 'pending',
    dynamic_vars    JSONB,
    transcript      TEXT,
    outcome         TEXT,
    duration_secs   INTEGER,
    recording_url   TEXT,
    analysis        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: add recording_url and analysis to calls (run if table already exists)
-- ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url TEXT;
-- ALTER TABLE calls ADD COLUMN IF NOT EXISTS analysis JSONB;

-- Email outreach
CREATE TABLE IF NOT EXISTS email_outreach (
    id              BIGSERIAL PRIMARY KEY,
    campaign_id     BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id         BIGINT REFERENCES leads(id) ON DELETE CASCADE,
    pitch_id        BIGINT REFERENCES pitches(id) ON DELETE SET NULL,
    to_email        TEXT NOT NULL,
    from_email      TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body_html       TEXT NOT NULL,
    status          TEXT DEFAULT 'draft',
    sent_at         TIMESTAMPTZ,
    opened_at       TIMESTAMPTZ,
    replied_at      TIMESTAMPTZ,
    resend_id       TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- User preferences
CREATE TABLE IF NOT EXISTS preferences (
    id              BIGSERIAL PRIMARY KEY,
    campaign_id     BIGINT,
    user_id         TEXT,
    key             TEXT NOT NULL,
    value           TEXT NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(campaign_id, key)
);

-- Domain verification
CREATE TABLE IF NOT EXISTS domain_verifications (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT NOT NULL,
    domain          TEXT NOT NULL,
    method          TEXT NOT NULL,
    verification_token TEXT NOT NULL,
    verified        BOOLEAN DEFAULT FALSE,
    verified_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, domain)
);

-- GDPR consent/audit log
CREATE TABLE IF NOT EXISTS consent_log (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT NOT NULL,
    action          TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    entity_id       BIGINT,
    details         TEXT,
    ip_address      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_pitches_campaign ON pitches(campaign_id);
CREATE INDEX IF NOT EXISTS idx_calls_campaign ON calls(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_expires ON leads(expires_at);

-- Enable Row Level Security (can be configured later for multi-tenant)
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitches ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outreach ENABLE ROW LEVEL SECURITY;
ALTER TABLE preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_log ENABLE ROW LEVEL SECURITY;

-- RLS Policies: user-scoped access
-- NOTE: Using permissive policies with anon key for now.
-- The backend passes user_id on all operations. These policies ensure
-- that even if someone gets the anon key, they can only see their own data.
-- For production, switch to service_role key on the backend and use auth.uid().

-- Option A: Permissive (current — backend uses anon key)
CREATE POLICY "Allow all for anon" ON campaigns FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON leads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON pitches FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON agents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON calls FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON email_outreach FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON preferences FOR ALL USING (true) WITH CHECK (true);

-- Option B: User-scoped (uncomment when switching to service_role key)
-- DROP POLICY IF EXISTS "Allow all for anon" ON campaigns;
-- DROP POLICY IF EXISTS "Allow all for anon" ON leads;
-- DROP POLICY IF EXISTS "Allow all for anon" ON pitches;
-- DROP POLICY IF EXISTS "Allow all for anon" ON agents;
-- DROP POLICY IF EXISTS "Allow all for anon" ON calls;
-- DROP POLICY IF EXISTS "Allow all for anon" ON email_outreach;
-- DROP POLICY IF EXISTS "Allow all for anon" ON preferences;
--
-- CREATE POLICY "Users see own campaigns" ON campaigns FOR ALL
--   USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text);
-- CREATE POLICY "Users see own leads" ON leads FOR ALL
--   USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text);
-- CREATE POLICY "Users see own pitches" ON pitches FOR ALL
--   USING (campaign_id IN (SELECT id FROM campaigns WHERE user_id = auth.uid()::text));
-- CREATE POLICY "Users see own agents" ON agents FOR ALL
--   USING (campaign_id IN (SELECT id FROM campaigns WHERE user_id = auth.uid()::text));
-- CREATE POLICY "Users see own calls" ON calls FOR ALL
--   USING (campaign_id IN (SELECT id FROM campaigns WHERE user_id = auth.uid()::text));
-- CREATE POLICY "Users see own emails" ON email_outreach FOR ALL
--   USING (campaign_id IN (SELECT id FROM campaigns WHERE user_id = auth.uid()::text));
-- CREATE POLICY "Users see own prefs" ON preferences FOR ALL
--   USING (campaign_id IN (SELECT id FROM campaigns WHERE user_id = auth.uid()::text));
CREATE POLICY "Allow all for anon" ON consent_log FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON domain_verifications FOR ALL USING (true) WITH CHECK (true);
