"""Client for Helm's internal llm-jobs API. The worker's only link to Helm."""

import os

import httpx

_TIMEOUT = float(os.getenv("HELM_INTERNAL_TIMEOUT", "30"))


def _base() -> str:
    return os.getenv("HELM_INTERNAL_URL", "http://helm:8001").rstrip("/")


def _headers() -> dict:
    return {"Authorization": f"Bearer {os.getenv('HELM_WORKER_SECRET', '')}"}


def claim() -> dict | None:
    r = httpx.post(f"{_base()}/internal/llm-jobs/claim", headers=_headers(), timeout=_TIMEOUT)
    r.raise_for_status()
    return r.json()          # a job dict, or null when the queue is empty


def post_result(job_id: str, result: dict) -> None:
    r = httpx.post(f"{_base()}/internal/llm-jobs/{job_id}/result",
                   json=result, headers=_headers(), timeout=_TIMEOUT)
    r.raise_for_status()


def post_fail(job_id: str, error: str) -> None:
    r = httpx.post(f"{_base()}/internal/llm-jobs/{job_id}/fail",
                   json={"error": error}, headers=_headers(), timeout=_TIMEOUT)
    r.raise_for_status()


def heartbeat(job_id: str) -> None:
    try:
        httpx.post(f"{_base()}/internal/llm-jobs/{job_id}/heartbeat",
                   headers=_headers(), timeout=_TIMEOUT)
    except Exception:        # heartbeat is best-effort; never crash the worker on it
        pass
