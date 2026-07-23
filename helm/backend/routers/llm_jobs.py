"""LLM job queue HTTP surface: public /api/llm-jobs (JWT-admin) + worker-only
/internal/llm-jobs (shared secret). Thin wrappers over services.job_queue."""

import hmac
import json
import os

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import LLMJob
from ..services import job_queue
from ..schemas import (
    LLMJobEnqueueRequest, LLMJobResponse, LLMJobListResponse,
    LLMJobClaimResponse, LLMJobResultRequest, LLMJobFailRequest,
)


def require_worker_secret(request: Request) -> None:
    """Guard /internal/* routes with a constant-time bearer-secret check. Fail closed."""
    secret = os.getenv("HELM_WORKER_SECRET", "")
    auth = request.headers.get("Authorization", "")
    token = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""
    if not secret or not hmac.compare_digest(token, secret):
        raise HTTPException(status_code=401, detail="Invalid worker secret")


def _last_error(job: LLMJob) -> str | None:
    try:
        errs = json.loads(job.errors) if job.errors else []
    except (ValueError, TypeError):
        return None
    return errs[-1]["error"] if errs else None


def _to_response(job: LLMJob) -> LLMJobResponse:
    return LLMJobResponse(
        job_id=job.job_id, context=job.context, task_type=job.task_type,
        status=job.status, provider=job.provider, model=job.model,
        response_text=job.response_text,
        response_payload=json.loads(job.response_payload) if job.response_payload else None,
        error=_last_error(job), attempt_count=job.attempt_count,
        total_tokens=job.total_tokens, latency_ms=job.latency_ms,
        created_at=job.created_at.isoformat() if job.created_at else None,
        completed_at=job.completed_at.isoformat() if job.completed_at else None,
        consumed_at=job.consumed_at.isoformat() if job.consumed_at else None,
    )


router = APIRouter(prefix="/api/llm-jobs", tags=["llm-jobs"])


@router.post("", response_model=LLMJobResponse)
def enqueue_job(body: LLMJobEnqueueRequest, db: Session = Depends(get_db)) -> LLMJobResponse:
    job = job_queue.enqueue(
        db, context=body.context, task_type=body.task_type,
        request_payload=body.request_payload, provider=body.provider,
        model=body.model, effort=body.effort, json_requested=body.json_requested,
        idempotency_key=body.idempotency_key,
    )
    return _to_response(job)


@router.get("", response_model=LLMJobListResponse)
def list_jobs(context: str, db: Session = Depends(get_db)) -> LLMJobListResponse:
    jobs = job_queue.list_for_context(db, context)
    return LLMJobListResponse(jobs=[_to_response(j) for j in jobs])


@router.get("/{job_id}", response_model=LLMJobResponse)
def get_job_endpoint(job_id: str, db: Session = Depends(get_db)) -> LLMJobResponse:
    job = job_queue.get_job(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _to_response(job)


@router.post("/{job_id}/ack", response_model=LLMJobResponse)
def ack_job(job_id: str, db: Session = Depends(get_db)) -> LLMJobResponse:
    job = job_queue.ack(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _to_response(job)


@router.post("/{job_id}/retry", response_model=LLMJobResponse)
def retry_job(job_id: str, db: Session = Depends(get_db)) -> LLMJobResponse:
    job = job_queue.retry(db, job_id)
    if not job:
        raise HTTPException(status_code=400, detail="Only failed jobs can be retried")
    return _to_response(job)


internal_router = APIRouter(
    prefix="/internal/llm-jobs", tags=["llm-jobs-internal"],
    dependencies=[Depends(require_worker_secret)],
)


@internal_router.post("/claim", response_model=LLMJobClaimResponse | None)
def claim_endpoint(db: Session = Depends(get_db)):
    job = job_queue.claim_next(db)
    if not job:
        return None
    return LLMJobClaimResponse(
        job_id=job.job_id, context=job.context, task_type=job.task_type,
        provider=job.provider, model=job.model, effort=job.effort,
        json_requested=job.json_requested,
        request_payload=json.loads(job.request_payload),
        attempt_count=job.attempt_count,
    )


@internal_router.post("/{job_id}/result", response_model=LLMJobResponse)
def result_endpoint(job_id: str, body: LLMJobResultRequest, db: Session = Depends(get_db)) -> LLMJobResponse:
    job = job_queue.record_result(
        db, job_id, response_text=body.response_text, response_payload=body.response_payload,
        model=body.model, effort=body.effort, prompt_tokens=body.prompt_tokens,
        response_tokens=body.response_tokens, total_tokens=body.total_tokens,
        latency_ms=body.latency_ms, estimated_cost=body.estimated_cost, json_valid=body.json_valid,
    )
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job is not None and job.status == "succeeded":
        from ..services import result_hooks
        result_hooks.run_hook(db, job)
    return _to_response(job)


@internal_router.post("/{job_id}/fail", response_model=LLMJobResponse)
def fail_endpoint(job_id: str, body: LLMJobFailRequest, db: Session = Depends(get_db)) -> LLMJobResponse:
    job = job_queue.record_failure(db, job_id, error=body.error)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _to_response(job)


@internal_router.post("/{job_id}/heartbeat")
def heartbeat_endpoint(job_id: str, db: Session = Depends(get_db)) -> dict:
    job = job_queue.heartbeat(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not running")
    return {"ok": True, "lease_expires_at": job.lease_expires_at.isoformat()}
