"""Business domain verification for LeadCall AI.

Prevents impersonation: users must prove they own/represent a domain
before they can send outreach from it.

Two verification methods:
1. DNS TXT record: Add a TXT record with a token to the domain's DNS
2. Email verification: Send a code to admin@domain or postmaster@domain

This is critical for:
- Preventing brand impersonation
- Ensuring email deliverability (sending from verified domains)
- Building trust with prospects
- Complying with anti-spam regulations
"""

from __future__ import annotations

import logging
import os
import secrets
import string
from urllib.parse import urlparse
from typing import Optional

import httpx

from db import (
    create_domain_verification,
    verify_domain,
    is_domain_verified,
    get_verified_domains,
)

logger = logging.getLogger(__name__)

# Verification token prefix (makes it identifiable in DNS)
TOKEN_PREFIX = "leadcall-verify="


def generate_verification_token() -> str:
    """Generate a random verification token."""
    chars = string.ascii_lowercase + string.digits
    random_part = "".join(secrets.choice(chars) for _ in range(32))
    return f"{TOKEN_PREFIX}{random_part}"


def extract_domain_from_url(url: str) -> str:
    """Extract the root domain from a URL."""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    # Remove www. prefix
    if hostname.startswith("www."):
        hostname = hostname[4:]
    return hostname.lower()


def start_dns_verification(user_id: str, domain: str) -> dict:
    """Start DNS TXT record verification for a domain.

    Returns the token the user needs to add as a TXT record.
    """
    domain = domain.lower().strip()
    if not domain or "." not in domain:
        return {"status": "error", "error": "Invalid domain"}

    token = generate_verification_token()
    create_domain_verification(user_id, domain, "dns_txt", token)

    return {
        "status": "pending",
        "domain": domain,
        "method": "dns_txt",
        "instructions": f"Add a TXT record to {domain} with value: {token}",
        "token": token,
        "record_type": "TXT",
        "record_host": "@",
        "record_value": token,
    }


async def check_dns_verification(user_id: str, domain: str) -> dict:
    """Check if the DNS TXT record has been added.

    Uses Google DNS-over-HTTPS for reliable lookups.
    """
    from db import get_conn

    # Get the expected token
    conn = get_conn()
    row = conn.execute(
        "SELECT verification_token, verified FROM domain_verifications WHERE user_id=? AND domain=? AND method='dns_txt'",
        (user_id, domain),
    ).fetchone()

    if not row:
        return {"status": "error", "error": "No pending verification for this domain"}

    if row["verified"]:
        return {"status": "verified", "domain": domain}

    expected_token = row["verification_token"]

    try:
        # Query Google DNS for TXT records
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://dns.google/resolve",
                params={"name": domain, "type": "TXT"},
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()

        # Check TXT records for our token
        for answer in data.get("Answer", []):
            txt_value = answer.get("data", "").strip('"')
            if expected_token in txt_value:
                # Verified!
                verify_domain(user_id, domain)
                logger.info("Domain %s verified for user %s via DNS", domain, user_id)
                return {"status": "verified", "domain": domain}

        return {
            "status": "pending",
            "domain": domain,
            "message": f"TXT record not found yet. Expected: {expected_token}",
        }
    except Exception as e:
        logger.error("DNS verification check failed: %s", e)
        return {"status": "error", "error": "Could not check DNS records. Try again later."}


def start_email_verification(user_id: str, domain: str) -> dict:
    """Start email-based verification.

    Sends a verification code to admin@domain or postmaster@domain.
    """
    domain = domain.lower().strip()
    if not domain or "." not in domain:
        return {"status": "error", "error": "Invalid domain"}

    token = "".join(secrets.choice(string.digits) for _ in range(6))  # 6-digit code
    create_domain_verification(user_id, domain, "email", token)

    verification_email = f"admin@{domain}"

    # Send verification email via Resend
    resend_key = os.getenv("RESEND_API_KEY", "")
    if not resend_key:
        return {
            "status": "pending",
            "domain": domain,
            "method": "email",
            "message": f"Verification code: {token} (mock mode - no email sent)",
            "send_to": verification_email,
        }

    try:
        resp = httpx.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {resend_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": "verify@leadcall.ai",
                "to": [verification_email],
                "subject": f"LeadCall AI - Domain Verification Code: {token}",
                "html": f"""
                <h2>Domain Verification</h2>
                <p>Someone requested to verify ownership of <strong>{domain}</strong> on LeadCall AI.</p>
                <p>Your verification code is: <strong style="font-size: 24px;">{token}</strong></p>
                <p>If you did not request this, you can safely ignore this email.</p>
                """,
            },
            timeout=15,
        )
        resp.raise_for_status()

        return {
            "status": "pending",
            "domain": domain,
            "method": "email",
            "message": f"Verification code sent to {verification_email}",
            "send_to": verification_email,
        }
    except Exception as e:
        logger.error("Email verification send failed: %s", e)
        return {"status": "error", "error": "Could not send verification email."}


def confirm_email_verification(user_id: str, domain: str, code: str) -> dict:
    """Confirm email verification with the code."""
    from db import get_conn

    conn = get_conn()
    row = conn.execute(
        "SELECT verification_token, verified FROM domain_verifications WHERE user_id=? AND domain=? AND method='email'",
        (user_id, domain),
    ).fetchone()

    if not row:
        return {"status": "error", "error": "No pending verification"}

    if row["verified"]:
        return {"status": "verified", "domain": domain}

    if row["verification_token"] == code.strip():
        verify_domain(user_id, domain)
        logger.info("Domain %s verified for user %s via email", domain, user_id)
        return {"status": "verified", "domain": domain}

    return {"status": "error", "error": "Invalid verification code"}
