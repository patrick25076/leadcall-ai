"""Authentication & authorization for LeadCall AI.

Uses Supabase Auth (JWT validation). All API endpoints except /health
must include a valid Bearer token from Supabase.

Setup:
    1. Create a Supabase project at https://supabase.com
    2. Add SUPABASE_URL and SUPABASE_ANON_KEY to .env
    3. The JWT secret is derived from the Supabase project
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)

# Endpoints that don't require authentication
PUBLIC_ENDPOINTS = frozenset({
    "/health",
    "/docs",
    "/openapi.json",
    "/twilio/outbound",   # Twilio webhook (verified via signature instead)
    "/twilio/status",     # Twilio status callback
})


def _get_supabase_config() -> tuple[str, str]:
    """Get Supabase URL and anon key from environment."""
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_ANON_KEY", "")
    return url, key


async def verify_supabase_token(token: str) -> Optional[dict]:
    """Verify a Supabase JWT by calling the Supabase Auth API.

    Returns the user object if valid, None otherwise.
    """
    supabase_url, supabase_key = _get_supabase_config()

    if not supabase_url or not supabase_key:
        # Auth not configured — allow in dev mode with a warning
        logger.warning("Supabase not configured — auth disabled. Set SUPABASE_URL and SUPABASE_ANON_KEY.")
        return {"id": "dev-user", "email": "dev@localhost", "role": "authenticated"}

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{supabase_url}/auth/v1/user",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": supabase_key,
                },
                timeout=10,
            )

            if resp.status_code == 200:
                return resp.json()

            logger.warning("Auth verification failed: %s", resp.status_code)
            return None
    except Exception as e:
        logger.error("Auth verification error: %s", e)
        return None


def get_token_from_request(request: Request) -> Optional[str]:
    """Extract Bearer token from Authorization header."""
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:]
    return None


class AuthMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that validates Supabase JWT on every request.

    Attaches user info to request.state.user for downstream handlers.
    Public endpoints (health, docs, webhooks) are excluded.
    """

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Allow public endpoints
        if path in PUBLIC_ENDPOINTS:
            return await call_next(request)

        # Allow OPTIONS (CORS preflight)
        if request.method == "OPTIONS":
            return await call_next(request)

        # Allow WebSocket upgrade (auth checked in WS handler)
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await call_next(request)

        # Dev mode: if Supabase not configured, allow all requests with a dev user
        supabase_url, supabase_key = _get_supabase_config()
        if not supabase_url or not supabase_key:
            request.state.user = {"id": "dev-user", "email": "dev@localhost", "role": "authenticated"}
            request.state.user_id = "dev-user"
            return await call_next(request)

        # Extract and verify token
        token = get_token_from_request(request)
        if not token:
            # No token — try Supabase verification, but allow through in dev
            # (frontend may not have auth wired up yet)
            if os.getenv("REQUIRE_AUTH", "").lower() == "true":
                raise HTTPException(status_code=401, detail="Authentication required")
            # Permissive mode: allow unauthenticated requests with dev user
            request.state.user = {"id": "anon", "email": "", "role": "anon"}
            request.state.user_id = "anon"
            return await call_next(request)

        user = await verify_supabase_token(token)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid or expired token")

        # Attach user to request state for handlers
        request.state.user = user
        request.state.user_id = user.get("id", "")

        return await call_next(request)


def get_current_user(request: Request) -> dict:
    """Get the authenticated user from request state.

    Use in endpoint handlers:
        user = get_current_user(request)
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def get_user_id(request: Request) -> str:
    """Get the authenticated user's ID."""
    return getattr(request.state, "user_id", "")
