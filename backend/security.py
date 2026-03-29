"""Security utilities for LeadCall AI.

SSRF prevention, input validation, phone validation, rate limiting.
All user input MUST pass through these validators before use.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import time
from collections import defaultdict
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# ─── URL Validation (SSRF Prevention) ──────────────────────────────────────

# Blocked hostnames (cloud metadata, localhost, etc.)
_BLOCKED_HOSTS = frozenset({
    "localhost",
    "metadata.google.internal",
    "169.254.169.254",  # AWS/GCP/Azure metadata
    "metadata",
    "kubernetes.default.svc",
})

# Blocked TLDs/patterns
_BLOCKED_PATTERNS = frozenset({
    ".internal",
    ".local",
    ".localhost",
    ".svc",
})


def is_safe_url(url: str) -> bool:
    """Validate a URL is safe to crawl (no SSRF).

    Blocks: private IPs, localhost, cloud metadata endpoints, non-HTTP schemes,
    file:// URLs, and internal hostnames.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    # Only allow HTTP(S)
    if parsed.scheme not in ("http", "https"):
        return False

    hostname = (parsed.hostname or "").lower().strip()
    if not hostname:
        return False

    # Block known dangerous hosts
    if hostname in _BLOCKED_HOSTS:
        return False

    # Block internal TLDs
    if any(hostname.endswith(pat) for pat in _BLOCKED_PATTERNS):
        return False

    # Block private/loopback IPs
    try:
        ip = ipaddress.ip_address(hostname)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return False
    except ValueError:
        pass  # Not an IP, it's a hostname — that's fine

    # Block IPs in hostname that resolve to private ranges
    # (covers cases like http://127.0.0.1, http://0.0.0.0, http://[::1])
    if hostname.startswith("[") and hostname.endswith("]"):
        # IPv6 in brackets
        try:
            ip = ipaddress.ip_address(hostname[1:-1])
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                return False
        except ValueError:
            pass

    return True


# ─── Phone Number Validation ───────────────────────────────────────────────

# E.164 format: + followed by 1-15 digits
_E164_PATTERN = re.compile(r"^\+[1-9]\d{6,14}$")

# Blocked number prefixes (emergency, premium rate, etc.)
_BLOCKED_PREFIXES = frozenset({
    "+112",   # EU emergency
    "+911",   # US emergency
    "+999",   # UK emergency
    "+190",   # Premium rate (various)
    "+1900",  # US premium rate
})


def validate_phone_number(phone: str) -> bool:
    """Validate phone number is E.164 format and not a blocked number."""
    phone = phone.strip()

    if not _E164_PATTERN.match(phone):
        return False

    # Block emergency and premium numbers
    for prefix in _BLOCKED_PREFIXES:
        if phone.startswith(prefix):
            return False

    return True


def sanitize_phone_for_log(phone: str) -> str:
    """Redact phone number for logging (show country code + last 2 digits)."""
    if len(phone) > 5:
        return phone[:3] + "***" + phone[-2:]
    return "***"


# ─── Input Sanitization ───────────────────────────────────────────────────

# Max sizes for different input types
MAX_URL_LENGTH = 2048
MAX_CHAT_MESSAGE_LENGTH = 10000
MAX_JSON_BODY_LENGTH = 50000


def sanitize_url(url: str) -> Optional[str]:
    """Validate and normalize a URL for crawling."""
    url = url.strip()

    if len(url) > MAX_URL_LENGTH:
        return None

    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    if not is_safe_url(url):
        logger.warning("Blocked unsafe URL: %s", url[:100])
        return None

    return url


def sanitize_chat_message(message: str) -> Optional[str]:
    """Validate and limit chat message length."""
    if not message or not message.strip():
        return None

    message = message.strip()
    if len(message) > MAX_CHAT_MESSAGE_LENGTH:
        return message[:MAX_CHAT_MESSAGE_LENGTH]

    return message


# ─── Rate Limiting ─────────────────────────────────────────────────────────

class RateLimiter:
    """Simple in-memory token bucket rate limiter.

    For production, replace with Redis-backed limiter.
    """

    def __init__(self):
        # {key: [(timestamp, count)]}
        self._buckets: dict[str, list[float]] = defaultdict(list)

    def is_allowed(self, key: str, max_requests: int, window_seconds: int) -> bool:
        """Check if a request is allowed under the rate limit.

        Args:
            key: Identifier (e.g., IP address, user ID)
            max_requests: Maximum requests allowed in the window
            window_seconds: Time window in seconds
        """
        now = time.monotonic()
        cutoff = now - window_seconds

        # Remove expired entries
        bucket = self._buckets[key]
        self._buckets[key] = [t for t in bucket if t > cutoff]

        if len(self._buckets[key]) >= max_requests:
            return False

        self._buckets[key].append(now)
        return True


# Global rate limiter instance
rate_limiter = RateLimiter()


# Rate limit presets (requests, window_seconds)
RATE_LIMITS = {
    "analyze": (5, 60),      # 5 per minute
    "chat": (30, 60),        # 30 per minute
    "state": (60, 60),       # 60 per minute
    "call": (3, 60),         # 3 per minute
    "voice_config": (10, 60),  # 10 per minute
    "reset": (3, 60),        # 3 per minute
    "default": (30, 60),     # 30 per minute
}


def check_rate_limit(client_ip: str, endpoint: str) -> bool:
    """Check if request is within rate limits."""
    max_req, window = RATE_LIMITS.get(endpoint, RATE_LIMITS["default"])
    return rate_limiter.is_allowed(f"{client_ip}:{endpoint}", max_req, window)


# ─── Security Headers ─────────────────────────────────────────────────────

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.elevenlabs.io https://*.supabase.co;",
}
