"""Tests for the llm_jobs queue service."""

import json
from datetime import datetime, timedelta
import pytest

# Import models at module level so they register with Base before the db fixture
# calls create_all (same pattern as other test files in this suite).
import backend.models  # noqa: F401


def test_llmjob_defaults(db):
    from backend.models import LLMJob
    job = LLMJob(job_id="abc123", context="dashboard", task_type="chat",
                 request_payload=json.dumps({"message": "hi"}))
    db.add(job)
    db.commit()
    db.refresh(job)
    assert job.status == "queued"
    assert job.attempt_count == 0
    assert job.max_attempts == 3
    assert job.priority == 0
    assert job.json_requested is False
    assert job.consumed_at is None
    assert job.created_at is not None


def test_enqueue_creates_queued_job(db):
    from backend.services import job_queue
    job = job_queue.enqueue(db, context="dashboard", task_type="parse_input",
                            request_payload={"message": "200g chicken"}, json_requested=True)
    assert job.status == "queued"
    assert job.priority == 10          # parse_input is interactive tier
    assert json.loads(job.request_payload) == {"message": "200g chicken"}
    assert json.loads(job.errors) == []


def test_enqueue_idempotency_dedupes(db):
    from backend.services import job_queue
    a = job_queue.enqueue(db, context="dashboard", task_type="chat",
                          request_payload={"m": 1}, idempotency_key="k1")
    b = job_queue.enqueue(db, context="dashboard", task_type="chat",
                          request_payload={"m": 1}, idempotency_key="k1")
    assert a.job_id == b.job_id        # same non-terminal job returned, not a duplicate


def test_list_for_context_returns_active_and_recent_unacked(db):
    from backend.services import job_queue
    from backend.models import LLMJob
    job_queue.enqueue(db, context="dashboard", task_type="chat", request_payload={})
    # finished + unacked recently -> shown
    done = job_queue.enqueue(db, context="dashboard", task_type="chat", request_payload={})
    done.status = "succeeded"; done.completed_at = datetime.utcnow(); db.commit()
    # finished on a DIFFERENT context -> not shown
    other = job_queue.enqueue(db, context="workout_log", task_type="chat", request_payload={})
    jobs = job_queue.list_for_context(db, "dashboard")
    ids = {j.job_id for j in jobs}
    assert done.job_id in ids
    assert other.job_id not in ids
    assert len(jobs) == 2


def test_list_excludes_acked_and_old(db):
    from backend.services import job_queue
    acked = job_queue.enqueue(db, context="dashboard", task_type="chat", request_payload={})
    acked.status = "succeeded"; acked.completed_at = datetime.utcnow(); acked.consumed_at = datetime.utcnow(); db.commit()
    old = job_queue.enqueue(db, context="dashboard", task_type="chat", request_payload={})
    old.status = "succeeded"; old.completed_at = datetime.utcnow() - timedelta(hours=25); db.commit()
    jobs = job_queue.list_for_context(db, "dashboard")
    ids = {j.job_id for j in jobs}
    assert acked.job_id not in ids     # consumed -> hidden
    assert old.job_id not in ids       # outside 24h window -> hidden


def test_mark_resolved_sets_consumed_and_hides_job(db):
    from backend.services import job_queue
    j = job_queue.enqueue(db, context="dashboard_parse", task_type="parse_input", request_payload={})
    j.status = "succeeded"; j.completed_at = datetime.utcnow(); db.commit()
    assert j.job_id in {x.job_id for x in job_queue.list_for_context(db, "dashboard_parse")}

    out = job_queue.mark_resolved(db, j.job_id)
    assert out.consumed_at is not None
    first = out.consumed_at
    assert job_queue.mark_resolved(db, j.job_id).consumed_at == first  # idempotent
    db.commit()
    assert j.job_id not in {x.job_id for x in job_queue.list_for_context(db, "dashboard_parse")}


def test_mark_resolved_missing_job_returns_none(db):
    from backend.services import job_queue
    assert job_queue.mark_resolved(db, "does-not-exist") is None


def test_claim_picks_highest_priority_oldest(db):
    from backend.services import job_queue
    job_queue.enqueue(db, context="c", task_type="company_research", request_payload={})  # prio 0
    hi = job_queue.enqueue(db, context="c", task_type="parse_input", request_payload={})   # prio 10
    claimed = job_queue.claim_next(db)
    assert claimed.job_id == hi.job_id
    assert claimed.status == "running"
    assert claimed.attempt_count == 1
    assert claimed.lease_expires_at is not None
    assert claimed.started_at is not None


def test_claim_returns_none_when_empty(db):
    from backend.services import job_queue
    assert job_queue.claim_next(db) is None


def test_reaper_requeues_expired_lease(db):
    from backend.services import job_queue
    j = job_queue.enqueue(db, context="c", task_type="chat", request_payload={})
    claimed = job_queue.claim_next(db)
    # simulate worker death: lease already expired
    claimed.lease_expires_at = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    swept = job_queue.sweep_stale(db)
    assert swept == 1
    db.refresh(claimed)
    assert claimed.status == "queued"          # requeued (attempt 1 < max 3)


def test_reaper_fails_when_out_of_attempts(db):
    from backend.services import job_queue
    j = job_queue.enqueue(db, context="c", task_type="chat", request_payload={}, max_attempts=1)
    claimed = job_queue.claim_next(db)         # attempt_count -> 1 == max_attempts
    claimed.lease_expires_at = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    job_queue.sweep_stale(db)
    db.refresh(claimed)
    assert claimed.status == "failed"
    assert "lease expired" in json.loads(claimed.errors)[-1]["error"]


def test_record_result_marks_succeeded(db):
    from backend.services import job_queue
    job_queue.enqueue(db, context="c", task_type="chat", request_payload={})
    claimed = job_queue.claim_next(db)
    done = job_queue.record_result(db, claimed.job_id, response_text="hello",
                                   total_tokens=42, latency_ms=1200, model="claude-opus-4-6")
    assert done.status == "succeeded"
    assert done.response_text == "hello"
    assert done.total_tokens == 42
    assert done.latency_ms == 1200
    assert done.model == "claude-opus-4-6"
    assert done.lease_expires_at is None
    assert done.completed_at is not None


def test_record_failure_marks_failed_with_history(db):
    from backend.services import job_queue
    job_queue.enqueue(db, context="c", task_type="chat", request_payload={})
    claimed = job_queue.claim_next(db)
    failed = job_queue.record_failure(db, claimed.job_id, error="bridge exploded")
    assert failed.status == "failed"
    assert json.loads(failed.errors)[-1]["error"] == "bridge exploded"
    assert failed.completed_at is not None


def test_heartbeat_extends_lease(db):
    from backend.services import job_queue
    job_queue.enqueue(db, context="c", task_type="chat", request_payload={})
    claimed = job_queue.claim_next(db)
    old_lease = claimed.lease_expires_at
    claimed.lease_expires_at = datetime.utcnow() + timedelta(seconds=1)
    db.commit()
    hb = job_queue.heartbeat(db, claimed.job_id)
    assert hb.lease_expires_at > datetime.utcnow() + timedelta(seconds=30)


def test_heartbeat_ignored_when_not_running(db):
    from backend.services import job_queue
    j = job_queue.enqueue(db, context="c", task_type="chat", request_payload={})
    assert job_queue.heartbeat(db, j.job_id) is None   # still queued, not running


def test_ack_sets_consumed(db):
    from backend.services import job_queue
    job_queue.enqueue(db, context="c", task_type="chat", request_payload={})
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text="x")
    acked = job_queue.ack(db, claimed.job_id)
    assert acked.consumed_at is not None


def test_retry_requeues_failed_and_keeps_errors(db):
    from backend.services import job_queue
    job_queue.enqueue(db, context="c", task_type="chat", request_payload={"m": 1})
    claimed = job_queue.claim_next(db)
    job_queue.record_failure(db, claimed.job_id, error="boom")
    retried = job_queue.retry(db, claimed.job_id)
    assert retried.status == "queued"
    assert retried.attempt_count == 0            # fresh attempts
    assert retried.completed_at is None
    assert json.loads(retried.errors)[-1]["error"] == "boom"   # history preserved


def test_retry_noop_when_not_failed(db):
    from backend.services import job_queue
    j = job_queue.enqueue(db, context="c", task_type="chat", request_payload={})
    assert job_queue.retry(db, j.job_id) is None   # only failed jobs can be retried


def test_purge_old_removes_terminal(db):
    from backend.services import job_queue
    from backend.models import LLMJob
    j = job_queue.enqueue(db, context="c", task_type="chat", request_payload={})
    j.status = "succeeded"; j.completed_at = datetime.utcnow() - timedelta(hours=48); db.commit()
    job_queue.purge_old(db)
    assert db.query(LLMJob).filter(LLMJob.job_id == j.job_id).first() is None


def test_claim_next_lazily_purges_old_terminal_jobs(db):
    from backend.services import job_queue
    from backend.models import LLMJob
    old = job_queue.enqueue(db, context="c", task_type="chat", request_payload={})
    old.status = "succeeded"; old.completed_at = datetime.utcnow() - timedelta(hours=48); db.commit()
    job_queue.enqueue(db, context="c", task_type="chat", request_payload={})  # queued job to claim
    job_queue.claim_next(db)
    assert db.query(LLMJob).filter(LLMJob.job_id == old.job_id).first() is None


def test_llmjob_has_audit_columns(db):
    from backend.models import LLMJob
    job = LLMJob(job_id="a1", context="c", task_type="chat", request_payload="{}",
                 service="HELM_ADVISOR", method="plan_workout", project="paid",
                 waterfall_position=0, avg_confidence=0.9, min_confidence=0.5,
                 low_confidence_count=1)
    db.add(job); db.commit(); db.refresh(job)
    assert job.service == "HELM_ADVISOR"
    assert job.method == "plan_workout"
    assert job.project == "paid"
    assert job.waterfall_position == 0
    assert job.avg_confidence == 0.9


def test_enqueue_stores_service_method(db):
    from backend.services import job_queue
    job = job_queue.enqueue(db, context="workout_log", task_type="plan_workout",
                            request_payload={"prompt": "x"}, service="HELM_ADVISOR", method="plan_workout")
    assert job.service == "HELM_ADVISOR"
    assert job.method == "plan_workout"


def test_enqueue_and_wait_returns_on_completion(db):
    import threading, time
    from backend.services import job_queue
    job = {"ctx": None}
    def submit():
        j = job_queue.enqueue_and_wait(db, context="c", task_type="chat",
                                       request_payload={"prompt": "x"}, timeout_s=5.0, poll_interval=0.05)
        job["ctx"] = j
    t = threading.Thread(target=submit); t.start()
    time.sleep(0.15)
    # simulate the worker completing it
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text='{"garlic":"Produce"}')
    t.join(timeout=6)
    assert job["ctx"] is not None and job["ctx"].status == "succeeded"


def test_enqueue_and_wait_times_out(db):
    from backend.services import job_queue
    j = job_queue.enqueue_and_wait(db, context="c", task_type="chat",
                                   request_payload={"prompt": "x"}, timeout_s=0.2, poll_interval=0.05)
    assert j is None   # no worker -> stays queued -> timeout
