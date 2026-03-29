"""Phone number setup for LeadCall AI.

Two modes:
1. Use default Twilio number (instant, for testing)
2. Verify user's own number as Outbound Caller ID (1-minute setup)

Twilio Verified Caller ID: calls SHOW the user's real business number
without porting. User just answers a verification call and enters a code.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)


def get_default_number() -> str:
    """Get the default Twilio number (our Dutch number)."""
    return os.getenv("TWILIO_PHONE_NUMBER", "")


def start_caller_id_verification(phone_number: str, friendly_name: str = "") -> dict:
    """Start Twilio Outbound Caller ID verification.

    Twilio will call the phone number. The user must answer and enter
    a 6-digit validation code.

    Args:
        phone_number: E.164 format (e.g., +40712345678)
        friendly_name: Label for this number (e.g., "IceTrust Main Line")

    Returns:
        dict with validation_code (6 digits the user must enter when Twilio calls)
    """
    twilio_sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    twilio_token = os.getenv("TWILIO_AUTH_TOKEN", "")

    if not twilio_sid or not twilio_token:
        return {
            "status": "success",
            "mode": "mock",
            "validation_code": "123456",
            "message": f"Mock: Twilio would call {phone_number}. Enter code 123456.",
        }

    try:
        from twilio.rest import Client as TwilioClient

        client = TwilioClient(twilio_sid, twilio_token)

        validation_request = client.validation_requests.create(
            friendly_name=friendly_name or phone_number,
            phone_number=phone_number,
        )

        return {
            "status": "success",
            "validation_code": validation_request.validation_code,
            "phone_number": phone_number,
            "message": f"Twilio is calling {phone_number} now. Answer and enter the code shown on screen.",
        }
    except Exception as e:
        logger.error("Caller ID verification failed: %s", e)
        return {"status": "error", "error": "Could not start phone verification. Please try again."}


def check_caller_id_verified(phone_number: str) -> bool:
    """Check if a phone number is verified as an outgoing caller ID."""
    twilio_sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    twilio_token = os.getenv("TWILIO_AUTH_TOKEN", "")

    if not twilio_sid or not twilio_token:
        return False

    try:
        from twilio.rest import Client as TwilioClient

        client = TwilioClient(twilio_sid, twilio_token)
        caller_ids = client.outgoing_caller_ids.list(phone_number=phone_number)
        return len(caller_ids) > 0
    except Exception as e:
        logger.error("Caller ID check failed: %s", e)
        return False


def get_verified_caller_ids() -> list[dict]:
    """List all verified outgoing caller IDs."""
    twilio_sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    twilio_token = os.getenv("TWILIO_AUTH_TOKEN", "")

    if not twilio_sid or not twilio_token:
        return []

    try:
        from twilio.rest import Client as TwilioClient

        client = TwilioClient(twilio_sid, twilio_token)
        caller_ids = client.outgoing_caller_ids.list(limit=20)
        return [
            {
                "phone_number": cid.phone_number,
                "friendly_name": cid.friendly_name,
                "sid": cid.sid,
            }
            for cid in caller_ids
        ]
    except Exception as e:
        logger.error("List caller IDs failed: %s", e)
        return []
