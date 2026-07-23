"""SQLite-backed LLM job queue. Helm is the sole writer of llm_jobs; the worker
interacts only through the internal HTTP API, which calls these functions.
"""

import json
import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy import or_, and_

from ..models import LLMJob

LEASE_SECONDS = 60                      # a running job must heartbeat within this or it's requeued
DEFAULT_MAX_ATTEMPTS = 3
UNACKED_WINDOW = timedelta(hours=24)    # how long a finished-but-unacked job stays in the reconnect view
JOB_TTL = timedelta(hours=24)          # terminal jobs older than this are purged

# task_type -> priority (higher runs first). Interactive beats batch.
PRIORITY_TIERS = {
    "parse_input": 10, "chat": 10, "recipe_parse": 10, "ingredient_classify": 10,
    "leetcode_hint": 10, "plan_workout": 10,
    "company_research": 0,
}


def _now() -> datetime:
    return datetime.utcnow()


def _priority_for(task_type: str) -> int:
    return PRIORITY_TIERS.get(task_type, 5)


def _append_error(job: LLMJob, message: str) -> None:
    try:
        errs = json.loads(job.errors) if job.errors else []
    except (ValueError, TypeError):
        errs = []
    errs.append({"attempt": job.attempt_count, "error": str(message)[:2000], "ts": _now().isoformat()})
    job.errors = json.dumps(errs)


def enqueue(db, *, context, task_type, request_payload, provider=None, model=None,
            effort=None, json_requested=False, idempotency_key=None,
            service=None, method=None, max_attempts=DEFAULT_MAX_ATTEMPTS) -> LLMJob:
    """Create a queued job. If idempotency_key matches a non-terminal job in the
    same context, return that existing job instead of creating a duplicate."""
    if idempotency_key:
        existing = (db.query(LLMJob)
                    .filter(LLMJob.context == context,
                            LLMJob.idempotency_key == idempotency_key,
                            LLMJob.status.in_(("queued", "running")))
                    .first())
        if existing:
            return existing
    job = LLMJob(
        job_id=uuid.uuid4().hex[:12],
        idempotency_key=idempotency_key,
        context=context,
        task_type=task_type,
        provider=provider, model=model, effort=effort,
        service=service, method=method,
        priority=_priority_for(task_type),
        status="queued",
        attempt_count=0,
        max_attempts=max_attempts,
        errors=json.dumps([]),
        request_payload=json.dumps(request_payload),
        json_requested=json_requested,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def enqueue_and_wait(db, *, timeout_s=60.0, poll_interval=0.5, **enqueue_kwargs) -> LLMJob | None:
    """Enqueue a job and block until it reaches a terminal state, or return None on timeout.
    For the rare in-request LLM use (ingredient auto-categorization) that needs the result
    synchronously. The worker executes it out-of-process; the caller supplies its own fallback
    on None/failed. Behavior-preserving vs the old in-request _generate call (which also blocked)."""
    job = enqueue(db, **enqueue_kwargs)
    job_id = job.job_id
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        time.sleep(poll_interval)
        db.expire_all()
        fresh = get_job(db, job_id)
        if fresh and fresh.status in ("succeeded", "failed"):
            return fresh
    return None


def get_job(db, job_id: str) -> LLMJob | None:
    return db.query(LLMJob).filter(LLMJob.job_id == job_id).first()


def list_for_context(db, context: str) -> list[LLMJob]:
    """Active jobs + recently-finished-unacked jobs for a context (the reconnect view)."""
    cutoff = _now() - UNACKED_WINDOW
    return (db.query(LLMJob)
            .filter(LLMJob.context == context)
            .filter(or_(
                LLMJob.status.in_(("queued", "running")),
                and_(LLMJob.status.in_(("succeeded", "failed")),
                     LLMJob.consumed_at.is_(None),
                     LLMJob.completed_at > cutoff),
            ))
            .order_by(LLMJob.created_at.desc())
            .all())


def sweep_stale(db) -> int:
    """Lazy reaper: requeue running jobs whose lease expired; fail those out of attempts."""
    now = _now()
    stale = (db.query(LLMJob)
             .filter(LLMJob.status == "running", LLMJob.lease_expires_at < now)
             .all())
    for job in stale:
        if job.attempt_count < job.max_attempts:
            job.status = "queued"
            job.lease_expires_at = None
        else:
            _append_error(job, "lease expired (worker died) — max attempts reached")
            job.status = "failed"
            job.completed_at = now
    if stale:
        db.commit()
    return len(stale)


def claim_next(db) -> LLMJob | None:
    """Sweep stale leases first, purge old terminal jobs (lazy TTL reaper — no in-process
    scheduler needed, since this runs on every worker poll), then claim the highest-priority
    oldest queued job."""
    sweep_stale(db)
    purge_old(db)
    job = (db.query(LLMJob)
           .filter(LLMJob.status == "queued")
           .order_by(LLMJob.priority.desc(), LLMJob.created_at.asc())
           .first())
    if not job:
        return None
    now = _now()
    job.status = "running"
    job.attempt_count += 1
    job.started_at = job.started_at or now
    job.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
    db.commit()
    db.refresh(job)
    return job


def record_result(db, job_id: str, *, response_text=None, response_payload=None,
                  model=None, effort=None, prompt_tokens=0, response_tokens=0,
                  total_tokens=0, latency_ms=0, estimated_cost=0.0, json_valid=None) -> LLMJob | None:
    job = get_job(db, job_id)
    if not job:
        return None
    job.status = "succeeded"
    job.response_text = response_text
    job.response_payload = json.dumps(response_payload) if response_payload is not None else None
    if model:
        job.model = model
    if effort:
        job.effort = effort
    job.prompt_tokens = prompt_tokens
    job.response_tokens = response_tokens
    job.total_tokens = total_tokens
    job.latency_ms = latency_ms
    job.estimated_cost = estimated_cost
    job.json_valid = json_valid
    job.lease_expires_at = None
    job.completed_at = _now()
    db.commit()
    db.refresh(job)
    return job


def record_failure(db, job_id: str, *, error: str) -> LLMJob | None:
    """Worker-reported failure -> mark failed with error history. Manual retry re-queues it."""
    job = get_job(db, job_id)
    if not job:
        return None
    _append_error(job, error)
    job.status = "failed"
    job.lease_expires_at = None
    job.completed_at = _now()
    db.commit()
    db.refresh(job)
    return job


def heartbeat(db, job_id: str) -> LLMJob | None:
    job = get_job(db, job_id)
    if not job or job.status != "running":
        return None
    job.lease_expires_at = _now() + timedelta(seconds=LEASE_SECONDS)
    db.commit()
    db.refresh(job)
    return job


def ack(db, job_id: str) -> LLMJob | None:
    job = get_job(db, job_id)
    if not job:
        return None
    job.consumed_at = _now()
    db.commit()
    db.refresh(job)
    return job


def mark_resolved(db, job_id: str) -> LLMJob | None:
    """Mark a job consumed (resolved) WITHOUT committing — for callers that resolve a job
    inside their own transaction (e.g. commit_intents marking a parse handled once the user
    confirms it). Idempotent: leaves an already-consumed job untouched. Returns the job."""
    job = get_job(db, job_id)
    if job and job.consumed_at is None:
        job.consumed_at = _now()
    return job


def retry(db, job_id: str) -> LLMJob | None:
    """Manually re-enqueue a failed job: preserve error history, reset attempts + timestamps."""
    job = get_job(db, job_id)
    if not job or job.status != "failed":
        return None
    job.status = "queued"
    job.attempt_count = 0
    job.lease_expires_at = None
    job.started_at = None
    job.completed_at = None
    job.consumed_at = None
    db.commit()
    db.refresh(job)
    return job


def purge_old(db) -> int:
    """Delete terminal jobs older than JOB_TTL."""
    cutoff = _now() - JOB_TTL
    old_jobs = (db.query(LLMJob)
                .filter(LLMJob.status.in_(("succeeded", "failed")), LLMJob.completed_at < cutoff)
                .all())
    for job in old_jobs:
        db.delete(job)
    db.commit()
    return len(old_jobs)
