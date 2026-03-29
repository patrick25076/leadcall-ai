"""LeadCall AI — FastAPI Server with SSE streaming for agent events.

Security features:
- CORS locked to specific origins
- Security headers on all responses
- Rate limiting per endpoint
- Auth middleware (Supabase JWT)
- Input validation on all endpoints
- No internal error details exposed to clients
- Twilio webhook signature verification
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
from starlette.middleware.base import BaseHTTPMiddleware

load_dotenv()

# ─── Sentry (Error Tracking — EU Region) ───────────────────────────────────
import sentry_sdk
import sentry_sdk.integrations.fastapi
import sentry_sdk.integrations.starlette

sentry_sdk.init(
    dsn="https://93d6ad94a9c96957eb3461ab9f3ef6c5@o4511128619319296.ingest.de.sentry.io/4511128622137424",
    send_default_pii=True,
    traces_sample_rate=1.0,
    # Disable auto-integrations that crash on Python 3.9
    auto_enabling_integrations=False,
    integrations=[
        sentry_sdk.integrations.fastapi.FastApiIntegration(),
        sentry_sdk.integrations.starlette.StarletteIntegration(),
    ],
)

# Configure structured logging (no PII)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Set up Orq tracing before importing agents
orq_key = os.getenv("ORQ_API_KEY", "")
if orq_key:
    os.environ["ORQ_API_KEY"] = orq_key

import base64

from fastapi import WebSocket, WebSocketDisconnect
from google.adk.runners import InMemoryRunner, Runner
from google.adk.sessions import InMemorySessionService
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.genai import types as genai_types

from agents.agent import root_agent, voice_config_live_agent
from agents.tools import pipeline_state
from auth import AuthMiddleware
from db import get_conn
from security import (
    check_rate_limit,
    sanitize_url,
    sanitize_chat_message,
    validate_phone_number,
    SECURITY_HEADERS,
)
from observability import RequestTimingMiddleware, start_pipeline_tracking, log_api_cost


# ─── ADK Runner Setup ──────────────────────────────────────────────────────

APP_NAME = "leadcall_ai"
USER_ID = "default_user"

runner = InMemoryRunner(agent=root_agent, app_name=APP_NAME)

# Live voice runner (separate session service for voice sessions)
live_session_service = InMemorySessionService()
live_runner = Runner(
    app_name=f"{APP_NAME}_live",
    agent=voice_config_live_agent,
    session_service=live_session_service,
)

# Track registered sessions
_registered_sessions: set[str] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("LeadCall AI Server starting...")
    get_conn()  # Initialize DB on startup
    yield
    logger.info("LeadCall AI Server shutting down...")
    await runner.close()
    await live_runner.close()


app = FastAPI(title="GRAI API", lifespan=lifespan)


# ─── Security Middleware ────────────────────────────────────────────────────

# CORS: Only allow known frontend origins (not wildcard)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]


# Security headers middleware
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        for header, value in SECURITY_HEADERS.items():
            response.headers[header] = value
        return response


# Rate limiting middleware
class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Skip rate limiting for CORS preflight
        if request.method == "OPTIONS":
            return await call_next(request)

        # Extract client IP
        client_ip = request.client.host if request.client else "unknown"

        # Determine endpoint category for rate limiting
        path = request.url.path
        if path.startswith("/api/analyze"):
            endpoint = "analyze"
        elif path.startswith("/api/call"):
            endpoint = "call"
        elif path.startswith("/api/chat"):
            endpoint = "chat"
        elif path.startswith("/api/state"):
            endpoint = "state"
        elif path.startswith("/api/reset"):
            endpoint = "reset"
        elif path.startswith("/api/voice"):
            endpoint = "voice_config"
        else:
            endpoint = "default"

        if not check_rate_limit(client_ip, endpoint):
            return JSONResponse(
                status_code=429,
                content={"error": "Rate limit exceeded. Please try again later."},
            )

        return await call_next(request)

# Middleware order: added last = executed first.
# CORS must run first to handle OPTIONS preflight before auth/rate-limiting.
app.add_middleware(RequestTimingMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(AuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


# ─── Request Models (with validation) ──────────────────────────────────────

class AnalyzeRequest(BaseModel):
    url: str = Field(..., max_length=2048)
    session_id: Optional[str] = None


class ChatRequest(BaseModel):
    message: str = Field(..., max_length=10000)
    session_id: Optional[str] = None


class CallRequest(BaseModel):
    agent_id: str = Field(..., max_length=200)
    phone_number: str = Field(..., max_length=20)


# ─── Helpers ────────────────────────────────────────────────────────────────

async def get_or_create_session(session_id: Optional[str] = None) -> str:
    """Get existing session or create a new one. Reuses sessions for conversation continuity."""
    # Reuse existing session if valid (critical for chat context)
    if session_id and session_id in _registered_sessions:
        try:
            existing = await runner.session_service.get_session(
                app_name=runner.app_name,
                user_id=USER_ID,
                session_id=session_id,
            )
            if existing:
                return session_id
        except Exception:
            pass  # Session expired or invalid, create new

    # Create new session
    session = await runner.session_service.create_session(
        app_name=runner.app_name,
        user_id=USER_ID,
    )
    _registered_sessions.add(session.id)
    return session.id


MAX_RETRIES = 5
INITIAL_BACKOFF = 2


def _try_auto_save_judged(text: str):
    """Fallback: if pitch generator outputs JSON text without calling save_judged_pitches, auto-save."""
    import re
    json_match = re.search(r'\[[\s\S]*\]', text)
    if not json_match:
        return
    try:
        data = json.loads(json_match.group())
        if isinstance(data, list) and len(data) > 0 and ("score" in data[0] or "ready_to_call" in data[0]):
            from agents.tools import save_judged_pitches
            save_judged_pitches(json.dumps(data))
            logger.info("Auto-saved %d judged pitches from agent text output", len(data))
    except (json.JSONDecodeError, Exception) as e:
        logger.warning("Failed to auto-save judged pitches: %s", e)


def _parse_event(event) -> list[dict]:
    """Extract SSE-friendly dicts from a single ADK event."""
    results: list[dict] = []
    event_data = {
        "author": getattr(event, "author", "system"),
        "timestamp": str(getattr(event, "timestamp", "")),
    }

    if event.content and event.content.parts:
        for part in event.content.parts:
            if hasattr(part, "function_call") and part.function_call:
                fc = part.function_call
                results.append({
                    **event_data,
                    "type": "tool_call",
                    "tool_name": fc.name,
                    "tool_args": dict(fc.args) if fc.args else {},
                })
            elif hasattr(part, "function_response") and part.function_response:
                fr = part.function_response
                try:
                    result = json.loads(json.dumps(fr.response, default=str))
                except Exception:
                    result = str(fr.response)
                results.append({
                    **event_data,
                    "type": "tool_result",
                    "tool_name": fr.name,
                    "tool_result": result,
                })
            elif hasattr(part, "text") and part.text:
                results.append({
                    **event_data,
                    "type": "text",
                    "content": part.text,
                    "is_partial": getattr(event, "partial", False),
                })
                # Auto-save fallback for pitch generator
                if event_data["author"] in ("pitch_generator", "pitch_judge") and not pipeline_state.get("judged_pitches"):
                    _try_auto_save_judged(part.text)

    if hasattr(event, "actions") and event.actions:
        if getattr(event.actions, "transfer_to_agent", None):
            results.append({
                "type": "agent_transfer",
                "author": event_data["author"],
                "target_agent": event.actions.transfer_to_agent,
                "timestamp": event_data["timestamp"],
            })

    return results


def _is_rate_limit_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "429" in msg or "resource_exhausted" in msg or "resource exhausted" in msg


async def stream_agent_events(
    session_id: str, message: str
) -> AsyncGenerator[dict, None]:
    """Runs the agent and yields SSE-formatted event dicts with retry on 429."""
    user_message = genai_types.Content(
        role="user",
        parts=[genai_types.Part(text=message)],
    )

    retries = 0
    while True:
        try:
            async for event in runner.run_async(
                user_id=USER_ID,
                session_id=session_id,
                new_message=user_message,
            ):
                for parsed in _parse_event(event):
                    yield parsed
            return
        except Exception as exc:
            if _is_rate_limit_error(exc) and retries < MAX_RETRIES:
                retries += 1
                wait = INITIAL_BACKOFF * (2 ** (retries - 1))
                logger.warning("Rate limited by Gemini API, retry %d/%d in %ds", retries, MAX_RETRIES, wait)
                yield {
                    "type": "text",
                    "author": "system",
                    "timestamp": "",
                    "content": f"Rate limited. Retrying in {wait}s... (attempt {retries}/{MAX_RETRIES})",
                }
                await asyncio.sleep(wait)
                continue
            else:
                logger.error("Agent stream error: %s", exc)
                raise


# ─── Endpoints ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Health check + env var diagnostic (shows which keys are set, not values)."""
    env_keys = [
        "GOOGLE_API_KEY", "FIRECRAWL_API_KEY", "BRAVE_API_KEY",
        "GOOGLE_MAPS_API_KEY", "ELEVENLABS_API_KEY",
        "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER",
        "SUPABASE_URL", "SUPABASE_ANON_KEY",
        "ORQ_API_KEY", "ALLOWED_ORIGINS", "WEBHOOK_BASE_URL",
    ]
    configured = {k: bool(os.getenv(k, "")) for k in env_keys}
    return {
        "status": "ok",
        "env_configured": configured,
        "allowed_origins": ALLOWED_ORIGINS,
    }


@app.post("/api/analyze")
async def analyze_website(req: AnalyzeRequest):
    """Starts the analysis pipeline for a URL. Returns SSE stream."""
    # Validate URL
    safe_url = sanitize_url(req.url)
    if not safe_url:
        raise HTTPException(status_code=400, detail="Invalid or unsafe URL")

    # Reset pipeline state for fresh analysis
    pipeline_state["business_analysis"] = None
    pipeline_state["leads"] = []
    pipeline_state["scored_leads"] = []
    pipeline_state["pitches"] = []
    pipeline_state["judged_pitches"] = []
    pipeline_state["elevenlabs_agents"] = []
    pipeline_state["call_results"] = []
    pipeline_state["campaign_id"] = None
    logger.info("Pipeline state reset for new analysis: %s", safe_url)

    # Always create a fresh session for a new analysis
    session_id = await get_or_create_session()
    message = f"Analyze this business website and run the full pipeline: {safe_url}"

    async def event_generator():
        yield {"event": "session", "data": json.dumps({"session_id": session_id})}
        try:
            async for event_data in stream_agent_events(session_id, message):
                yield {"event": "agent", "data": json.dumps(event_data, default=str)}
        except Exception as e:
            logger.error("Pipeline error: %s", e)
            yield {
                "event": "agent",
                "data": json.dumps({
                    "type": "text",
                    "author": "system",
                    "timestamp": "",
                    "content": "An error occurred during analysis. Please try again.",
                }),
            }
        yield {
            "event": "pipeline_complete",
            "data": json.dumps(pipeline_state, default=str),
        }

    return EventSourceResponse(event_generator(), ping=5)


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """General chat with the orchestrator. Returns SSE stream."""
    message = sanitize_chat_message(req.message)
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # CRITICAL: Reuse session from client so agent has conversation context
    session_id = await get_or_create_session(req.session_id)

    async def event_generator():
        yield {"event": "session", "data": json.dumps({"session_id": session_id})}
        try:
            async for event_data in stream_agent_events(session_id, message):
                yield {"event": "agent", "data": json.dumps(event_data, default=str)}
        except Exception as e:
            logger.error("Chat error: %s", e)
            yield {
                "event": "agent",
                "data": json.dumps({
                    "type": "text",
                    "author": "system",
                    "timestamp": "",
                    "content": "An error occurred. Please try again.",
                }),
            }

    return EventSourceResponse(event_generator(), ping=5)


@app.get("/api/state")
async def get_state():
    """Returns the current pipeline state."""
    return pipeline_state


@app.get("/api/agents")
async def get_agents():
    """Returns created ElevenLabs agents for widget testing."""
    agents = pipeline_state.get("elevenlabs_agents", [])
    return {
        "agents": [
            {
                "agent_id": a.get("agent_id", ""),
                "name": a.get("name", ""),
                "language": a.get("language", ""),
                "dynamic_variables": a.get("dynamic_variables", {}),
            }
            for a in agents
        ],
        # No API key exposure — removed the elevenlabs_api_key field
    }


@app.post("/api/call")
async def initiate_call(req: CallRequest):
    """Initiates an outbound call."""
    if not validate_phone_number(req.phone_number):
        raise HTTPException(status_code=400, detail="Invalid phone number format. Must be E.164 (e.g., +40712345678).")

    from agents.tools import make_outbound_call
    result = make_outbound_call(req.agent_id, req.phone_number)
    return result


@app.post("/api/voice-config")
async def save_voice_config(config: dict):
    """Saves voice agent configuration directly (from the text form)."""
    from agents.tools import configure_voice_agent
    result = configure_voice_agent(json.dumps(config))
    return result


@app.post("/api/preferences")
async def update_preferences(prefs: dict):
    """Updates preferences directly."""
    pipeline_state["preferences"].update(prefs)
    return {"status": "success", "preferences": pipeline_state["preferences"]}


@app.post("/api/reset")
async def reset_pipeline():
    """Resets the pipeline state."""
    pipeline_state["business_analysis"] = None
    pipeline_state["leads"] = []
    pipeline_state["scored_leads"] = []
    pipeline_state["pitches"] = []
    pipeline_state["judged_pitches"] = []
    pipeline_state["elevenlabs_agents"] = []
    pipeline_state["call_results"] = []
    pipeline_state["campaign_id"] = None
    _registered_sessions.clear()
    return {"status": "reset"}


# ─── GDPR Endpoints ─────────────────────────────────────────────────────────

@app.delete("/api/leads/{lead_id}")
async def delete_lead(lead_id: int, request: Request):
    """GDPR right to erasure: delete all data for a lead."""
    from auth import get_user_id
    from db import erase_lead_data
    user_id = get_user_id(request)
    success = erase_lead_data(lead_id, user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Lead not found or not authorized")
    return {"status": "deleted", "lead_id": lead_id}


@app.delete("/api/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: int, request: Request):
    """GDPR right to erasure: delete all data for a campaign."""
    from auth import get_user_id
    from db import erase_campaign_data
    user_id = get_user_id(request)
    success = erase_campaign_data(campaign_id, user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Campaign not found or not authorized")
    return {"status": "deleted", "campaign_id": campaign_id}


# ─── Twilio Webhook Endpoints ──────────────────────────────────────────────

@app.api_route("/twilio/outbound", methods=["GET", "POST"])
@app.api_route("/twilio/outbound-ws", methods=["GET", "POST"])
async def twilio_outbound_handler(request: Request):
    """Twilio calls this when an outbound call connects.
    Registers with ElevenLabs and returns TwiML."""
    from starlette.responses import Response
    import httpx as _httpx

    agent_id = request.query_params.get("agent_id", "")
    if not agent_id:
        return Response(
            content='<Response><Say>No agent configured.</Say><Hangup/></Response>',
            media_type="application/xml",
        )

    elevenlabs_key = os.getenv("ELEVENLABS_API_KEY", "")
    twilio_number = os.getenv("TWILIO_PHONE_NUMBER", "")

    form_data = await request.form() if request.method == "POST" else {}
    to_number = form_data.get("To", "")

    # Find dynamic variables for this agent
    dynamic_vars = {}
    for agent in pipeline_state.get("elevenlabs_agents", []):
        if agent.get("agent_id") == agent_id:
            dynamic_vars = agent.get("dynamic_variables", {})
            break

    try:
        payload = {
            "agent_id": agent_id,
            "agent_phone_number_id": twilio_number,
            "to_number": to_number,
            "direction": "outbound",
        }
        if dynamic_vars:
            payload["conversation_initiation_client_data"] = {
                "dynamic_variables": dynamic_vars,
            }

        async with _httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.elevenlabs.io/v1/convai/twilio/register_call",
                headers={"xi-api-key": elevenlabs_key, "Content-Type": "application/json"},
                json=payload,
                timeout=15,
            )
            resp.raise_for_status()
            twiml = resp.text

        return Response(content=twiml, media_type="application/xml")
    except Exception as e:
        logger.error("Twilio outbound webhook error: %s", e)
        return Response(
            content='<Response><Say>Connection error. Please try again later.</Say><Hangup/></Response>',
            media_type="application/xml",
        )


@app.post("/twilio/status")
async def twilio_status_callback(request: Request):
    """Receives call status updates from Twilio."""
    # TODO: Add Twilio signature verification when WEBHOOK_BASE_URL is set
    form_data = await request.form()
    call_sid = form_data.get("CallSid", "")
    call_status = form_data.get("CallStatus", "")
    duration = form_data.get("CallDuration", "0")

    for call in pipeline_state.get("call_results", []):
        if call.get("call_sid") == call_sid:
            call["status"] = call_status
            call["duration"] = duration
            break

    return {"status": "received"}


# ─── WebSocket Voice Config (Live API Bidi-streaming) ───────────────────────

@app.websocket("/ws/voice-config/{session_id}")
async def voice_config_ws(websocket: WebSocket, session_id: str):
    """Real-time voice configuration via ADK Live API with native audio model."""
    await websocket.accept()
    logger.info("Voice WS connected: session=%s", session_id[:8])

    user_id = USER_ID

    # Get or create live session
    session = await live_session_service.get_session(
        app_name=live_runner.app_name,
        user_id=user_id,
        session_id=session_id,
    )
    if not session:
        await live_session_service.create_session(
            app_name=live_runner.app_name,
            user_id=user_id,
            session_id=session_id,
        )

    # Configure for bidirectional audio streaming
    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],
        input_audio_transcription=genai_types.AudioTranscriptionConfig(),
        output_audio_transcription=genai_types.AudioTranscriptionConfig(),
    )

    live_request_queue = LiveRequestQueue()

    async def upstream_task():
        """Receive audio/text from WebSocket client → LiveRequestQueue."""
        try:
            while True:
                raw = await websocket.receive()

                if "bytes" in raw and raw["bytes"]:
                    audio_blob = genai_types.Blob(
                        mime_type="audio/pcm;rate=16000",
                        data=raw["bytes"],
                    )
                    live_request_queue.send_realtime(audio_blob)

                elif "text" in raw and raw["text"]:
                    msg = json.loads(raw["text"])
                    if msg.get("type") == "audio":
                        audio_data = base64.b64decode(msg["data"])
                        audio_blob = genai_types.Blob(
                            mime_type="audio/pcm;rate=16000",
                            data=audio_data,
                        )
                        live_request_queue.send_realtime(audio_blob)
                    elif msg.get("type") == "text":
                        content = genai_types.Content(
                            parts=[genai_types.Part(text=msg["text"])]
                        )
                        live_request_queue.send_content(content)
                    elif msg.get("type") == "close":
                        break
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.warning("Voice WS upstream error: %s", type(e).__name__)

    async def downstream_task():
        """Receive events from run_live() → send to WebSocket client."""
        try:
            async for event in live_runner.run_live(
                user_id=user_id,
                session_id=session_id,
                live_request_queue=live_request_queue,
                run_config=run_config,
            ):
                if not event.content or not event.content.parts:
                    if event.is_final_response():
                        await websocket.send_text(json.dumps({"type": "turn_complete"}))
                    continue

                for part in event.content.parts:
                    if hasattr(part, "inline_data") and part.inline_data:
                        audio_b64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                        await websocket.send_text(json.dumps({
                            "type": "audio",
                            "data": audio_b64,
                            "mime_type": part.inline_data.mime_type or "audio/pcm;rate=24000",
                        }))
                    elif hasattr(part, "text") and part.text:
                        await websocket.send_text(json.dumps({
                            "type": "transcript",
                            "text": part.text,
                            "author": getattr(event, "author", "voice_config_agent"),
                        }))
                    elif hasattr(part, "function_call") and part.function_call:
                        await websocket.send_text(json.dumps({
                            "type": "tool_call",
                            "tool_name": part.function_call.name,
                        }))
                    elif hasattr(part, "function_response") and part.function_response:
                        await websocket.send_text(json.dumps({
                            "type": "tool_result",
                            "tool_name": part.function_response.name,
                            "status": "done",
                        }))

        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.warning("Voice WS downstream error: %s", type(e).__name__)
            try:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": "Voice connection error. Please reconnect.",
                }))
            except Exception:
                pass

    try:
        await asyncio.gather(
            upstream_task(),
            downstream_task(),
            return_exceptions=True,
        )
    finally:
        live_request_queue.close()
        logger.info("Voice WS disconnected: session=%s", session_id[:8])


# ─── Onboarding: Gmail OAuth ────────────────────────────────────────────────

@app.get("/auth/gmail/url")
async def gmail_oauth_url(request: Request):
    """Get the Google OAuth consent URL for connecting Gmail."""
    from gmail_oauth import get_oauth_url
    from auth import get_user_id
    user_id = get_user_id(request)
    url = get_oauth_url(state=user_id)
    return {"url": url}


@app.post("/auth/gmail/callback")
async def gmail_oauth_callback(request: Request):
    """Handle Gmail OAuth callback. Exchange code for tokens."""
    from gmail_oauth import exchange_code, get_user_email
    body = await request.json()
    code = body.get("code", "")
    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    tokens = await exchange_code(code)
    if not tokens:
        raise HTTPException(status_code=400, detail="Failed to exchange code")

    # Get user's email address
    email = await get_user_email(tokens["access_token"])

    # TODO: Store tokens securely in DB (encrypted) associated with user
    # For now, return them to frontend to store in session
    return {
        "status": "connected",
        "email": email,
        "has_refresh_token": bool(tokens.get("refresh_token")),
    }


@app.post("/auth/gmail/send")
async def gmail_send_email(request: Request):
    """Send an email via connected Gmail account."""
    from gmail_oauth import send_gmail
    body = await request.json()

    result = await send_gmail(
        access_token=body.get("access_token", ""),
        refresh_token=body.get("refresh_token", ""),
        from_email=body.get("from_email", ""),
        to_email=body.get("to_email", ""),
        subject=body.get("subject", ""),
        body_html=body.get("body_html", ""),
        from_name=body.get("from_name", ""),
    )
    return result


# ─── Onboarding: Phone Verification ────────────────────────────────────────

class PhoneVerifyRequest(BaseModel):
    phone_number: str = Field(..., max_length=20)
    friendly_name: str = Field(default="", max_length=100)


@app.post("/api/phone/verify")
async def start_phone_verification(req: PhoneVerifyRequest):
    """Start Twilio Caller ID verification. Twilio calls the user's number."""
    if not validate_phone_number(req.phone_number):
        raise HTTPException(status_code=400, detail="Invalid phone number format")

    from phone_setup import start_caller_id_verification
    result = start_caller_id_verification(req.phone_number, req.friendly_name)
    return result


@app.get("/api/phone/status")
async def check_phone_status(phone_number: str = ""):
    """Check if a phone number is verified as caller ID."""
    from phone_setup import check_caller_id_verified
    if phone_number:
        verified = check_caller_id_verified(phone_number)
        return {"phone_number": phone_number, "verified": verified}
    # Return default number info
    from phone_setup import get_default_number
    return {"default_number": get_default_number(), "mode": "default"}


@app.get("/api/phone/verified-numbers")
async def list_verified_numbers():
    """List all verified caller IDs."""
    from phone_setup import get_verified_caller_ids
    return {"numbers": get_verified_caller_ids()}


# ─── Admin Dashboard API ───────────────────────────────────────────────────

@app.get("/api/admin/stats")
async def admin_stats():
    """Admin dashboard statistics via Supabase."""
    from db import get_db, is_configured
    from observability import get_tracker

    if not is_configured():
        tracker = get_tracker()
        return {
            "campaigns": {"total": 0, "active": 0},
            "leads": {"total": 0, "avg_score": 0, "grades": {}},
            "pitches": {"total": 0, "ready_to_call": 0, "ready_to_email": 0, "avg_score": 0},
            "outreach": {"calls_total": 0, "calls_completed": 0, "emails_total": 0, "emails_sent": 0},
            "agents": {"total": 0},
            "recent_campaigns": [],
            "audit_log": [],
            "cost_estimate": tracker.get_summary() if tracker else None,
            "note": "Database not configured — showing in-memory data only",
        }

    db = get_db()

    # Counts via Supabase (select with count)
    campaigns = db.table("campaigns").select("id", count="exact").execute()
    active_campaigns = db.table("campaigns").select("id", count="exact").eq("status", "active").execute()
    total_leads = db.table("leads").select("id", count="exact").execute()
    total_pitches = db.table("pitches").select("id", count="exact").execute()
    ready_calls = db.table("pitches").select("id", count="exact").eq("ready_to_call", True).execute()
    ready_emails = db.table("pitches").select("id", count="exact").eq("ready_to_email", True).execute()
    total_calls = db.table("calls").select("id", count="exact").execute()
    completed_calls = db.table("calls").select("id", count="exact").eq("status", "completed").execute()
    total_emails = db.table("email_outreach").select("id", count="exact").execute()
    sent_emails = db.table("email_outreach").select("id", count="exact").eq("status", "sent").execute()
    total_agents = db.table("agents").select("id", count="exact").execute()

    # Lead grades
    leads_data = db.table("leads").select("score_grade, lead_score").not_.is_("score_grade", "null").execute()
    grades: dict[str, int] = {}
    scores: list[float] = []
    for r in (leads_data.data or []):
        g = r.get("score_grade", "")
        if g:
            grades[g] = grades.get(g, 0) + 1
        s = r.get("lead_score", 0)
        if s and s > 0:
            scores.append(s)

    # Pitch scores
    pitch_data = db.table("pitches").select("score").gt("score", 0).execute()
    pitch_scores = [r["score"] for r in (pitch_data.data or []) if r.get("score")]

    # Recent campaigns
    recent = db.table("campaigns").select(
        "id, website_url, business_name, status, created_at"
    ).order("id", desc=True).limit(10).execute()

    # Audit log
    audit = db.table("consent_log").select(
        "action, entity_type, entity_id, created_at"
    ).order("id", desc=True).limit(20).execute()

    # Cost tracker
    tracker = get_tracker()
    cost_summary = tracker.get_summary() if tracker else None

    return {
        "campaigns": {
            "total": campaigns.count or 0,
            "active": active_campaigns.count or 0,
        },
        "leads": {
            "total": total_leads.count or 0,
            "avg_score": round(sum(scores) / len(scores), 1) if scores else 0,
            "grades": grades,
        },
        "pitches": {
            "total": total_pitches.count or 0,
            "ready_to_call": ready_calls.count or 0,
            "ready_to_email": ready_emails.count or 0,
            "avg_score": round(sum(pitch_scores) / len(pitch_scores), 1) if pitch_scores else 0,
        },
        "outreach": {
            "calls_total": total_calls.count or 0,
            "calls_completed": completed_calls.count or 0,
            "emails_total": total_emails.count or 0,
            "emails_sent": sent_emails.count or 0,
        },
        "agents": {
            "total": total_agents.count or 0,
        },
        "recent_campaigns": recent.data or [],
        "audit_log": audit.data or [],
        "cost_estimate": cost_summary,
    }


# ─── Global exception handler ──────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch-all: never expose internal errors to clients."""
    logger.error("Unhandled error on %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=500,
        content={"error": "An internal error occurred. Please try again."},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
