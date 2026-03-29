"""Observability layer for GRAI.

Tracks:
- Pipeline run costs (tokens, API calls)
- Agent execution time per step
- External API failures
- User-attributed metrics

Uses Orq.ai for agent tracing + custom cost tracking middleware.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


# ─── Cost Tracking ─────────────────────────────────────────────────────────

# Approximate costs per API call (for tracking, not billing)
API_COSTS = {
    "gemini_2.5_flash_input": 0.00015,   # per 1K tokens
    "gemini_2.5_flash_output": 0.0006,    # per 1K tokens
    "google_maps_search": 0.017,          # per search
    "brave_search": 0.001,                # per query (estimate)
    "firecrawl_crawl": 0.10,              # per page
    "elevenlabs_agent_create": 0.0,       # free
    "elevenlabs_call_minute": 0.10,       # per minute
    "twilio_call_minute": 0.05,           # per minute
}


class PipelineRunTracker:
    """Tracks costs and metrics for a single pipeline run."""

    def __init__(self, user_id: str = "", campaign_id: int = 0):
        self.user_id = user_id
        self.campaign_id = campaign_id
        self.start_time = time.monotonic()
        self.api_calls: list[dict] = []
        self.total_tokens_in = 0
        self.total_tokens_out = 0
        self.errors: list[str] = []

    def log_api_call(self, service: str, tokens_in: int = 0, tokens_out: int = 0, cost: float = 0.0):
        """Log an individual API call."""
        self.api_calls.append({
            "service": service,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "cost": cost,
            "timestamp": time.monotonic(),
        })
        self.total_tokens_in += tokens_in
        self.total_tokens_out += tokens_out

    def log_error(self, error: str):
        self.errors.append(error)

    def get_summary(self) -> dict:
        """Get the cost and performance summary for this run."""
        elapsed = time.monotonic() - self.start_time
        total_cost = sum(c.get("cost", 0) for c in self.api_calls)

        # Estimate LLM cost from tokens
        llm_cost = (
            (self.total_tokens_in / 1000) * API_COSTS["gemini_2.5_flash_input"]
            + (self.total_tokens_out / 1000) * API_COSTS["gemini_2.5_flash_output"]
        )

        return {
            "user_id": self.user_id,
            "campaign_id": self.campaign_id,
            "duration_seconds": round(elapsed, 2),
            "total_api_calls": len(self.api_calls),
            "total_tokens_in": self.total_tokens_in,
            "total_tokens_out": self.total_tokens_out,
            "estimated_llm_cost_usd": round(llm_cost, 4),
            "estimated_api_cost_usd": round(total_cost, 4),
            "estimated_total_cost_usd": round(llm_cost + total_cost, 4),
            "errors": self.errors,
            "api_calls": self.api_calls,
        }


# Global tracker for current pipeline run (reset per request)
_current_tracker: Optional[PipelineRunTracker] = None


def start_pipeline_tracking(user_id: str = "", campaign_id: int = 0):
    """Start tracking a new pipeline run."""
    global _current_tracker
    _current_tracker = PipelineRunTracker(user_id, campaign_id)
    return _current_tracker


def get_tracker() -> Optional[PipelineRunTracker]:
    """Get the current pipeline run tracker."""
    return _current_tracker


def log_api_cost(service: str, tokens_in: int = 0, tokens_out: int = 0, extra_cost: float = 0.0):
    """Log an API call cost to the current tracker."""
    if _current_tracker:
        cost = extra_cost
        if service in API_COSTS and not extra_cost:
            cost = API_COSTS[service]
        _current_tracker.log_api_call(service, tokens_in, tokens_out, cost)


# ─── Request Timing Middleware ──────────────────────────────────────────────

class RequestTimingMiddleware(BaseHTTPMiddleware):
    """Logs request duration for all API calls."""

    async def dispatch(self, request: Request, call_next):
        start = time.monotonic()
        response = await call_next(request)
        duration = time.monotonic() - start

        # Log slow requests (> 5 seconds)
        if duration > 5.0:
            logger.warning(
                "Slow request: %s %s took %.2fs",
                request.method,
                request.url.path,
                duration,
            )

        response.headers["X-Request-Duration"] = f"{duration:.3f}s"
        return response
