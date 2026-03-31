"""Dynamic variable system for ElevenLabs agent personalization.

Three variable scopes:
1. Campaign-level — shared by all leads (caller_name, objective, call_style, etc.)
2. Per-lead — injected at call time from lead + pitch data
3. Secret — prefixed with secret__, excluded from LLM context, used in tool headers

Variable resolution order: per-lead overrides campaign-level.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

SECRET_PREFIX = "secret__"
SYSTEM_ENV_PREFIX = "system_env__"

# Campaign-level variables — set once, apply to all leads
CAMPAIGN_VARS = {
    "caller_name": {"required": True, "description": "Name the AI uses to introduce itself"},
    "company_name": {"required": False, "description": "Company name override"},
    "objective": {"required": True, "description": "Call goal: book_demo, qualify_lead, schedule_visit, gather_info"},
    "call_style": {"required": False, "description": "professional, friendly, consultative, assertive"},
    "language": {"required": False, "description": "2-letter language code (auto-detected from website)"},
    "closing_cta": {"required": False, "description": "Custom closing ask"},
    "pricing_info": {"required": False, "description": "Pricing details to mention"},
    "business_hours": {"required": False, "description": "When to call (e.g. 9:00-18:00 Mon-Fri)"},
    "calendar_link": {"required": False, "description": "Booking URL for meetings"},
    "additional_context": {"required": False, "description": "Extra info for the agent's system prompt"},
}

# Per-lead variables — computed at call time from lead + pitch data
PER_LEAD_VARS = [
    "lead_name", "lead_company", "lead_industry", "contact_person",
    "phone", "email", "pitch_script", "email_subject",
    "key_value_prop", "relevance_reason",
]


def build_call_vars(campaign_vars: dict, lead: dict, pitch: dict) -> dict:
    """Merge campaign-level vars with per-lead data for a single call.

    Args:
        campaign_vars: Campaign-level dynamic variables
        lead: Lead record from DB
        pitch: Pitch record from DB (matched to this lead)

    Returns:
        Complete dynamic variable dict for ElevenLabs agent call
    """
    # Start with campaign-level vars
    merged = {k: v for k, v in campaign_vars.items() if v}

    # Inject per-lead data
    merged["lead_name"] = lead.get("name", "")
    merged["lead_company"] = lead.get("name", "")  # Often the company name
    merged["lead_industry"] = lead.get("industry", "")
    merged["contact_person"] = (
        lead.get("contact_person", "")
        or pitch.get("contact_person", "")
        or lead.get("name", "")
    )
    merged["phone"] = lead.get("phone", "")
    merged["email"] = lead.get("email", "")

    # Inject pitch content
    merged["pitch_script"] = (
        pitch.get("revised_pitch", "")
        or pitch.get("pitch_script", "")
        or ""
    )
    merged["email_subject"] = pitch.get("email_subject", "")
    merged["key_value_prop"] = pitch.get("key_value_prop", "") or pitch.get("key_value_proposition", "")
    merged["relevance_reason"] = lead.get("relevance_reason", "")

    # Use call_to_action from pitch if closing_cta not set at campaign level
    if not merged.get("closing_cta"):
        merged["closing_cta"] = pitch.get("call_to_action", "")

    return merged


def filter_for_llm(vars_dict: dict) -> dict:
    """Strip secret and system_env vars — these should NOT be in the LLM prompt."""
    return {
        k: v for k, v in vars_dict.items()
        if not k.startswith(SECRET_PREFIX) and not k.startswith(SYSTEM_ENV_PREFIX)
    }


def get_missing_required(campaign_vars: dict) -> list[str]:
    """Check which required campaign-level vars are missing."""
    missing = []
    for var_name, meta in CAMPAIGN_VARS.items():
        if meta["required"] and not campaign_vars.get(var_name):
            missing.append(f"{var_name} — {meta['description']}")
    return missing


def resolve_template(template_str: str, vars_dict: dict) -> str:
    """Replace double-brace placeholders in a template string.

    Handles both {{var_name}} (ElevenLabs format) and {var_name} (Python format).
    Missing vars are left as-is.
    """
    result = template_str
    for key, value in vars_dict.items():
        result = result.replace("{{" + key + "}}", str(value))
    return result
