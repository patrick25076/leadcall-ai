"""Gmail OAuth integration for LeadCall AI.

Handles:
- OAuth flow (redirect → callback → token storage)
- Sending emails via Gmail API using user's own account
- Token refresh

Users click "Connect Gmail" → Google OAuth → done.
Emails sent FROM their own mailbox. Zero DNS setup needed.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:3000/auth/gmail/callback")

# Scopes: send emails + read user's email address
SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/userinfo.email",
]


def get_oauth_url(state: str = "") -> str:
    """Generate the Google OAuth consent URL.

    Args:
        state: Opaque state param (e.g., user_id) to verify on callback
    """
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",      # Get refresh token
        "prompt": "consent",           # Always show consent (ensures refresh token)
        "state": state,
    }
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"https://accounts.google.com/o/oauth2/v2/auth?{query}"


async def exchange_code(code: str) -> Optional[dict]:
    """Exchange authorization code for access + refresh tokens.

    Returns:
        dict with access_token, refresh_token, expires_in, token_type
        or None on failure
    """
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": code,
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "redirect_uri": GOOGLE_REDIRECT_URI,
                    "grant_type": "authorization_code",
                },
                timeout=15,
            )
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.error("Gmail OAuth token exchange failed: %s", e)
        return None


async def refresh_access_token(refresh_token: str) -> Optional[dict]:
    """Refresh an expired access token."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "refresh_token": refresh_token,
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "grant_type": "refresh_token",
                },
                timeout=15,
            )
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.error("Gmail token refresh failed: %s", e)
        return None


async def get_user_email(access_token: str) -> Optional[str]:
    """Get the user's email address from Google."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json().get("email")
    except Exception as e:
        logger.error("Failed to get Gmail user email: %s", e)
        return None


async def send_gmail(
    access_token: str,
    refresh_token: str,
    from_email: str,
    to_email: str,
    subject: str,
    body_html: str,
    from_name: str = "",
) -> dict:
    """Send an email via Gmail API using the user's own account.

    Args:
        access_token: Current Gmail access token
        refresh_token: Refresh token (used if access token expired)
        from_email: User's Gmail address
        to_email: Recipient email
        subject: Email subject
        body_html: HTML email body
        from_name: Display name (e.g., "Maria from IceTrust")

    Returns:
        dict with status, message_id
    """
    # Build MIME message
    msg = MIMEMultipart("alternative")
    msg["To"] = to_email
    msg["Subject"] = subject
    if from_name:
        msg["From"] = f"{from_name} <{from_email}>"
    else:
        msg["From"] = from_email

    msg.attach(MIMEText(body_html, "html"))

    # Encode for Gmail API
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")

    # Try sending
    for attempt in range(2):  # Retry once with refreshed token
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                    headers={
                        "Authorization": f"Bearer {access_token}",
                        "Content-Type": "application/json",
                    },
                    json={"raw": raw},
                    timeout=15,
                )

                if resp.status_code == 401 and attempt == 0:
                    # Token expired, refresh and retry
                    new_tokens = await refresh_access_token(refresh_token)
                    if new_tokens:
                        access_token = new_tokens["access_token"]
                        continue
                    return {"status": "error", "error": "Token expired and refresh failed"}

                resp.raise_for_status()
                data = resp.json()
                return {
                    "status": "success",
                    "message_id": data.get("id", ""),
                    "thread_id": data.get("threadId", ""),
                    "new_access_token": access_token,  # Return in case it was refreshed
                }
        except Exception as e:
            logger.error("Gmail send failed: %s", e)
            return {"status": "error", "error": "Failed to send email"}

    return {"status": "error", "error": "Failed after retry"}
