"""Tests for company research going through the llm_jobs queue.
No markers — the job's JSON result IS the research payload, persisted onto the
researched Company by the company_research hook (keyed by context_key)."""

import json


def test_research_prompt_builds_prompt_and_config():
    from backend.services.company_research_service import CompanyResearchService
    service = CompanyResearchService()
    prompt, config = service.research_prompt("Riot Games", tier="gaming_t1", location="LA")
    assert "Riot Games" in prompt
    assert "gaming_t1" in prompt
    assert config.response_mime_type == "application/json"


def test_company_research_async_enqueues_job(db, monkeypatch):
    from backend.routers import async_jobs
    from backend.models import Company
    from backend.services.company_research_service import CompanyResearchService

    company = Company(name="Riot Games", tier="gaming_t1", location="LA")
    db.add(company)
    db.commit()
    db.refresh(company)

    captured = {}

    def _fake_enqueue(self, contents, config, *, task_type, context, method=None, context_key=None):
        captured["task_type"] = task_type
        captured["context"] = context
        captured["context_key"] = context_key
        return "fake-job-id"

    monkeypatch.setattr(CompanyResearchService, "_enqueue", _fake_enqueue)

    resp = async_jobs.company_research_async(company.id, db)
    assert resp.job_id == "fake-job-id"
    assert captured["context"] == "company_research"
    assert captured["task_type"] == "company_research"
    assert captured["context_key"] == str(company.id)


def test_company_research_async_404_for_missing_company(db):
    from fastapi import HTTPException
    from backend.routers import async_jobs
    import pytest
    with pytest.raises(HTTPException):
        async_jobs.company_research_async(999999, db)


def test_company_research_poll_result_is_research_json(db):
    """The poll result for a company_research job is the research dict."""
    from backend.services import job_queue, result_hooks

    job = job_queue.enqueue(db, context="company_research", task_type="company_research", request_payload={"prompt": "x"})
    claimed = job_queue.claim_next(db)
    research_json = json.dumps({"summary": "A gaming company.", "last_updated": "2026-01-01T00:00:00"})
    job_queue.record_result(db, claimed.job_id, response_text=research_json)
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))  # no context_key -> no-op, must not raise

    refreshed = job_queue.get_job(db, claimed.job_id)
    parsed = json.loads(refreshed.response_text)
    assert parsed["summary"] == "A gaming company."


def test_company_research_hook_persists_market_info(db):
    """The company_research hook writes the research JSON onto the researched
    Company (keyed by context_key = company id), setting market_info_updated_at."""
    from backend.services import job_queue, result_hooks
    from backend.models import Company

    company = Company(name="Riot Games", tier="gaming_t1")
    db.add(company)
    db.commit()
    db.refresh(company)

    job = job_queue.enqueue(
        db, context="company_research", task_type="company_research",
        request_payload={"prompt": "x", "context_key": str(company.id)},
    )
    claimed = job_queue.claim_next(db)
    research_json = json.dumps({"summary": "A gaming company.", "last_updated": "2026-01-01T00:00:00"})
    job_queue.record_result(db, claimed.job_id, response_text=research_json)
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))

    db.refresh(company)
    assert json.loads(company.market_info)["summary"] == "A gaming company."
    assert company.market_info_updated_at is not None
