"""End-to-end tests for the outreach system — KB, dynamic vars, calling, batch.

Tests the complete outreach flow without external API calls:
1. KB creation and document upload
2. Dynamic variable system
3. Outbound call routing (ElevenLabs direct vs Twilio fallback)
4. Batch calling setup
5. Auto KB build from crawl data
6. Voice agent tool declarations
"""

import json
import os
import sys
import hashlib
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agents.tools import (
    pipeline_state,
    create_knowledge_base,
    upload_kb_document,
    attach_kb_to_agent,
    read_kb_documents,
    build_campaign_kb,
    create_elevenlabs_agent,
    make_outbound_call,
    submit_batch_calls,
    get_batch_call_status,
    save_business_analysis,
    configure_voice_agent,
    assess_voice_readiness,
    get_voice_agent_config,
)
from dynamic_vars import (
    build_call_vars,
    filter_for_llm,
    get_missing_required,
    SECRET_PREFIX,
    SYSTEM_ENV_PREFIX,
)


# ─── Fixtures ──────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def clean_pipeline_state():
    """Reset pipeline state before each test."""
    pipeline_state.clear()
    pipeline_state.update({
        "business_analysis": None,
        "leads": [],
        "scored_leads": [],
        "pitches": [],
        "judged_pitches": [],
        "preferences": {},
        "elevenlabs_agents": [],
        "call_results": [],
        "campaign_id": None,
        "user_id": "",
        "crawl_data": {},
        "el_kb_id": "",
        "dynamic_vars": {},
    })
    yield


@pytest.fixture
def populated_pipeline():
    """Pipeline state with analysis, leads, and pitches."""
    pipeline_state["business_analysis"] = {
        "business_name": "Ice Trust",
        "website_url": "https://icetrust.ro",
        "services": ["Ice delivery", "Cold storage", "Refrigeration"],
        "pricing_info": "Starting from 50 RON/delivery",
        "ideal_customer_profile": {
            "industries": ["restaurants", "hotels", "events"],
        },
        "location": "Bucharest, Romania",
        "city": "Bucharest",
        "country": "Romania",
        "country_code": "RO",
        "industry": "Cold chain logistics",
        "key_differentiators": ["24h delivery", "Own fleet"],
        "language": "Romanian",
        "language_code": "ro",
        "business_type": "local",
        "business_model": "b2b",
        "summary": "Ice delivery company in Bucharest.",
    }
    pipeline_state["crawl_data"] = {
        "pages": [
            {"url": "https://icetrust.ro", "title": "Ice Trust", "content": "We deliver ice across Bucharest. Premium quality."},
            {"url": "https://icetrust.ro/servicii", "title": "Servicii", "content": "Livrare gheata, depozitare frigorifica, events."},
        ],
        "total_content": "We deliver ice across Bucharest. Premium quality.\n\nLivrare gheata, depozitare frigorifica, events.",
    }
    pipeline_state["scored_leads"] = [
        {"name": "Restaurant Caru cu Bere", "phone": "+40721234567", "email": "contact@caru.ro",
         "contact_person": "Ion Popescu", "industry": "restaurants", "lead_score": 85},
        {"name": "Hotel Intercontinental", "phone": "+40722345678", "email": "",
         "contact_person": "Maria Ionescu", "industry": "hotels", "lead_score": 78},
    ]
    pipeline_state["judged_pitches"] = [
        {"lead_name": "Restaurant Caru cu Bere", "contact_person": "Ion Popescu",
         "phone_number": "+40721234567", "pitch_script": "Buna ziua, sunt de la Ice Trust...",
         "email_subject": "Parteneriat livrare gheata", "score": 9,
         "ready_to_call": True, "ready_to_email": True, "key_value_proposition": "Livrare in 2 ore"},
        {"lead_name": "Hotel Intercontinental", "contact_person": "Maria Ionescu",
         "phone_number": "+40722345678", "pitch_script": "Buna ziua, va contactam de la Ice Trust...",
         "score": 8, "ready_to_call": True, "ready_to_email": False},
    ]
    pipeline_state["campaign_id"] = 1
    return pipeline_state


# ═══════════════════════════════════════════════════════════════════════════
# 1. DYNAMIC VARIABLES SYSTEM
# ═══════════════════════════════════════════════════════════════════════════

class TestDynamicVars:
    """Test the dynamic variable system."""

    def test_build_call_vars_merges_campaign_and_lead(self):
        campaign_vars = {
            "caller_name": "Ana",
            "company_name": "Ice Trust",
            "objective": "book_demo",
            "call_style": "professional",
        }
        lead = {
            "name": "Restaurant Caru",
            "phone": "+40721234567",
            "email": "contact@caru.ro",
            "contact_person": "Ion Popescu",
            "industry": "restaurants",
            "relevance_reason": "High volume ice buyer",
        }
        pitch = {
            "pitch_script": "Buna ziua, sunt Ana de la Ice Trust...",
            "email_subject": "Parteneriat livrare",
            "key_value_proposition": "Livrare in 2 ore",
            "call_to_action": "15 minute meeting?",
        }

        result = build_call_vars(campaign_vars, lead, pitch)

        assert result["caller_name"] == "Ana"
        assert result["company_name"] == "Ice Trust"
        assert result["objective"] == "book_demo"
        assert result["lead_name"] == "Restaurant Caru"
        assert result["contact_person"] == "Ion Popescu"
        assert result["phone"] == "+40721234567"
        assert result["pitch_script"] == "Buna ziua, sunt Ana de la Ice Trust..."
        assert result["closing_cta"] == "15 minute meeting?"

    def test_build_call_vars_uses_lead_name_as_contact_fallback(self):
        result = build_call_vars(
            {"caller_name": "Ana"},
            {"name": "Acme Corp", "contact_person": ""},
            {},
        )
        assert result["contact_person"] == "Acme Corp"

    def test_filter_for_llm_strips_secrets(self):
        vars_dict = {
            "caller_name": "Ana",
            "secret__crm_token": "abc123",
            "system_env__booking_url": "https://book.me",
            "lead_name": "Test",
        }
        filtered = filter_for_llm(vars_dict)
        assert "caller_name" in filtered
        assert "lead_name" in filtered
        assert "secret__crm_token" not in filtered
        assert "system_env__booking_url" not in filtered

    def test_get_missing_required(self):
        # Missing both required fields
        missing = get_missing_required({})
        assert len(missing) == 2
        assert any("caller_name" in m for m in missing)
        assert any("objective" in m for m in missing)

        # Has caller_name, missing objective
        missing = get_missing_required({"caller_name": "Ana"})
        assert len(missing) == 1
        assert "objective" in missing[0]

        # Has both
        missing = get_missing_required({"caller_name": "Ana", "objective": "book_demo"})
        assert len(missing) == 0


# ═══════════════════════════════════════════════════════════════════════════
# 2. KNOWLEDGE BASE TOOLS
# ═══════════════════════════════════════════════════════════════════════════

class TestKnowledgeBase:
    """Test KB creation, upload, and attachment."""

    def test_create_kb_no_api_key(self):
        result = create_knowledge_base(1, "Test KB")
        assert result["status"] == "error"
        assert "ELEVENLABS_API_KEY" in result["error"]

    @patch("agents.tools.httpx.post")
    @patch("agents.tools.db.update_campaign_kb_id")
    @patch("agents.tools.db.get_campaign_kb_id", return_value="")
    def test_create_kb_success(self, mock_get_kb, mock_update, mock_post, populated_pipeline):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"id": "kb_test123"}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        result = create_knowledge_base(1, "Ice Trust KB")

        assert result["status"] == "success"
        assert result["kb_id"] == "kb_test123"
        mock_post.assert_called_once()
        call_args = mock_post.call_args
        assert "knowledge-bases" in call_args[0][0]
        os.environ["ELEVENLABS_API_KEY"] = ""

    @patch("agents.tools.db.get_campaign_kb_id", return_value="kb_existing")
    def test_create_kb_already_exists(self, mock_get_kb, populated_pipeline):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        result = create_knowledge_base(1, "Test KB")
        assert result["status"] == "exists"
        assert result["kb_id"] == "kb_existing"
        os.environ["ELEVENLABS_API_KEY"] = ""

    def test_upload_kb_document_empty_content(self):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        result = upload_kb_document("kb_123", "services", "")
        assert result["status"] == "skipped"
        os.environ["ELEVENLABS_API_KEY"] = ""

    @patch("agents.tools.httpx.post")
    @patch("agents.tools.db.save_kb_document", return_value=1)
    @patch("agents.tools.db.get_kb_total_chars", return_value=0)
    def test_upload_kb_document_success(self, mock_chars, mock_save, mock_post):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"id": "doc_abc123"}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        result = upload_kb_document("kb_123", "services", "Ice delivery service content", "services.txt", 1)

        assert result["status"] == "success"
        assert result["doc_id"] == "doc_abc123"
        assert result["chars_remaining"] < 300_000
        os.environ["ELEVENLABS_API_KEY"] = ""

    @patch("agents.tools.db.get_kb_total_chars", return_value=299_999)
    def test_upload_kb_document_limit_exceeded(self, mock_chars):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        result = upload_kb_document("kb_123", "full_crawl", "x" * 10000)
        # Should truncate to fit, only 1 char available
        assert result["status"] != "success" or result.get("chars_remaining", 0) == 0
        os.environ["ELEVENLABS_API_KEY"] = ""

    def test_read_kb_documents_empty(self):
        result = read_kb_documents(1)
        assert result["status"] == "success"
        assert result["total_docs"] == 0

    @patch("agents.tools.db.get_kb_documents")
    def test_read_kb_documents_returns_content(self, mock_docs):
        mock_docs.return_value = [
            {"doc_type": "services", "filename": "services.txt", "content_text": "Ice delivery", "char_count": 12, "el_kb_id": "kb_123"},
            {"doc_type": "pricing", "filename": "pricing.txt", "content_text": "50 RON/delivery", "char_count": 15, "el_kb_id": "kb_123"},
        ]
        result = read_kb_documents(1)
        assert result["total_docs"] == 2
        assert result["documents"][0]["content"] == "Ice delivery"
        assert result["kb_id"] == "kb_123"


# ═══════════════════════════════════════════════════════════════════════════
# 3. AUTO KB BUILD FROM CRAWL DATA
# ═══════════════════════════════════════════════════════════════════════════

class TestAutoBuildKB:
    """Test that KB auto-builds when save_business_analysis runs."""

    @patch("agents.tools.build_campaign_kb")
    def test_save_analysis_triggers_kb_build(self, mock_build, populated_pipeline):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        mock_build.return_value = {"status": "success", "kb_id": "kb_auto", "total_docs": 3}

        analysis = json.dumps(populated_pipeline["business_analysis"])
        result = save_business_analysis(analysis)

        assert result["status"] == "success"
        assert result.get("kb_id") == "kb_auto"
        assert result.get("kb_docs_uploaded") == 3
        mock_build.assert_called_once()
        os.environ["ELEVENLABS_API_KEY"] = ""

    def test_save_analysis_no_kb_without_api_key(self):
        os.environ["ELEVENLABS_API_KEY"] = ""
        pipeline_state["crawl_data"] = {"total_content": "test"}
        analysis = json.dumps({"business_name": "Test", "services": ["testing"]})
        result = save_business_analysis(analysis)
        assert result["status"] == "success"
        assert "kb_id" not in result  # No KB without API key

    @patch("agents.tools.create_knowledge_base")
    @patch("agents.tools.upload_kb_document")
    def test_build_campaign_kb_creates_docs(self, mock_upload, mock_create, populated_pipeline):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        mock_create.return_value = {"status": "success", "kb_id": "kb_built"}
        mock_upload.return_value = {"status": "success", "doc_id": "doc_1"}

        result = build_campaign_kb(1)

        assert result["status"] == "success"
        assert "services" in result["docs_uploaded"]
        assert "about" in result["docs_uploaded"]
        # Should upload services, pricing, about, and full_crawl
        assert mock_upload.call_count >= 3
        os.environ["ELEVENLABS_API_KEY"] = ""


# ═══════════════════════════════════════════════════════════════════════════
# 4. OUTBOUND CALLING
# ═══════════════════════════════════════════════════════════════════════════

class TestOutboundCalling:
    """Test outbound call routing."""

    def test_call_rejects_invalid_phone(self):
        result = make_outbound_call("agent_123", "not-a-phone")
        assert result["status"] == "error"
        assert "E.164" in result["error"]

    def test_call_mock_mode_no_keys(self):
        os.environ["ELEVENLABS_API_KEY"] = ""
        result = make_outbound_call("agent_123", "+40721234567")
        assert result["status"] in ("success", "mock_initiated")
        assert "+40721234567" in result["phone_number"]

    @patch("agents.tools.httpx.post")
    def test_call_elevenlabs_direct(self, mock_post, populated_pipeline):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        os.environ["ELEVENLABS_PHONE_NUMBER_ID"] = "phone_123"

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"conversation_id": "conv_abc", "callSid": "CA123"}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        result = make_outbound_call("agent_test", "+40721234567")

        assert result["status"] in ("success", "initiated")
        assert result["conversation_id"] == "conv_abc"
        # Verify correct endpoint called
        call_url = mock_post.call_args[0][0]
        assert "outbound-call" in call_url
        assert "register" not in call_url
        os.environ["ELEVENLABS_API_KEY"] = ""
        os.environ["ELEVENLABS_PHONE_NUMBER_ID"] = ""

    def test_call_no_phone_number_id_no_twilio(self):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        os.environ["ELEVENLABS_PHONE_NUMBER_ID"] = ""
        os.environ["TWILIO_ACCOUNT_SID"] = ""
        os.environ["WEBHOOK_BASE_URL"] = ""

        result = make_outbound_call("agent_123", "+40721234567")
        assert result["status"] == "error"
        assert "No calling method configured" in result["error"]
        os.environ["ELEVENLABS_API_KEY"] = ""

    def test_call_merges_dynamic_vars(self, populated_pipeline):
        os.environ["ELEVENLABS_API_KEY"] = ""  # Mock mode
        populated_pipeline["elevenlabs_agents"] = [
            {"agent_id": "agent_1", "dynamic_variables": {"caller_name": "Ana", "company": "Ice Trust"}},
        ]

        result = make_outbound_call(
            "agent_1", "+40721234567",
            json.dumps({"contact_person": "Ion"})
        )
        assert result["status"] in ("success", "mock_initiated")
        assert result["dynamic_variables"]["caller_name"] == "Ana"
        assert result["dynamic_variables"]["contact_person"] == "Ion"


# ═══════════════════════════════════════════════════════════════════════════
# 5. BATCH CALLING
# ═══════════════════════════════════════════════════════════════════════════

class TestBatchCalling:
    """Test batch calling setup and submission."""

    def test_batch_no_api_key(self):
        os.environ["ELEVENLABS_API_KEY"] = ""
        result = submit_batch_calls("agent_123")
        assert result["status"] == "error"

    def test_batch_no_phone_number_id(self):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        os.environ["ELEVENLABS_PHONE_NUMBER_ID"] = ""
        result = submit_batch_calls("agent_123")
        assert result["status"] == "error"
        assert "ELEVENLABS_PHONE_NUMBER_ID" in result["error"]
        os.environ["ELEVENLABS_API_KEY"] = ""

    def test_batch_auto_loads_from_pipeline(self, populated_pipeline):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        os.environ["ELEVENLABS_PHONE_NUMBER_ID"] = "phone_123"

        # Don't actually call the API
        with patch("agents.tools.httpx.post") as mock_post:
            mock_resp = MagicMock()
            mock_resp.json.return_value = {"id": "batch_123", "status": "pending", "total_calls_scheduled": 2}
            mock_resp.raise_for_status = MagicMock()
            mock_post.return_value = mock_resp

            result = submit_batch_calls("agent_test", "March Outreach")

            assert result["status"] == "success"
            assert result["batch_id"] == "batch_123"
            assert result["total_calls_scheduled"] == 2

            # Verify the API was called with correct recipients
            payload = json.loads(mock_post.call_args[1]["content"] if "content" in mock_post.call_args[1] else mock_post.call_args[1].get("data", "{}"))
            if not payload:
                payload = mock_post.call_args[1].get("json", {})
            assert len(payload.get("recipients", [])) == 2

        os.environ["ELEVENLABS_API_KEY"] = ""
        os.environ["ELEVENLABS_PHONE_NUMBER_ID"] = ""

    def test_batch_with_explicit_leads(self):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        os.environ["ELEVENLABS_PHONE_NUMBER_ID"] = "phone_123"

        leads = [
            {"phone_number": "+40721111111", "dynamic_variables": {"name": "Lead 1"}},
            {"phone_number": "+40722222222", "dynamic_variables": {"name": "Lead 2"}},
        ]

        with patch("agents.tools.httpx.post") as mock_post:
            mock_resp = MagicMock()
            mock_resp.json.return_value = {"id": "batch_456", "status": "pending", "total_calls_scheduled": 2}
            mock_resp.raise_for_status = MagicMock()
            mock_post.return_value = mock_resp

            result = submit_batch_calls("agent_test", "Test Batch", json.dumps(leads))

            assert result["status"] == "success"
            assert result["total_calls_scheduled"] == 2

        os.environ["ELEVENLABS_API_KEY"] = ""
        os.environ["ELEVENLABS_PHONE_NUMBER_ID"] = ""


# ═══════════════════════════════════════════════════════════════════════════
# 6. VOICE AGENT READINESS + CONFIG
# ═══════════════════════════════════════════════════════════════════════════

class TestVoiceAgentConfig:
    """Test voice readiness assessment and configuration."""

    def test_assess_readiness_empty_pipeline(self):
        result = assess_voice_readiness()
        assert result["status"] == "success"
        assert result["ready_to_create_agents"] is False
        assert len(result["missing_items"]) > 0

    def test_assess_readiness_with_data(self, populated_pipeline):
        populated_pipeline["preferences"]["caller_name"] = "Ana"
        result = assess_voice_readiness()
        assert result["status"] == "success"
        assert result["ready_to_create_agents"] is True
        assert result["checklist"]["ready_pitch_count"] >= 1

    def test_configure_voice_agent_saves(self, populated_pipeline):
        config = json.dumps({
            "caller_name": "Ana",
            "call_style": "professional",
            "objective": "book_demo",
            "closing_cta": "Can we schedule a demo?",
        })
        result = configure_voice_agent(config)
        assert result["status"] == "success"
        assert result["voice_config"]["caller_name"] == "Ana"
        assert pipeline_state["preferences"]["caller_name"] == "Ana"

    def test_get_voice_agent_config_returns_ready_leads(self, populated_pipeline):
        result = get_voice_agent_config()
        assert result["status"] == "success"
        assert len(result["ready_leads"]) >= 1
        # Check that phone numbers are present
        for lead in result["ready_leads"]:
            if lead.get("phone_number"):
                assert lead["phone_number"].startswith("+")


# ═══════════════════════════════════════════════════════════════════════════
# 7. ELEVENLABS AGENT CREATION WITH KB
# ═══════════════════════════════════════════════════════════════════════════

class TestAgentCreationWithKB:
    """Test that agents are created with KB attached."""

    def test_create_agent_mock_mode(self, populated_pipeline):
        os.environ["ELEVENLABS_API_KEY"] = ""
        result = create_elevenlabs_agent(
            agent_name="SDR for Test",
            first_message="Hi, this is Ana from Ice Trust",
            system_prompt="You are a professional SDR...",
            lead_name="Test Lead",
        )
        assert result["status"] == "success"
        assert "mock" in result.get("agent_id", "")
        assert len(pipeline_state["elevenlabs_agents"]) == 1

    @patch("agents.tools.attach_kb_to_agent")
    @patch("agents.tools.httpx.post")
    @patch("agents.tools.db.get_campaign_kb_id", return_value="kb_auto_attached")
    @patch("agents.tools.save_agent_db", return_value=1)
    def test_create_agent_auto_attaches_kb(self, mock_save, mock_get_kb, mock_post, mock_attach, populated_pipeline):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"agent_id": "agent_new_123"}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp
        mock_attach.return_value = {"status": "success"}

        result = create_elevenlabs_agent(
            agent_name="SDR for Caru",
            first_message="Buna ziua",
            system_prompt="You are a professional SDR...",
            lead_name="Restaurant Caru",
            language="ro",
        )

        assert result["status"] == "success"
        assert result["agent_id"] == "agent_new_123"
        # Verify KB was auto-attached
        mock_attach.assert_called_once_with("agent_new_123", "kb_auto_attached")
        os.environ["ELEVENLABS_API_KEY"] = ""


# ═══════════════════════════════════════════════════════════════════════════
# 8. API ENDPOINT TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestAPIEndpoints:
    """Test server API endpoints for calling and batch."""

    def setup_method(self):
        from fastapi.testclient import TestClient
        from server import app
        self.client = TestClient(app)

    def test_call_endpoint_validates_phone(self):
        resp = self.client.post("/api/call", json={
            "agent_id": "test",
            "phone_number": "invalid",
        })
        assert resp.status_code == 400

    def test_call_endpoint_valid_phone(self):
        resp = self.client.post("/api/call", json={
            "agent_id": "agent_test",
            "phone_number": "+40721234567",
        })
        # Should succeed (mock mode, no API keys)
        assert resp.status_code == 200

    def test_twilio_webhook_no_agent(self):
        resp = self.client.post("/twilio/outbound")
        assert resp.status_code == 200
        assert "No agent configured" in resp.text

    def test_twilio_status_callback(self):
        resp = self.client.post("/twilio/status", data={
            "CallSid": "CA_test_123",
            "CallStatus": "completed",
            "CallDuration": "45",
        })
        assert resp.status_code == 200

    def test_voices_endpoint(self):
        resp = self.client.get("/api/voices")
        assert resp.status_code == 200
        data = resp.json()
        assert "voices" in data


# ═══════════════════════════════════════════════════════════════════════════
# 9. VOICE WS TOOL DECLARATIONS
# ═══════════════════════════════════════════════════════════════════════════

class TestVoiceWSTools:
    """Test that voice WS tool declarations are properly built."""

    def test_tool_declarations_build(self):
        """All voice tools should generate valid function declarations."""
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

        # Import the builder from server
        from server import _build_voice_tool_declarations, _VOICE_TOOLS

        declarations = _build_voice_tool_declarations()
        assert len(declarations) >= 10  # At least 10 tools

        # Every tool in _VOICE_TOOLS should have a declaration
        tool_names = {d["name"] for d in declarations}
        for name in _VOICE_TOOLS:
            assert name in tool_names, f"Missing declaration for tool: {name}"

        # Each declaration should have required fields
        for decl in declarations:
            assert "name" in decl
            assert "description" in decl
            assert "parameters" in decl
            assert decl["parameters"]["type"] == "object"

    def test_all_voice_tools_are_callable(self):
        from server import _VOICE_TOOLS
        for name, fn in _VOICE_TOOLS.items():
            assert callable(fn), f"Tool {name} is not callable"
