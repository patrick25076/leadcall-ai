"""Tests for agent tools — scoring, saving, validation."""

import json
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestScoreLeads:
    """Lead scoring algorithm must produce consistent, valid scores."""

    def test_scores_are_0_to_100(self, sample_leads, sample_business_analysis):
        from agents.tools import pipeline_state, score_leads

        pipeline_state["business_analysis"] = sample_business_analysis
        pipeline_state["leads"] = sample_leads

        result = score_leads("{}")
        assert result["status"] == "success"
        for lead in result["scored_leads"]:
            assert 0 <= lead["lead_score"] <= 100

    def test_grades_are_valid(self, sample_leads, sample_business_analysis):
        from agents.tools import pipeline_state, score_leads

        pipeline_state["business_analysis"] = sample_business_analysis
        pipeline_state["leads"] = sample_leads

        result = score_leads("{}")
        for lead in result["scored_leads"]:
            assert lead["score_grade"] in ("A", "B", "C", "D")

    def test_sorted_descending(self, sample_leads, sample_business_analysis):
        from agents.tools import pipeline_state, score_leads

        pipeline_state["business_analysis"] = sample_business_analysis
        pipeline_state["leads"] = sample_leads

        result = score_leads("{}")
        scores = [l["lead_score"] for l in result["scored_leads"]]
        assert scores == sorted(scores, reverse=True)

    def test_empty_leads(self, sample_business_analysis):
        from agents.tools import pipeline_state, score_leads

        pipeline_state["business_analysis"] = sample_business_analysis
        pipeline_state["leads"] = []

        result = score_leads("{}")
        assert result["status"] == "success"
        assert result["total_leads"] == 0


class TestSaveLeads:
    """save_leads must validate and persist correctly."""

    def test_saves_valid_leads(self, sample_leads):
        from agents.tools import pipeline_state, save_leads

        pipeline_state["campaign_id"] = None  # Skip DB persistence
        result = save_leads(json.dumps(sample_leads))
        assert result["status"] == "success"
        assert result["count"] == 2

    def test_rejects_invalid_json(self):
        from agents.tools import save_leads

        result = save_leads("not json")
        assert result["status"] == "error"

    def test_wraps_single_lead_in_array(self):
        from agents.tools import pipeline_state, save_leads

        pipeline_state["campaign_id"] = None
        single = {"name": "Test Co", "phone": "+441234567890"}
        result = save_leads(json.dumps(single))
        assert result["status"] == "success"
        assert result["count"] == 1


class TestSavePitch:
    """save_pitch must store pitch data correctly."""

    def test_saves_valid_pitches(self, sample_pitches):
        from agents.tools import pipeline_state, save_pitch

        pipeline_state["campaign_id"] = None
        result = save_pitch(json.dumps(sample_pitches))
        assert result["status"] == "success"
        assert result["count"] == 1

    def test_rejects_invalid_json(self):
        from agents.tools import save_pitch

        result = save_pitch("{broken")
        assert result["status"] == "error"


class TestSaveJudgedPitches:
    """save_judged_pitches must normalize field names and set readiness."""

    def test_normalizes_ready_to_call(self):
        from agents.tools import pipeline_state, save_judged_pitches

        pipeline_state["campaign_id"] = None
        judged = [
            {
                "lead_name": "Test",
                "readyToCall": True,  # camelCase variant
                "score": 8,
                "phone_number": "+441234567890",
            }
        ]
        result = save_judged_pitches(json.dumps(judged))
        assert result["status"] == "success"
        assert result["ready_to_call"] == 1

    def test_auto_sets_ready_when_score_high_and_phone(self):
        from agents.tools import pipeline_state, save_judged_pitches

        pipeline_state["campaign_id"] = None
        judged = [
            {
                "lead_name": "Test",
                "score": 9,
                "phone_number": "+441234567890",
            }
        ]
        result = save_judged_pitches(json.dumps(judged))
        assert result["ready_to_call"] >= 1


class TestGetPipelineState:
    """get_pipeline_state must return full data, not just counts."""

    def test_returns_scored_leads(self, sample_leads, sample_business_analysis):
        from agents.tools import pipeline_state, get_pipeline_state

        pipeline_state["business_analysis"] = sample_business_analysis
        pipeline_state["scored_leads"] = sample_leads

        result = get_pipeline_state()
        assert result["status"] == "success"
        assert len(result["scored_leads"]) == 2
        assert result["scored_leads"][0]["name"] == "Acme Corp"

    def test_returns_empty_when_no_data(self):
        from agents.tools import pipeline_state, get_pipeline_state

        pipeline_state["business_analysis"] = None
        pipeline_state["scored_leads"] = []
        pipeline_state["leads"] = []

        result = get_pipeline_state()
        assert result["scored_leads"] == []
