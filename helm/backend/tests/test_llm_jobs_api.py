"""Tests for the llm_jobs routers + worker-secret auth."""

import json
from unittest.mock import MagicMock, patch
import pytest
from fastapi import HTTPException


def _req(auth_header=None):
    r = MagicMock()
    r.headers = {"Authorization": auth_header} if auth_header else {}
    return r


def test_worker_secret_accepts_correct(db):
    from backend.routers.llm_jobs import require_worker_secret
    with patch.dict("os.environ", {"HELM_WORKER_SECRET": "s3cret"}):
        require_worker_secret(_req("Bearer s3cret"))   # should not raise


def test_worker_secret_rejects_wrong(db):
    from backend.routers.llm_jobs import require_worker_secret
    with patch.dict("os.environ", {"HELM_WORKER_SECRET": "s3cret"}):
        with pytest.raises(HTTPException) as e:
            require_worker_secret(_req("Bearer nope"))
        assert e.value.status_code == 401


def test_worker_secret_rejects_missing_header(db):
    from backend.routers.llm_jobs import require_worker_secret
    with patch.dict("os.environ", {"HELM_WORKER_SECRET": "s3cret"}):
        with pytest.raises(HTTPException):
            require_worker_secret(_req(None))


def test_worker_secret_rejects_when_unset(db):
    """Fail closed: no configured secret => reject everything."""
    from backend.routers.llm_jobs import require_worker_secret
    with patch.dict("os.environ", {}, clear=True):
        with pytest.raises(HTTPException):
            require_worker_secret(_req("Bearer anything"))


def test_enqueue_endpoint_creates_job(db):
    from backend.routers.llm_jobs import enqueue_job
    from backend.schemas import LLMJobEnqueueRequest
    body = LLMJobEnqueueRequest(context="dashboard", task_type="chat", request_payload={"message": "hi"})
    resp = enqueue_job(body, db)
    assert resp.status == "queued"
    assert resp.context == "dashboard"


def test_list_endpoint_filters_by_context(db):
    from backend.routers.llm_jobs import list_jobs, enqueue_job
    from backend.schemas import LLMJobEnqueueRequest
    enqueue_job(LLMJobEnqueueRequest(context="dashboard", task_type="chat", request_payload={}), db)
    enqueue_job(LLMJobEnqueueRequest(context="workout_log", task_type="chat", request_payload={}), db)
    resp = list_jobs("dashboard", db)
    assert len(resp.jobs) == 1
    assert resp.jobs[0].context == "dashboard"


def test_get_endpoint_404_when_missing(db):
    from backend.routers.llm_jobs import get_job_endpoint
    with pytest.raises(HTTPException) as e:
        get_job_endpoint("nope", db)
    assert e.value.status_code == 404


def test_ack_and_retry_endpoints(db):
    from backend.routers.llm_jobs import enqueue_job, ack_job, retry_job
    from backend.schemas import LLMJobEnqueueRequest
    from backend.services import job_queue
    j = enqueue_job(LLMJobEnqueueRequest(context="c", task_type="chat", request_payload={}), db)
    claimed = job_queue.claim_next(db)
    job_queue.record_failure(db, claimed.job_id, error="boom")
    retried = retry_job(claimed.job_id, db)
    assert retried.status == "queued"
    job_queue.record_result(db, claimed.job_id, response_text="ok")
    acked = ack_job(claimed.job_id, db)
    assert acked.consumed_at is not None


def test_claim_endpoint_returns_job_or_none(db):
    from backend.routers.llm_jobs import claim_endpoint, enqueue_job
    from backend.schemas import LLMJobEnqueueRequest
    assert claim_endpoint(db) is None                       # empty queue
    enqueue_job(LLMJobEnqueueRequest(context="c", task_type="parse_input",
                                     request_payload={"m": 1}, json_requested=True), db)
    claimed = claim_endpoint(db)
    assert claimed.job_id
    assert claimed.request_payload == {"m": 1}
    assert claimed.json_requested is True
    assert claimed.attempt_count == 1


def test_result_endpoint_marks_succeeded(db):
    from backend.routers.llm_jobs import claim_endpoint, result_endpoint, enqueue_job
    from backend.schemas import LLMJobEnqueueRequest, LLMJobResultRequest
    from backend.services import job_queue
    enqueue_job(LLMJobEnqueueRequest(context="c", task_type="chat", request_payload={}), db)
    claimed = claim_endpoint(db)
    resp = result_endpoint(claimed.job_id, LLMJobResultRequest(response_text="done", total_tokens=5), db)
    assert resp.status == "succeeded"
    assert resp.response_text == "done"


def test_fail_and_heartbeat_endpoints(db):
    from backend.routers.llm_jobs import claim_endpoint, fail_endpoint, heartbeat_endpoint, enqueue_job
    from backend.schemas import LLMJobEnqueueRequest, LLMJobFailRequest
    enqueue_job(LLMJobEnqueueRequest(context="c", task_type="chat", request_payload={}), db)
    claimed = claim_endpoint(db)
    hb = heartbeat_endpoint(claimed.job_id, db)
    assert hb["ok"] is True
    resp = fail_endpoint(claimed.job_id, LLMJobFailRequest(error="nope"), db)
    assert resp.status == "failed"


def test_result_endpoint_404_when_missing(db):
    from backend.routers.llm_jobs import result_endpoint
    from backend.schemas import LLMJobResultRequest
    with pytest.raises(HTTPException) as e:
        result_endpoint("ghost", LLMJobResultRequest(response_text="x"), db)
    assert e.value.status_code == 404
