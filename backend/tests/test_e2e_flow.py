"""End-to-end flow tests — verify the full user journey works.

Tests the complete flow without LLM calls:
1. Health check
2. Analyze endpoint (validates input)
3. State endpoint (returns data)
4. Admin stats endpoint
5. Phone verification endpoint
6. Pipeline state flow (save leads → score → save pitches → judge)
7. GDPR erasure
"""

import json
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient

# Reset DB for clean state
import db as _db
_db._conn = None

from server import app

client = TestClient(app)


class TestFullAPIFlow:
    """Test the complete API surface."""

    def test_01_health(self):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_02_state_empty(self):
        resp = client.get("/api/state")
        assert resp.status_code == 200
        data = resp.json()
        assert "business_analysis" in data

    def test_03_analyze_rejects_bad_url(self):
        resp = client.post("/api/analyze", json={"url": "http://localhost"})
        assert resp.status_code == 400

    def test_04_analyze_rejects_empty(self):
        resp = client.post("/api/analyze", json={"url": ""})
        assert resp.status_code == 400

    def test_05_chat_rejects_empty(self):
        resp = client.post("/api/chat", json={"message": ""})
        assert resp.status_code == 400

    def test_06_call_rejects_bad_phone(self):
        resp = client.post("/api/call", json={"agent_id": "test", "phone_number": "abc"})
        assert resp.status_code == 400

    def test_07_call_rejects_short_phone(self):
        resp = client.post("/api/call", json={"agent_id": "test", "phone_number": "+123"})
        assert resp.status_code == 400

    def test_08_agents_endpoint(self):
        resp = client.get("/api/agents")
        assert resp.status_code == 200
        data = resp.json()
        assert "agents" in data
        # Must NOT expose API keys
        assert "elevenlabs_api_key" not in data

    def test_09_voice_config(self):
        resp = client.post("/api/voice-config", json={
            "caller_name": "Test",
            "call_style": "professional",
        })
        assert resp.status_code == 200

    def test_10_preferences(self):
        resp = client.post("/api/preferences", json={
            "language": "English",
            "objective": "Book a demo",
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"

    def test_11_reset(self):
        resp = client.post("/api/reset")
        assert resp.status_code == 200
        assert resp.json()["status"] == "reset"

    def test_12_admin_stats(self):
        resp = client.get("/api/admin/stats")
        assert resp.status_code == 200
        data = resp.json()
        assert "campaigns" in data
        assert "leads" in data
        assert "pitches" in data
        assert "outreach" in data
        assert "agents" in data
        assert "recent_campaigns" in data
        assert "audit_log" in data

    def test_13_phone_status(self):
        resp = client.get("/api/phone/status")
        assert resp.status_code == 200

    def test_14_verified_numbers(self):
        resp = client.get("/api/phone/verified-numbers")
        assert resp.status_code == 200
        assert "numbers" in resp.json()

    def test_15_security_headers_present(self):
        resp = client.get("/health")
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"
        assert resp.headers.get("X-Frame-Options") == "DENY"
        assert "X-Request-Duration" in resp.headers

    def test_16_request_timing_header(self):
        resp = client.get("/api/state")
        duration = resp.headers.get("X-Request-Duration", "")
        assert duration.endswith("s")
        # Should be fast (< 1 second)
        assert float(duration.rstrip("s")) < 1.0


class TestPipelineDataFlow:
    """Test the data flow through tools without LLM calls."""

    def test_full_data_flow(self):
        """Simulate: save leads → score → save pitches → judge → verify state."""
        from agents.tools import pipeline_state, save_leads, score_leads, save_pitch, save_judged_pitches, get_pipeline_state

        # Reset state
        pipeline_state["business_analysis"] = {
            "business_name": "TestCorp",
            "city": "London",
            "country": "United Kingdom",
            "country_code": "GB",
            "language": "English",
            "language_code": "en",
            "services": ["AI consulting"],
            "ideal_customer_profile": {"industries": ["technology", "finance"]},
            "business_type": "local",
            "business_model": "b2b",
        }
        pipeline_state["campaign_id"] = None

        # Step 1: Save leads
        leads = [
            {"name": "Acme Corp", "phone": "+441234567890", "city": "London", "country": "United Kingdom", "industry": "technology", "source": "google_maps", "rating": 4.5, "reviews": 100},
            {"name": "Beta Inc", "phone": "+441234567891", "city": "Manchester", "industry": "finance", "source": "brave", "rating": 4.0, "reviews": 50},
            {"name": "No Phone Ltd", "city": "London", "industry": "technology", "source": "brave"},
        ]
        result = save_leads(json.dumps(leads))
        assert result["status"] == "success"
        assert result["count"] == 3

        # Step 2: Score leads
        result = score_leads("{}")
        assert result["status"] == "success"
        assert result["total_leads"] == 3
        # London leads should score higher (location match)
        scored = result["scored_leads"]
        london_scores = [s["lead_score"] for s in scored if "London" in str(s.get("city", ""))]
        other_scores = [s["lead_score"] for s in scored if "London" not in str(s.get("city", ""))]
        assert max(london_scores) >= max(other_scores) if other_scores else True

        # Step 3: Save pitches
        pitches = [
            {"lead_name": "Acme Corp", "contact_person": "John", "pitch_script": "Hi John...", "email_subject": "AI for Acme", "email_body": "<p>Hi John</p>", "language": "English"},
            {"lead_name": "Beta Inc", "contact_person": "", "pitch_script": "Hi Beta team...", "email_subject": "AI for Beta", "email_body": "<p>Hi</p>", "language": "English"},
        ]
        result = save_pitch(json.dumps(pitches))
        assert result["status"] == "success"
        assert result["count"] == 2

        # Step 4: Judge pitches
        judged = [
            {"lead_name": "Acme Corp", "score": 9, "phone_number": "+441234567890", "ready_to_call": True, "ready_to_email": True, "feedback": "Excellent", "missing_info": []},
            {"lead_name": "Beta Inc", "score": 7, "phone_number": "+441234567891", "readyToCall": True, "feedback": "Good", "missing_info": []},
        ]
        result = save_judged_pitches(json.dumps(judged))
        assert result["status"] == "success"
        assert result["ready_to_call"] == 2

        # Step 5: Verify pipeline state has everything
        state = get_pipeline_state()
        assert state["status"] == "success"
        assert len(state["scored_leads"]) == 3
        assert state["pitches_count"] == 2
        assert state["judged_pitches_count"] == 2

    def test_b2c_business_no_location(self):
        """Online B2C business should not crash the scoring."""
        from agents.tools import pipeline_state, save_leads, score_leads

        pipeline_state["business_analysis"] = {
            "business_name": "EdTechCo",
            "city": "",
            "country": "",
            "country_code": "",
            "language": "English",
            "language_code": "en",
            "services": ["Online tutoring"],
            "ideal_customer_profile": {"industries": ["education", "edtech"]},
            "business_type": "online",
            "business_model": "b2c",
        }
        pipeline_state["campaign_id"] = None

        leads = [
            {"name": "Tutor Agency", "phone": "+15551234567", "city": "New York", "country": "US", "industry": "education", "source": "brave"},
        ]
        save_leads(json.dumps(leads))
        result = score_leads("{}")
        assert result["status"] == "success"
        assert result["total_leads"] == 1
        # Should not crash with empty city/country
        assert result["scored_leads"][0]["lead_score"] >= 0
