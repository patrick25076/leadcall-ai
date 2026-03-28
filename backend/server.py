"""LeadCall AI — FastAPI Server with SSE streaming for agent events."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

load_dotenv()

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
from db import get_conn


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
    print("LeadCall AI Server starting...")
    get_conn()  # Initialize DB on startup
    yield
    print("LeadCall AI Server shutting down...")
    await runner.close()
    await live_runner.close()


app = FastAPI(title="LeadCall AI", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Models ──────────���───────────────────────���───────────────────────────────

class AnalyzeRequest(BaseModel):
    url: str
    session_id: Optional[str] = None


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None


class CallRequest(BaseModel):
    agent_id: str
    phone_number: str


# ─── Helpers ──────────────────────────────────���──────────────────────────────

async def get_or_create_session(session_id: Optional[str] = None) -> str:
    """Creates an ADK session via the runner's session service. Returns session_id."""
    if session_id and session_id in _registered_sessions:
        return session_id

    # Try to reuse the provided session_id, but if it fails create a fresh one
    if session_id:
        try:
            session = await runner.session_service.create_session(
                app_name=runner.app_name,
                user_id=USER_ID,
                session_id=session_id,
            )
            _registered_sessions.add(session.id)
            return session.id
        except Exception:
            # Session ID conflict or invalid — create a brand new session
            pass

    session = await runner.session_service.create_session(
        app_name=runner.app_name,
        user_id=USER_ID,
    )
    _registered_sessions.add(session.id)
    return session.id


MAX_RETRIES = 5
INITIAL_BACKOFF = 2  # seconds


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
    """Check if an exception is a 429 / RESOURCE_EXHAUSTED error."""
    msg = str(exc).lower()
    return "429" in msg or "resource_exhausted" in msg or "resource exhausted" in msg


async def stream_agent_events(
    session_id: str, message: str
) -> AsyncGenerator[dict, None]:
    """Runs the agent and yields SSE-formatted event dicts.

    Implements exponential backoff retry on 429 RESOURCE_EXHAUSTED errors.
    """
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
            # Stream completed successfully
            return
        except Exception as exc:
            if _is_rate_limit_error(exc) and retries < MAX_RETRIES:
                retries += 1
                wait = INITIAL_BACKOFF * (2 ** (retries - 1))  # 2, 4, 8, 16, 32s
                print(f"[429] Rate limited, retry {retries}/{MAX_RETRIES} in {wait}s...")
                yield {
                    "type": "text",
                    "author": "system",
                    "timestamp": "",
                    "content": f"Rate limited by Gemini API. Retrying in {wait}s... (attempt {retries}/{MAX_RETRIES})",
                }
                await asyncio.sleep(wait)
                continue
            else:
                raise


# ─── Endpoints ────────────���─────────────────────────────���────────────────────

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "agents": [
            "website_analyzer", "lead_finder", "lead_scorer",
            "pitch_generator", "pitch_judge",
            "voice_config_agent", "call_manager", "preferences_agent",
        ],
    }


@app.post("/api/analyze")
async def analyze_website(req: AnalyzeRequest):
    """Starts the analysis pipeline for a URL. Returns SSE stream."""
    try:
        session_id = await get_or_create_session(req.session_id)
    except Exception:
        session_id = await get_or_create_session(None)
    message = f"Analyze this business website and run the full pipeline: {req.url}"

    async def event_generator():
        yield {"event": "session", "data": json.dumps({"session_id": session_id})}
        try:
            async for event_data in stream_agent_events(session_id, message):
                yield {"event": "agent", "data": json.dumps(event_data, default=str)}
        except Exception as e:
            yield {
                "event": "agent",
                "data": json.dumps({
                    "type": "text",
                    "author": "system",
                    "timestamp": "",
                    "content": f"Pipeline error: {str(e)}",
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
    try:
        session_id = await get_or_create_session(req.session_id)
    except Exception:
        # If session creation fails completely, create a fresh one
        session_id = await get_or_create_session(None)

    async def event_generator():
        yield {"event": "session", "data": json.dumps({"session_id": session_id})}
        try:
            async for event_data in stream_agent_events(session_id, req.message):
                yield {"event": "agent", "data": json.dumps(event_data, default=str)}
        except Exception as e:
            yield {
                "event": "agent",
                "data": json.dumps({
                    "type": "text",
                    "author": "system",
                    "timestamp": "",
                    "content": f"Session error: {str(e)}. Please try again or reset the pipeline.",
                }),
            }

    return EventSourceResponse(event_generator(), ping=5)


@app.get("/api/state")
async def get_state():
    """Returns the current pipeline state."""
    return pipeline_state


@app.post("/api/call")
async def initiate_call(req: CallRequest):
    """Initiates an outbound call (direct, no agent routing)."""
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


# ─── Twilio Webhook Endpoints ─────────────���─────────────────────────────────

@app.api_route("/twilio/outbound-ws", methods=["GET", "POST"])
async def twilio_outbound_handler(request):
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
    except Exception:
        return Response(
            content='<Response><Say>Connection error. Please try again later.</Say><Hangup/></Response>',
            media_type="application/xml",
        )


@app.post("/twilio/status")
async def twilio_status_callback(request):
    """Receives call status updates from Twilio."""
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
    print(f"[Voice WS] Connected: session={session_id}")

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

                # Binary frame = raw PCM audio
                if "bytes" in raw and raw["bytes"]:
                    audio_blob = genai_types.Blob(
                        mime_type="audio/pcm;rate=16000",
                        data=raw["bytes"],
                    )
                    live_request_queue.send_realtime(audio_blob)

                # Text frame = JSON message
                elif "text" in raw and raw["text"]:
                    msg = json.loads(raw["text"])
                    if msg.get("type") == "audio":
                        # Base64-encoded PCM audio
                        audio_data = base64.b64decode(msg["data"])
                        audio_blob = genai_types.Blob(
                            mime_type="audio/pcm;rate=16000",
                            data=audio_data,
                        )
                        live_request_queue.send_realtime(audio_blob)
                    elif msg.get("type") == "text":
                        # Text input
                        content = genai_types.Content(
                            parts=[genai_types.Part(text=msg["text"])]
                        )
                        live_request_queue.send_content(content)
                    elif msg.get("type") == "close":
                        break
        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"[Voice WS] Upstream error: {e}")

    async def downstream_task():
        """Receive events from run_live() → send to WebSocket client."""
        try:
            async for event in live_runner.run_live(
                user_id=user_id,
                session_id=session_id,
                live_request_queue=live_request_queue,
                run_config=run_config,
            ):
                # Extract useful data from event
                if not event.content or not event.content.parts:
                    # Check for turn_complete or other signals
                    if event.is_final_response():
                        await websocket.send_text(json.dumps({"type": "turn_complete"}))
                    continue

                for part in event.content.parts:
                    # Audio response
                    if hasattr(part, "inline_data") and part.inline_data:
                        audio_b64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                        await websocket.send_text(json.dumps({
                            "type": "audio",
                            "data": audio_b64,
                            "mime_type": part.inline_data.mime_type or "audio/pcm;rate=24000",
                        }))

                    # Text response (transcription or text output)
                    elif hasattr(part, "text") and part.text:
                        await websocket.send_text(json.dumps({
                            "type": "transcript",
                            "text": part.text,
                            "author": getattr(event, "author", "voice_config_agent"),
                        }))

                    # Function calls (tool use)
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
            print(f"[Voice WS] Downstream error: {e}")
            try:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": str(e),
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
        print(f"[Voice WS] Disconnected: session={session_id}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
