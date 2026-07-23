"""Tests for parse enqueue, result-shaping into ParseResponse, and confidence via job_id."""

from backend import models  # noqa: F401 — ensures all models register with Base before table creation


def test_parse_async_enqueues(db, monkeypatch):
    from backend.routers import async_jobs
    from backend.schemas import ParseRequest
    from backend.models import LLMJob
    # _enqueue() opens its own session via base_llm.SessionLocal — point that at the test db.
    monkeypatch.setattr("backend.services.base_llm.SessionLocal", lambda: db)
    resp = async_jobs.parse_async(ParseRequest(message="200g chicken"), db)
    job = db.query(LLMJob).filter(LLMJob.job_id == resp.job_id).first()
    assert job.task_type == "parse_input" and job.context == "dashboard_parse"


def test_parse_job_result_is_parseresponse(db):
    from backend.routers.async_jobs import get_job_status
    from backend.services import job_queue
    job_queue.enqueue(db, context="dashboard_parse", task_type="parse_input",
                      request_payload={"prompt": "p", "want_json": True})
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id,
        response_text='{"intents":[{"type":"meal","meal_data":{"description":"chicken","calories":200,"items":[]}}]}')
    status = get_job_status(claimed.job_id, db)
    assert status.status == "completed"
    assert status.result["request_log_id"] == claimed.job_id       # job_id, not a GeminiRequestLog PK
    assert status.result["intents"][0]["type"] == "meal"


def test_commit_updates_llmjob_confidence(db):
    from backend.services import job_queue
    from backend.models import LLMJob
    from backend.routers.parse import _apply_confidence_metrics   # small helper extracted in Step 3
    job = job_queue.enqueue(db, context="dashboard_parse", task_type="parse_input", request_payload={"prompt": "p"})
    _apply_confidence_metrics(db, request_log_id=job.job_id, item_confidences=[0.9, 0.3])
    row = db.query(LLMJob).filter(LLMJob.job_id == job.job_id).first()
    assert round(row.avg_confidence, 2) == 0.60
    assert row.min_confidence == 0.3
    assert row.low_confidence_count == 1
