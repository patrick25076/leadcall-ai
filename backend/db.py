"""Supabase PostgreSQL persistence layer for GRAI.

Uses Supabase REST API (supabase-py) — works over HTTPS, no IPv4/IPv6 issues.
All data persists across deploys. Production-grade.

Tables: campaigns, leads, pitches, agents, calls, email_outreach,
        preferences, consent_log, domain_verifications
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from supabase import create_client, Client

logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY", "")

_client: Optional[Client] = None


def is_configured() -> bool:
    """Check if Supabase is configured."""
    return bool(SUPABASE_URL and SUPABASE_KEY)


def get_db() -> Client:
    """Get or create Supabase client."""
    global _client
    if _client is None:
        if not SUPABASE_URL or not SUPABASE_KEY:
            logger.warning("Supabase not configured — DB operations will be skipped")
            raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY are required")
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
        logger.info("Connected to Supabase: %s", SUPABASE_URL[:30])
    return _client


# Keep this for backward compatibility with server.py lifespan
def get_conn():
    """Initialize database connection. Called on startup."""
    if not is_configured():
        logger.warning("Supabase not configured — running without persistence")
        return None
    return get_db()


# ─── Campaign CRUD ───────────────────────────────────────────────────────────

def create_campaign(website_url: str, session_id: str = "", user_id: str = "") -> int:
    if not is_configured():
        return 0
    result = get_db().table("campaigns").insert({
        "website_url": website_url,
        "session_id": session_id,
        "user_id": user_id or None,
        "status": "active",
    }).execute()
    return result.data[0]["id"] if result.data else 0


def update_campaign_analysis(campaign_id: int, business_name: str, analysis: dict) -> None:
    if not is_configured():
        return
    get_db().table("campaigns").update({
        "business_name": business_name,
        "analysis": analysis,
    }).eq("id", campaign_id).execute()


def get_campaign(campaign_id: int) -> Optional[dict]:
    if not is_configured():
        return None
    result = get_db().table("campaigns").select("*").eq("id", campaign_id).single().execute()
    return result.data if result.data else None


def get_latest_campaign(user_id: str = "") -> Optional[dict]:
    if not is_configured():
        return None
    q = get_db().table("campaigns").select("*").order("id", desc=True).limit(1)
    if user_id:
        q = q.eq("user_id", user_id)
    result = q.execute()
    return result.data[0] if result.data else None


def get_campaigns_for_user(user_id: str) -> list[dict]:
    if not is_configured():
        return []
    result = get_db().table("campaigns").select(
        "id, website_url, business_name, status, created_at, updated_at"
    ).eq("user_id", user_id).order("id", desc=True).execute()
    campaigns = result.data or []
    # Enrich with counts
    for c in campaigns:
        cid = c["id"]
        leads_r = get_db().table("leads").select("id", count="exact").eq("campaign_id", cid).execute()
        pitches_r = get_db().table("pitches").select("id", count="exact").eq("campaign_id", cid).execute()
        agents_r = get_db().table("agents").select("id", count="exact").eq("campaign_id", cid).execute()
        c["lead_count"] = leads_r.count if leads_r.count is not None else len(leads_r.data or [])
        c["pitch_count"] = pitches_r.count if pitches_r.count is not None else len(pitches_r.data or [])
        c["agent_count"] = agents_r.count if agents_r.count is not None else len(agents_r.data or [])
    return campaigns


def get_campaign_state(campaign_id: int) -> dict:
    """Reconstruct full pipeline state from DB tables for a campaign.

    This is the single source of truth — replaces the in-memory pipeline_state dict.
    """
    if not is_configured():
        return _empty_state(campaign_id)

    try:
        # Campaign + analysis
        campaign = get_campaign(campaign_id)
        analysis = campaign.get("analysis") if campaign else None

        # Leads (scored + raw combined)
        leads_data = get_leads(campaign_id)
        scored = [l for l in leads_data if l.get("lead_score") is not None]
        raw_leads = leads_data  # All leads are "raw" with optional score fields

        # Pitches
        pitches_result = get_db().table("pitches").select("*").eq(
            "campaign_id", campaign_id
        ).execute()
        all_pitches = pitches_result.data or []

        # Split into raw pitches and judged pitches
        pitches = [p.get("raw_data") or p for p in all_pitches if not p.get("score")]
        judged = [p.get("raw_data") or p for p in all_pitches if p.get("score")]

        # If no separate judged, rebuild from pitch records that have scores
        if not judged and all_pitches:
            judged = []
            for p in all_pitches:
                if p.get("score") or p.get("ready_to_call") or p.get("ready_to_email"):
                    j = p.get("raw_data") or {}
                    j.update({
                        "lead_name": p.get("lead_name", ""),
                        "contact_person": p.get("contact_person", ""),
                        "score": p.get("score", 0),
                        "feedback": p.get("feedback", ""),
                        "revised_pitch": p.get("revised_pitch", ""),
                        "ready_to_call": p.get("ready_to_call", False),
                        "ready_to_email": p.get("ready_to_email", False),
                        "missing_info": p.get("missing_info", []),
                        "pitch_script": p.get("pitch_script", ""),
                        "email_subject": p.get("email_subject", ""),
                        "email_body": p.get("email_body", ""),
                    })
                    judged.append(j)

        # Bridge phone numbers from leads into pitch objects
        # Leads have `phone`, pitches need `phone_number` for voice outreach
        phone_lookup: dict[str, str] = {}
        email_lookup: dict[str, str] = {}
        for lead in leads_data:
            name = lead.get("name", "")
            if name:
                if lead.get("phone"):
                    phone_lookup[name] = lead["phone"]
                if lead.get("email"):
                    email_lookup[name] = lead["email"]

        for pitch_list in (pitches, judged):
            for p in pitch_list:
                lead_name = p.get("lead_name", "")
                if lead_name and not p.get("phone_number") and not p.get("phone"):
                    phone = phone_lookup.get(lead_name, "")
                    if phone:
                        p["phone_number"] = phone
                        p["phone"] = phone
                if lead_name and not p.get("email"):
                    email = email_lookup.get(lead_name, "")
                    if email:
                        p["email"] = email

        # Agents
        agents_result = get_db().table("agents").select("*").eq(
            "campaign_id", campaign_id
        ).execute()
        agents = []
        for a in (agents_result.data or []):
            agents.append({
                "agent_id": a.get("agent_id", ""),
                "name": a.get("agent_name", ""),
                "first_message_template": a.get("first_message", ""),
                "system_prompt": a.get("system_prompt", ""),
                "dynamic_variables": a.get("dynamic_vars", {}),
                "language": a.get("language", "en"),
            })

        # Calls
        calls_result = get_db().table("calls").select("*").eq(
            "campaign_id", campaign_id
        ).execute()
        call_results = calls_result.data or []

        # Preferences
        prefs = get_prefs_db(campaign_id)
        # Merge with defaults
        default_prefs = {
            "language": "English",
            "call_style": "professional",
            "business_hours_only": True,
            "objective": "Book a demo meeting",
        }
        default_prefs.update(prefs)

        return {
            "business_analysis": analysis,
            "leads": raw_leads,
            "scored_leads": scored if scored else raw_leads,
            "pitches": pitches if pitches else [p.get("raw_data") or p for p in all_pitches],
            "judged_pitches": judged,
            "preferences": default_prefs,
            "elevenlabs_agents": agents,
            "call_results": call_results,
            "campaign_id": campaign_id,
            "user_id": campaign.get("user_id", "") if campaign else "",
        }
    except Exception as e:
        logger.error("Failed to load campaign state %d: %s", campaign_id, e)
        return _empty_state(campaign_id)


def _empty_state(campaign_id: int = 0) -> dict:
    """Return an empty pipeline state dict."""
    return {
        "business_analysis": None,
        "leads": [],
        "scored_leads": [],
        "pitches": [],
        "judged_pitches": [],
        "preferences": {
            "language": "English",
            "call_style": "professional",
            "business_hours_only": True,
            "objective": "Book a demo meeting",
        },
        "elevenlabs_agents": [],
        "call_results": [],
        "campaign_id": campaign_id,
        "user_id": "",
    }


def verify_campaign_ownership(campaign_id: int, user_id: str) -> bool:
    """Check that a campaign belongs to the given user. Returns False if not owned."""
    if not is_configured() or not user_id:
        return False
    try:
        result = get_db().table("campaigns").select("id").eq(
            "id", campaign_id
        ).eq("user_id", user_id).execute()
        return bool(result.data)
    except Exception:
        return False


def get_agents_for_campaign(campaign_id: int) -> list[dict]:
    """Get all agents for a campaign."""
    if not is_configured():
        return []
    result = get_db().table("agents").select("*").eq(
        "campaign_id", campaign_id
    ).execute()
    return result.data or []


def get_calls_for_campaign(campaign_id: int) -> list[dict]:
    """Get all calls for a campaign."""
    if not is_configured():
        return []
    result = get_db().table("calls").select("*").eq(
        "campaign_id", campaign_id
    ).execute()
    return result.data or []


# ─── Lead CRUD ───────────────────────────────────────────────────────────────

def save_leads_db(campaign_id: int, leads: list[dict], user_id: str = "") -> list[int]:
    if not is_configured():
        return []
    rows = []
    for lead in leads:
        rows.append({
            "campaign_id": campaign_id,
            "user_id": user_id or None,
            "name": lead.get("name", ""),
            "website": lead.get("website", ""),
            "phone": lead.get("phone", ""),
            "email": lead.get("email", ""),
            "contact_person": lead.get("contact_person", ""),
            "address": lead.get("address", ""),
            "city": lead.get("city", ""),
            "country": lead.get("country", ""),
            "industry": lead.get("industry", ""),
            "relevance_reason": lead.get("relevance_reason", ""),
            "source": lead.get("source", ""),
            "rating": lead.get("rating", 0),
            "reviews": lead.get("reviews", 0),
            "raw_data": lead,
            "consent_basis": "legitimate_interest",
            "status": "new",
        })
    result = get_db().table("leads").insert(rows).execute()
    return [r["id"] for r in (result.data or [])]


def update_lead_scores(campaign_id: int, scored_leads: list[dict]) -> None:
    if not is_configured():
        return
    db = get_db()
    for lead in scored_leads:
        db.table("leads").update({
            "lead_score": lead.get("lead_score", 0),
            "score_grade": lead.get("score_grade", "D"),
            "score_breakdown": lead.get("score_breakdown", {}),
            "raw_data": lead,
        }).eq("campaign_id", campaign_id).eq("name", lead.get("name", "")).execute()


def get_leads(campaign_id: int) -> list[dict]:
    if not is_configured():
        return []
    result = get_db().table("leads").select("*").eq(
        "campaign_id", campaign_id
    ).order("lead_score", desc=True).execute()
    return result.data or []


def update_lead_status(lead_id: int, status: str, user_id: str = "") -> bool:
    if not is_configured():
        return False
    q = get_db().table("leads").update({"status": status}).eq("id", lead_id)
    if user_id:
        q = q.eq("user_id", user_id)
    q.execute()
    return True


# ─── Pitch CRUD ──────────────────────────────────────────────────────────────

def save_pitches_db(campaign_id: int, pitches: list[dict]) -> list[int]:
    if not is_configured():
        return []
    rows = []
    for p in pitches:
        rows.append({
            "campaign_id": campaign_id,
            "lead_name": p.get("lead_name", ""),
            "contact_person": p.get("contact_person", ""),
            "pitch_script": p.get("pitch_script", ""),
            "email_subject": p.get("email_subject", ""),
            "email_body": p.get("email_body", ""),
            "key_value_prop": p.get("key_value_proposition", ""),
            "call_to_action": p.get("call_to_action", ""),
            "raw_data": p,
        })
    result = get_db().table("pitches").insert(rows).execute()
    return [r["id"] for r in (result.data or [])]


def update_judged_pitches_db(campaign_id: int, judged: list[dict]) -> None:
    if not is_configured():
        return
    db = get_db()
    for j in judged:
        db.table("pitches").update({
            "score": j.get("score", 0),
            "feedback": j.get("feedback", ""),
            "revised_pitch": j.get("revised_pitch", ""),
            "ready_to_call": j.get("ready_to_call", False),
            "ready_to_email": j.get("ready_to_email", False),
            "missing_info": j.get("missing_info", []),
            "raw_data": j,
        }).eq("campaign_id", campaign_id).eq("lead_name", j.get("lead_name", "")).execute()


# ─── Agent CRUD ──────────────────────────────────────────────────────────────

def save_agent_db(campaign_id: int, agent_data: dict) -> int:
    if not is_configured():
        return 0
    result = get_db().table("agents").insert({
        "campaign_id": campaign_id,
        "agent_id": agent_data.get("agent_id", ""),
        "agent_name": agent_data.get("name", ""),
        "first_message": agent_data.get("first_message_template", ""),
        "system_prompt": agent_data.get("system_prompt", ""),
        "dynamic_vars": agent_data.get("dynamic_variables", {}),
        "language": agent_data.get("language", "en"),
    }).execute()
    return result.data[0]["id"] if result.data else 0


# ─── Call CRUD ───────────────────────────────────────────────────────────────

def save_call_db(campaign_id: int, call_data: dict) -> int:
    if not is_configured():
        return 0
    result = get_db().table("calls").insert({
        "campaign_id": campaign_id,
        "agent_id": call_data.get("agent_id", ""),
        "phone_number": call_data.get("phone_number", ""),
        "call_sid": call_data.get("call_sid", ""),
        "status": call_data.get("status", "pending"),
        "dynamic_vars": call_data.get("dynamic_variables", {}),
    }).execute()
    return result.data[0]["id"] if result.data else 0


def update_call_status(call_id: int, status: str, transcript: str = "", outcome: str = "", duration: int = 0) -> None:
    if not is_configured():
        return
    get_db().table("calls").update({
        "status": status,
        "transcript": transcript,
        "outcome": outcome,
        "duration_secs": duration,
    }).eq("id", call_id).execute()


# ─── Email Outreach CRUD ───────────────────────────────────────────────────

def save_email_outreach(campaign_id: int, email_data: dict) -> int:
    if not is_configured():
        return 0
    result = get_db().table("email_outreach").insert({
        "campaign_id": campaign_id,
        "lead_id": email_data.get("lead_id"),
        "pitch_id": email_data.get("pitch_id"),
        "to_email": email_data.get("to_email", ""),
        "from_email": email_data.get("from_email", ""),
        "subject": email_data.get("subject", ""),
        "body_html": email_data.get("body_html", ""),
        "status": email_data.get("status", "draft"),
    }).execute()
    return result.data[0]["id"] if result.data else 0


def update_email_status(email_id: int, status: str, resend_id: str = "") -> None:
    if not is_configured():
        return
    update = {"status": status}
    if resend_id:
        update["resend_id"] = resend_id
    if status == "sent":
        update["sent_at"] = datetime.now(timezone.utc).isoformat()
    get_db().table("email_outreach").update(update).eq("id", email_id).execute()


# ─── Preferences CRUD ───────────────────────────────────────────────────────

def save_prefs_db(campaign_id: int, prefs: dict) -> None:
    if not is_configured():
        return
    db = get_db()
    for k, v in prefs.items():
        val = json.dumps(v) if not isinstance(v, str) else v
        # Upsert: insert or update on conflict
        db.table("preferences").upsert({
            "campaign_id": campaign_id,
            "key": k,
            "value": val,
        }, on_conflict="campaign_id,key").execute()


def get_prefs_db(campaign_id: int) -> dict:
    if not is_configured():
        return {}
    result = get_db().table("preferences").select("key, value").eq(
        "campaign_id", campaign_id
    ).execute()
    out = {}
    for r in (result.data or []):
        try:
            out[r["key"]] = json.loads(r["value"])
        except (json.JSONDecodeError, TypeError):
            out[r["key"]] = r["value"]
    return out


# ─── Domain Verification ─────────────────────────────────────────────────

def create_domain_verification(user_id: str, domain: str, method: str, token: str) -> int:
    if not is_configured():
        return 0
    result = get_db().table("domain_verifications").upsert({
        "user_id": user_id,
        "domain": domain,
        "method": method,
        "verification_token": token,
        "verified": False,
    }, on_conflict="user_id,domain").execute()
    return result.data[0]["id"] if result.data else 0


def verify_domain(user_id: str, domain: str) -> bool:
    if not is_configured():
        return False
    get_db().table("domain_verifications").update({
        "verified": True,
        "verified_at": datetime.now(timezone.utc).isoformat(),
    }).eq("user_id", user_id).eq("domain", domain).execute()
    return True


def is_domain_verified(user_id: str, domain: str) -> bool:
    if not is_configured():
        return False
    result = get_db().table("domain_verifications").select("verified").eq(
        "user_id", user_id
    ).eq("domain", domain).single().execute()
    return bool(result.data and result.data.get("verified"))


def get_verified_domains(user_id: str) -> list[str]:
    if not is_configured():
        return []
    result = get_db().table("domain_verifications").select("domain").eq(
        "user_id", user_id
    ).eq("verified", True).execute()
    return [r["domain"] for r in (result.data or [])]


# ─── GDPR: Right to Erasure ───────────────────────────────────────────────

def erase_lead_data(lead_id: int, user_id: str) -> bool:
    if not is_configured():
        return False
    db = get_db()
    # Verify ownership
    result = db.table("leads").select("campaign_id").eq("id", lead_id).eq("user_id", user_id).execute()
    if not result.data:
        return False
    db.table("email_outreach").delete().eq("lead_id", lead_id).execute()
    db.table("agents").delete().eq("lead_id", lead_id).execute()
    db.table("pitches").delete().eq("lead_id", lead_id).execute()
    db.table("leads").delete().eq("id", lead_id).execute()
    log_consent_action(user_id, "erasure_completed", "lead", lead_id)
    logger.info("GDPR erasure completed for lead %d", lead_id)
    return True


def erase_campaign_data(campaign_id: int, user_id: str) -> bool:
    if not is_configured():
        return False
    db = get_db()
    result = db.table("campaigns").select("id").eq("id", campaign_id).eq("user_id", user_id).execute()
    if not result.data:
        return False
    # Delete in order
    db.table("email_outreach").delete().eq("campaign_id", campaign_id).execute()
    db.table("calls").delete().eq("campaign_id", campaign_id).execute()
    db.table("agents").delete().eq("campaign_id", campaign_id).execute()
    db.table("pitches").delete().eq("campaign_id", campaign_id).execute()
    db.table("leads").delete().eq("campaign_id", campaign_id).execute()
    db.table("preferences").delete().eq("campaign_id", campaign_id).execute()
    db.table("campaigns").delete().eq("id", campaign_id).execute()
    log_consent_action(user_id, "erasure_completed", "campaign", campaign_id)
    return True


def log_consent_action(user_id: str, action: str, entity_type: str,
                       entity_id: int = 0, details: str = "", ip: str = "") -> None:
    if not is_configured():
        return
    get_db().table("consent_log").insert({
        "user_id": user_id,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "details": details,
        "ip_address": ip,
    }).execute()


def cleanup_expired_leads() -> int:
    """Delete leads older than 90 days (GDPR retention policy)."""
    if not is_configured():
        return 0
    result = get_db().table("leads").delete().lt(
        "created_at", datetime.now(timezone.utc).isoformat()
    ).not_.is_("expires_at", "null").lt(
        "expires_at", datetime.now(timezone.utc).isoformat()
    ).execute()
    count = len(result.data or [])
    if count > 0:
        logger.info("GDPR cleanup: deleted %d expired leads", count)
    return count
