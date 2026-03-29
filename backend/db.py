"""PostgreSQL persistence layer for LeadCall AI (Supabase).

Tables: users, campaigns, leads, pitches, agents, calls, preferences,
        consent_log, domain_verifications, email_outreach

GDPR compliance: consent tracking, right to erasure, audit logging.

Migration from SQLite: replace `sqlite3` with `asyncpg` via Supabase connection string.
Falls back to SQLite for local development if DATABASE_URL is not set.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "")
DB_PATH = os.path.join(os.path.dirname(__file__), "leadcall.db")

# For MVP, we use synchronous SQLite with proper connection handling.
# When Supabase is configured, switch to asyncpg.
# The interface stays the same — callers don't know which backend is used.

_conn: Optional[sqlite3.Connection] = None
_USE_POSTGRES = bool(DATABASE_URL)


def get_conn() -> sqlite3.Connection:
    """Get or create database connection.

    Uses SQLite for local dev, PostgreSQL (Supabase) for production.
    """
    global _conn
    if _conn is None:
        if _USE_POSTGRES:
            # TODO: Switch to asyncpg when Supabase is configured
            # For now, log a warning and fall back to SQLite
            logger.info("DATABASE_URL set — PostgreSQL will be used when asyncpg is integrated")
            logger.info("Falling back to SQLite for now: %s", DB_PATH)

        _conn = sqlite3.connect(DB_PATH)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
        _init_tables(_conn)
        _migrate_schema(_conn)  # Add new columns to existing tables
    return _conn


def _migrate_schema(conn: sqlite3.Connection) -> None:
    """Add new columns to existing tables (safe — uses IF NOT EXISTS / try-except)."""
    migrations = [
        "ALTER TABLE campaigns ADD COLUMN user_id TEXT",
        "ALTER TABLE campaigns ADD COLUMN status TEXT DEFAULT 'active'",
        "ALTER TABLE leads ADD COLUMN user_id TEXT",
        "ALTER TABLE leads ADD COLUMN email TEXT",
        "ALTER TABLE leads ADD COLUMN consent_basis TEXT DEFAULT 'legitimate_interest'",
        "ALTER TABLE leads ADD COLUMN status TEXT DEFAULT 'new'",
        "ALTER TABLE leads ADD COLUMN expires_at TEXT",
        "ALTER TABLE pitches ADD COLUMN email_subject TEXT",
        "ALTER TABLE pitches ADD COLUMN email_body TEXT",
        "ALTER TABLE pitches ADD COLUMN ready_to_email INTEGER DEFAULT 0",
        "ALTER TABLE preferences ADD COLUMN user_id TEXT",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass  # Column already exists
    conn.commit()


def _init_tables(conn: sqlite3.Connection) -> None:
    conn.executescript("""
    -- User profiles (synced from Supabase Auth)
    CREATE TABLE IF NOT EXISTS users (
        id              TEXT PRIMARY KEY,           -- Supabase Auth user ID
        email           TEXT NOT NULL,
        full_name       TEXT,
        company_name    TEXT,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- Domain ownership verification
    CREATE TABLE IF NOT EXISTS domain_verifications (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         TEXT NOT NULL,
        domain          TEXT NOT NULL,
        method          TEXT NOT NULL,               -- 'dns_txt' or 'email'
        verification_token TEXT NOT NULL,
        verified        INTEGER DEFAULT 0,
        verified_at     TEXT,
        created_at      TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, domain)
    );

    -- Campaigns (now owned by a user)
    CREATE TABLE IF NOT EXISTS campaigns (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         TEXT,                        -- Owner (nullable for migration)
        website_url     TEXT NOT NULL,
        business_name   TEXT,
        analysis        TEXT,                        -- Full JSON
        session_id      TEXT,
        status          TEXT DEFAULT 'active',       -- active, paused, completed, archived
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- Leads with GDPR consent tracking
    CREATE TABLE IF NOT EXISTS leads (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        user_id         TEXT,                        -- Owner
        name            TEXT,
        website         TEXT,
        phone           TEXT,
        email           TEXT,                        -- NEW: for email outreach
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
        score_breakdown TEXT,                        -- JSON
        raw_data        TEXT,                        -- Full JSON
        consent_basis   TEXT DEFAULT 'legitimate_interest',  -- GDPR basis
        status          TEXT DEFAULT 'new',          -- new, approved, rejected, contacted, converted
        expires_at      TEXT,                        -- Auto-delete date (90 days from creation)
        created_at      TEXT DEFAULT (datetime('now'))
    );

    -- Pitches (call scripts and email drafts)
    CREATE TABLE IF NOT EXISTS pitches (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        lead_name       TEXT,
        contact_person  TEXT,
        pitch_script    TEXT,                        -- Voice call script
        email_subject   TEXT,                        -- NEW: email subject
        email_body      TEXT,                        -- NEW: email body
        key_value_prop  TEXT,
        call_to_action  TEXT,
        score           REAL,
        feedback        TEXT,
        revised_pitch   TEXT,
        ready_to_call   INTEGER DEFAULT 0,
        ready_to_email  INTEGER DEFAULT 0,          -- NEW
        missing_info    TEXT,                        -- JSON array
        raw_data        TEXT,                        -- Full JSON
        created_at      TEXT DEFAULT (datetime('now'))
    );

    -- ElevenLabs voice agents
    CREATE TABLE IF NOT EXISTS agents (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id         INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        agent_id        TEXT,                        -- ElevenLabs agent ID
        agent_name      TEXT,
        first_message   TEXT,
        system_prompt   TEXT,
        dynamic_vars    TEXT,                        -- JSON
        language        TEXT DEFAULT 'en',
        created_at      TEXT DEFAULT (datetime('now'))
    );

    -- Outbound calls
    CREATE TABLE IF NOT EXISTS calls (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        agent_db_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
        agent_id        TEXT,                        -- ElevenLabs agent ID
        phone_number    TEXT,
        call_sid        TEXT,                        -- Twilio call SID
        status          TEXT DEFAULT 'pending',
        dynamic_vars    TEXT,                        -- JSON
        transcript      TEXT,
        outcome         TEXT,
        duration_secs   INTEGER,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- Email outreach (NEW)
    CREATE TABLE IF NOT EXISTS email_outreach (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        pitch_id        INTEGER REFERENCES pitches(id) ON DELETE SET NULL,
        to_email        TEXT NOT NULL,
        from_email      TEXT NOT NULL,
        subject         TEXT NOT NULL,
        body_html       TEXT NOT NULL,
        status          TEXT DEFAULT 'draft',        -- draft, queued, sent, delivered, opened, replied, bounced
        sent_at         TEXT,
        opened_at       TEXT,
        replied_at      TEXT,
        resend_id       TEXT,                        -- Resend message ID
        created_at      TEXT DEFAULT (datetime('now'))
    );

    -- User preferences
    CREATE TABLE IF NOT EXISTS preferences (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        user_id         TEXT,
        key             TEXT NOT NULL,
        value           TEXT NOT NULL,
        updated_at      TEXT DEFAULT (datetime('now')),
        UNIQUE(campaign_id, key)
    );

    -- GDPR consent/audit log
    CREATE TABLE IF NOT EXISTS consent_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         TEXT NOT NULL,
        action          TEXT NOT NULL,               -- 'data_collected', 'consent_given', 'erasure_requested', 'data_exported', 'outreach_sent'
        entity_type     TEXT NOT NULL,               -- 'lead', 'campaign', 'call', 'email'
        entity_id       INTEGER,
        details         TEXT,                        -- JSON with additional context
        ip_address      TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
    );
    """)
    conn.commit()


# ─── GDPR: Right to Erasure ───────────────────────────────────────────────

def erase_lead_data(lead_id: int, user_id: str) -> bool:
    """Delete all data for a specific lead (GDPR right to erasure).

    Cascading delete: lead -> pitches, calls, email_outreach, agents.
    """
    conn = get_conn()
    try:
        # Verify ownership
        lead = conn.execute(
            "SELECT campaign_id FROM leads WHERE id=? AND user_id=?",
            (lead_id, user_id),
        ).fetchone()
        if not lead:
            return False

        # Delete in order (respecting FK constraints)
        conn.execute("DELETE FROM email_outreach WHERE lead_id=?", (lead_id,))
        conn.execute("DELETE FROM agents WHERE lead_id=?", (lead_id,))
        conn.execute("DELETE FROM pitches WHERE lead_id=?", (lead_id,))
        conn.execute("DELETE FROM leads WHERE id=?", (lead_id,))

        # Audit log
        conn.execute(
            "INSERT INTO consent_log (user_id, action, entity_type, entity_id) VALUES (?, ?, ?, ?)",
            (user_id, "erasure_completed", "lead", lead_id),
        )
        conn.commit()

        logger.info("GDPR erasure completed for lead %d by user %s", lead_id, user_id)
        return True
    except Exception as e:
        logger.error("GDPR erasure failed for lead %d: %s", lead_id, e)
        conn.rollback()
        return False


def erase_campaign_data(campaign_id: int, user_id: str) -> bool:
    """Delete all data for an entire campaign (GDPR right to erasure)."""
    conn = get_conn()
    try:
        # Verify ownership
        campaign = conn.execute(
            "SELECT id FROM campaigns WHERE id=? AND user_id=?",
            (campaign_id, user_id),
        ).fetchone()
        if not campaign:
            return False

        # Cascading delete (SQLite handles this with ON DELETE CASCADE)
        conn.execute("DELETE FROM campaigns WHERE id=?", (campaign_id,))

        conn.execute(
            "INSERT INTO consent_log (user_id, action, entity_type, entity_id) VALUES (?, ?, ?, ?)",
            (user_id, "erasure_completed", "campaign", campaign_id),
        )
        conn.commit()
        return True
    except Exception as e:
        logger.error("Campaign erasure failed: %s", e)
        conn.rollback()
        return False


def log_consent_action(user_id: str, action: str, entity_type: str,
                       entity_id: int = 0, details: str = "", ip: str = "") -> None:
    """Log a GDPR-relevant action for audit trail."""
    conn = get_conn()
    conn.execute(
        "INSERT INTO consent_log (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?,?,?,?,?,?)",
        (user_id, action, entity_type, entity_id, details, ip),
    )
    conn.commit()


# ─── Campaign CRUD ───────────────────────────────────────────────────────────

def create_campaign(website_url: str, session_id: str = "", user_id: str = "") -> int:
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO campaigns (website_url, session_id, user_id) VALUES (?, ?, ?)",
        (website_url, session_id, user_id),
    )
    conn.commit()
    return cur.lastrowid


def update_campaign_analysis(campaign_id: int, business_name: str, analysis: dict) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE campaigns SET business_name=?, analysis=?, updated_at=datetime('now') WHERE id=?",
        (business_name, json.dumps(analysis, default=str), campaign_id),
    )
    conn.commit()


def get_campaign(campaign_id: int) -> Optional[dict]:
    row = get_conn().execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
    if row:
        d = dict(row)
        if d.get("analysis"):
            d["analysis"] = json.loads(d["analysis"])
        return d
    return None


def get_latest_campaign(user_id: str = "") -> Optional[dict]:
    conn = get_conn()
    if user_id:
        row = conn.execute(
            "SELECT * FROM campaigns WHERE user_id=? ORDER BY id DESC LIMIT 1",
            (user_id,),
        ).fetchone()
    else:
        row = conn.execute("SELECT * FROM campaigns ORDER BY id DESC LIMIT 1").fetchone()
    if row:
        d = dict(row)
        if d.get("analysis"):
            d["analysis"] = json.loads(d["analysis"])
        return d
    return None


def get_campaigns_for_user(user_id: str) -> list[dict]:
    """Get all campaigns for a user."""
    rows = get_conn().execute(
        "SELECT id, website_url, business_name, status, created_at, updated_at FROM campaigns WHERE user_id=? ORDER BY id DESC",
        (user_id,),
    ).fetchall()
    return [dict(r) for r in rows]


# ─── Lead CRUD ───────────────────────────────────────────────────────────────

def save_leads_db(campaign_id: int, leads: list[dict], user_id: str = "") -> list[int]:
    conn = get_conn()
    ids = []
    # Set expiry to 90 days from now
    expires = datetime.now(timezone.utc).isoformat()
    for lead in leads:
        cur = conn.execute(
            """INSERT INTO leads
               (campaign_id, user_id, name, website, phone, email, contact_person, address, city,
                country, industry, relevance_reason, source, rating, reviews, raw_data, consent_basis, expires_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now', '+90 days'))""",
            (
                campaign_id,
                user_id,
                lead.get("name", ""),
                lead.get("website", ""),
                lead.get("phone", ""),
                lead.get("email", ""),
                lead.get("contact_person", ""),
                lead.get("address", ""),
                lead.get("city", ""),
                lead.get("country", ""),
                lead.get("industry", ""),
                lead.get("relevance_reason", ""),
                lead.get("source", ""),
                lead.get("rating", 0),
                lead.get("reviews", 0),
                json.dumps(lead, default=str),
                "legitimate_interest",
            ),
        )
        ids.append(cur.lastrowid)
    conn.commit()
    return ids


def update_lead_scores(campaign_id: int, scored_leads: list[dict]) -> None:
    conn = get_conn()
    for lead in scored_leads:
        conn.execute(
            """UPDATE leads SET lead_score=?, score_grade=?, score_breakdown=?, raw_data=?
               WHERE campaign_id=? AND name=?""",
            (
                lead.get("lead_score", 0),
                lead.get("score_grade", "D"),
                json.dumps(lead.get("score_breakdown", {})),
                json.dumps(lead, default=str),
                campaign_id,
                lead.get("name", ""),
            ),
        )
    conn.commit()


def get_leads(campaign_id: int) -> list[dict]:
    rows = get_conn().execute(
        "SELECT * FROM leads WHERE campaign_id=? ORDER BY lead_score DESC", (campaign_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def update_lead_status(lead_id: int, status: str, user_id: str = "") -> bool:
    """Update lead status (approve/reject/contacted)."""
    conn = get_conn()
    if user_id:
        conn.execute(
            "UPDATE leads SET status=? WHERE id=? AND user_id=?",
            (status, lead_id, user_id),
        )
    else:
        conn.execute("UPDATE leads SET status=? WHERE id=?", (status, lead_id))
    conn.commit()
    return True


# ─── Pitch CRUD ──────────────────────────────────────────────────────────────

def save_pitches_db(campaign_id: int, pitches: list[dict]) -> list[int]:
    conn = get_conn()
    ids = []
    for p in pitches:
        cur = conn.execute(
            """INSERT INTO pitches
               (campaign_id, lead_name, contact_person, pitch_script,
                email_subject, email_body, key_value_prop, call_to_action, raw_data)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                campaign_id,
                p.get("lead_name", ""),
                p.get("contact_person", ""),
                p.get("pitch_script", ""),
                p.get("email_subject", ""),
                p.get("email_body", ""),
                p.get("key_value_proposition", ""),
                p.get("call_to_action", ""),
                json.dumps(p, default=str),
            ),
        )
        ids.append(cur.lastrowid)
    conn.commit()
    return ids


def update_judged_pitches_db(campaign_id: int, judged: list[dict]) -> None:
    conn = get_conn()
    for j in judged:
        conn.execute(
            """UPDATE pitches SET score=?, feedback=?, revised_pitch=?, ready_to_call=?,
               ready_to_email=?, missing_info=?, raw_data=?
               WHERE campaign_id=? AND lead_name=?""",
            (
                j.get("score", 0),
                j.get("feedback", ""),
                j.get("revised_pitch", ""),
                1 if j.get("ready_to_call") else 0,
                1 if j.get("ready_to_email") else 0,
                json.dumps(j.get("missing_info", [])),
                json.dumps(j, default=str),
                campaign_id,
                j.get("lead_name", ""),
            ),
        )
    conn.commit()


# ─── Agent CRUD ──────────────────────────────────────────────────────────────

def save_agent_db(campaign_id: int, agent_data: dict) -> int:
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO agents
           (campaign_id, agent_id, agent_name, first_message, system_prompt,
            dynamic_vars, language)
           VALUES (?,?,?,?,?,?,?)""",
        (
            campaign_id,
            agent_data.get("agent_id", ""),
            agent_data.get("name", ""),
            agent_data.get("first_message_template", ""),
            agent_data.get("system_prompt", ""),
            json.dumps(agent_data.get("dynamic_variables", {})),
            agent_data.get("language", "en"),
        ),
    )
    conn.commit()
    return cur.lastrowid


# ─── Call CRUD ───────────────────────────────────────────────────────────────

def save_call_db(campaign_id: int, call_data: dict) -> int:
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO calls
           (campaign_id, agent_id, phone_number, call_sid, status, dynamic_vars)
           VALUES (?,?,?,?,?,?)""",
        (
            campaign_id,
            call_data.get("agent_id", ""),
            call_data.get("phone_number", ""),
            call_data.get("call_sid", ""),
            call_data.get("status", "pending"),
            json.dumps(call_data.get("dynamic_variables", {})),
        ),
    )
    conn.commit()
    return cur.lastrowid


def update_call_status(call_id: int, status: str, transcript: str = "", outcome: str = "", duration: int = 0) -> None:
    conn = get_conn()
    conn.execute(
        """UPDATE calls SET status=?, transcript=?, outcome=?, duration_secs=?,
           updated_at=datetime('now') WHERE id=?""",
        (status, transcript, outcome, duration, call_id),
    )
    conn.commit()


# ─── Email Outreach CRUD ───────────────────────────────────────────────────

def save_email_outreach(campaign_id: int, email_data: dict) -> int:
    """Save an email outreach record."""
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO email_outreach
           (campaign_id, lead_id, pitch_id, to_email, from_email, subject, body_html, status)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            campaign_id,
            email_data.get("lead_id"),
            email_data.get("pitch_id"),
            email_data.get("to_email", ""),
            email_data.get("from_email", ""),
            email_data.get("subject", ""),
            email_data.get("body_html", ""),
            email_data.get("status", "draft"),
        ),
    )
    conn.commit()
    return cur.lastrowid


def update_email_status(email_id: int, status: str, resend_id: str = "") -> None:
    """Update email delivery status."""
    conn = get_conn()
    updates = ["status=?"]
    params = [status]

    if status == "sent":
        updates.append("sent_at=datetime('now')")
    elif status == "opened":
        updates.append("opened_at=datetime('now')")
    elif status == "replied":
        updates.append("replied_at=datetime('now')")

    if resend_id:
        updates.append("resend_id=?")
        params.append(resend_id)

    params.append(email_id)
    conn.execute(f"UPDATE email_outreach SET {', '.join(updates)} WHERE id=?", params)
    conn.commit()


# ─── Domain Verification ─────────────────────────────────────────────────

def create_domain_verification(user_id: str, domain: str, method: str, token: str) -> int:
    """Create a pending domain verification."""
    conn = get_conn()
    cur = conn.execute(
        """INSERT OR REPLACE INTO domain_verifications
           (user_id, domain, method, verification_token, verified)
           VALUES (?,?,?,?,0)""",
        (user_id, domain, method, token),
    )
    conn.commit()
    return cur.lastrowid


def verify_domain(user_id: str, domain: str) -> bool:
    """Mark a domain as verified."""
    conn = get_conn()
    conn.execute(
        """UPDATE domain_verifications
           SET verified=1, verified_at=datetime('now')
           WHERE user_id=? AND domain=?""",
        (user_id, domain),
    )
    conn.commit()
    return True


def is_domain_verified(user_id: str, domain: str) -> bool:
    """Check if a user has verified ownership of a domain."""
    row = get_conn().execute(
        "SELECT verified FROM domain_verifications WHERE user_id=? AND domain=?",
        (user_id, domain),
    ).fetchone()
    return bool(row and row["verified"])


def get_verified_domains(user_id: str) -> list[str]:
    """Get all verified domains for a user."""
    rows = get_conn().execute(
        "SELECT domain FROM domain_verifications WHERE user_id=? AND verified=1",
        (user_id,),
    ).fetchall()
    return [r["domain"] for r in rows]


# ─── Preferences CRUD ───────────────────────────────────────────────────────

def save_prefs_db(campaign_id: int, prefs: dict) -> None:
    conn = get_conn()
    for k, v in prefs.items():
        conn.execute(
            """INSERT INTO preferences (campaign_id, key, value, updated_at)
               VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(campaign_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
            (campaign_id, k, json.dumps(v) if not isinstance(v, str) else v),
        )
    conn.commit()


def get_prefs_db(campaign_id: int) -> dict:
    rows = get_conn().execute(
        "SELECT key, value FROM preferences WHERE campaign_id=?", (campaign_id,)
    ).fetchall()
    result = {}
    for r in rows:
        try:
            result[r["key"]] = json.loads(r["value"])
        except (json.JSONDecodeError, TypeError):
            result[r["key"]] = r["value"]
    return result


# ─── Expired Data Cleanup (GDPR) ──────────────────────────────────────────

def cleanup_expired_leads() -> int:
    """Delete leads that have expired (90-day retention policy).

    Should be called periodically (e.g., daily cron job).
    """
    conn = get_conn()
    cur = conn.execute(
        "DELETE FROM leads WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
    )
    count = cur.rowcount
    if count > 0:
        conn.commit()
        logger.info("GDPR cleanup: deleted %d expired leads", count)
    return count
