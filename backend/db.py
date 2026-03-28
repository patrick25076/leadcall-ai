"""SQLite persistence layer for LeadCall AI.

Tables: campaigns, leads, pitches, agents, calls, preferences
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(__file__), "leadcall.db")

_conn: Optional[sqlite3.Connection] = None


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
        _init_tables(_conn)
    return _conn


def _init_tables(conn: sqlite3.Connection) -> None:
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS campaigns (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        website_url TEXT NOT NULL,
        business_name TEXT,
        analysis    TEXT,          -- full JSON
        session_id  TEXT,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id),
        name            TEXT,
        website         TEXT,
        phone           TEXT,
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
        score_breakdown TEXT,       -- JSON
        raw_data        TEXT,       -- full JSON
        created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pitches (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id),
        lead_id         INTEGER REFERENCES leads(id),
        lead_name       TEXT,
        contact_person  TEXT,
        pitch_script    TEXT,
        key_value_prop  TEXT,
        call_to_action  TEXT,
        score           REAL,
        feedback        TEXT,
        revised_pitch   TEXT,
        ready_to_call   INTEGER DEFAULT 0,
        missing_info    TEXT,       -- JSON array
        raw_data        TEXT,       -- full JSON
        created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id),
        lead_id         INTEGER REFERENCES leads(id),
        agent_id        TEXT,      -- ElevenLabs agent ID
        agent_name      TEXT,
        first_message   TEXT,
        system_prompt   TEXT,
        dynamic_vars    TEXT,       -- JSON
        language        TEXT DEFAULT 'en',
        created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calls (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id     INTEGER REFERENCES campaigns(id),
        agent_db_id     INTEGER REFERENCES agents(id),
        agent_id        TEXT,      -- ElevenLabs agent ID
        phone_number    TEXT,
        call_sid        TEXT,      -- Twilio call SID
        status          TEXT DEFAULT 'pending',
        dynamic_vars    TEXT,       -- JSON
        transcript      TEXT,
        outcome         TEXT,
        duration_secs   INTEGER,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS preferences (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER REFERENCES campaigns(id),
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        updated_at  TEXT DEFAULT (datetime('now')),
        UNIQUE(campaign_id, key)
    );
    """)
    conn.commit()


# ─── Campaign CRUD ───────────────────────────────────────────────────────────

def create_campaign(website_url: str, session_id: str = "") -> int:
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO campaigns (website_url, session_id) VALUES (?, ?)",
        (website_url, session_id),
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


def get_latest_campaign() -> Optional[dict]:
    row = get_conn().execute("SELECT * FROM campaigns ORDER BY id DESC LIMIT 1").fetchone()
    if row:
        d = dict(row)
        if d.get("analysis"):
            d["analysis"] = json.loads(d["analysis"])
        return d
    return None


# ─── Lead CRUD ───────────────────────────────────────────────────────────────

def save_leads_db(campaign_id: int, leads: list[dict]) -> list[int]:
    conn = get_conn()
    ids = []
    for lead in leads:
        cur = conn.execute(
            """INSERT INTO leads
               (campaign_id, name, website, phone, contact_person, address, city,
                country, industry, relevance_reason, source, rating, reviews, raw_data)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                campaign_id,
                lead.get("name", ""),
                lead.get("website", ""),
                lead.get("phone", ""),
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


# ─── Pitch CRUD ──────────────────────────────────────────────────────────────

def save_pitches_db(campaign_id: int, pitches: list[dict]) -> list[int]:
    conn = get_conn()
    ids = []
    for p in pitches:
        cur = conn.execute(
            """INSERT INTO pitches
               (campaign_id, lead_name, contact_person, pitch_script, key_value_prop,
                call_to_action, raw_data)
               VALUES (?,?,?,?,?,?,?)""",
            (
                campaign_id,
                p.get("lead_name", ""),
                p.get("contact_person", ""),
                p.get("pitch_script", ""),
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
               missing_info=?, raw_data=?
               WHERE campaign_id=? AND lead_name=?""",
            (
                j.get("score", 0),
                j.get("feedback", ""),
                j.get("revised_pitch", ""),
                1 if j.get("ready_to_call") else 0,
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
