"""Shared test fixtures for GRAI backend tests."""

import os
import sys

# MUST set env vars BEFORE any imports (Orq checks at import time)
os.environ["ORQ_API_KEY"] = "test-key-not-real"
os.environ["REQUIRE_AUTH"] = ""
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_ANON_KEY"] = ""
os.environ["BRAVE_API_KEY"] = ""
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["ELEVENLABS_API_KEY"] = ""
os.environ["TWILIO_ACCOUNT_SID"] = ""
os.environ["TWILIO_AUTH_TOKEN"] = ""

import tempfile
import pytest

# Add backend to path so imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Use a temp DB so tests don't conflict with running server
_test_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["GRAI_TEST_DB"] = _test_db.name
_test_db.close()

# Patch db.py to use the test DB
import db
db.DB_PATH = os.environ["GRAI_TEST_DB"]
db._conn = None  # Reset connection so it picks up new path


@pytest.fixture(autouse=True)
def reset_db_and_rate_limiter():
    """Reset DB connection and rate limiter between tests."""
    import db as _db
    _db._conn = None
    # Reset rate limiter so tests don't hit 429
    from security import rate_limiter
    rate_limiter._buckets.clear()
    yield
    _db._conn = None
os.environ["BRAVE_API_KEY"] = ""
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["ELEVENLABS_API_KEY"] = ""
os.environ["TWILIO_ACCOUNT_SID"] = ""
os.environ["TWILIO_AUTH_TOKEN"] = ""


@pytest.fixture
def sample_business_analysis():
    return {
        "business_name": "TestCorp",
        "website_url": "https://testcorp.com",
        "services": ["AI consulting", "ML training"],
        "pricing_info": "$5000-$20000 per project",
        "ideal_customer_profile": {
            "industries": ["technology", "finance", "healthcare"],
            "company_size": "SMB to Enterprise",
            "pain_points": ["manual processes", "data quality"],
            "decision_makers": ["CTO", "VP Engineering"],
            "use_cases": ["process automation", "data analytics"],
        },
        "location": "London, UK",
        "city": "London",
        "country": "United Kingdom",
        "country_code": "GB",
        "industry": "AI Consulting",
        "key_differentiators": ["fast delivery", "custom models"],
        "language": "English",
        "language_code": "en",
        "business_type": "local",
        "business_model": "b2b",
        "summary": "AI consulting firm based in London.",
    }


@pytest.fixture
def sample_leads():
    return [
        {
            "name": "Acme Corp",
            "website": "https://acme.com",
            "phone": "+441234567890",
            "email": "info@acme.com",
            "contact_person": "John Smith",
            "address": "123 Main St",
            "city": "London",
            "country": "United Kingdom",
            "industry": "technology",
            "relevance_reason": "Perfect fit for AI consulting",
            "source": "google_maps",
            "rating": 4.5,
            "reviews": 120,
        },
        {
            "name": "Beta Inc",
            "website": "https://beta.io",
            "phone": "+441234567891",
            "email": "",
            "contact_person": "",
            "address": "456 Oak Ave",
            "city": "Manchester",
            "country": "United Kingdom",
            "industry": "finance",
            "relevance_reason": "Growing fintech company",
            "source": "brave",
            "rating": 4.0,
            "reviews": 50,
        },
    ]


@pytest.fixture
def sample_pitches():
    return [
        {
            "lead_name": "Acme Corp",
            "contact_person": "John Smith",
            "pitch_script": "Hi John, I'm calling from TestCorp...",
            "email_subject": "AI solutions for Acme Corp",
            "email_body": "<p>Hi John, we noticed Acme Corp is growing...</p>",
            "key_value_proposition": "Cut costs by 40%",
            "call_to_action": "15-minute call this week?",
            "language": "English",
        },
    ]
