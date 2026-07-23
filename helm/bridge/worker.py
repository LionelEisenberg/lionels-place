"""LLM worker: poll Helm's queue, execute jobs provider-agnostically, report back.

Runs as its own container (compose service `llm-worker`). It is the ONLY claimer —
claims are single-pathed through Helm's /internal/llm-jobs/claim (see 2A note)."""

import logging
import os
import threading
import time

import dispatch
import helm_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("llm-worker")

POLL_INTERVAL = float(os.getenv("WORKER_POLL_INTERVAL", "2"))
HEARTBEAT_INTERVAL = float(os.getenv("WORKER_HEARTBEAT_INTERVAL", "10"))


def _result_body(result: dict) -> dict:
    return {
        "response_text": result.get("text"),
        "model": result.get("model"),
        "effort": result.get("effort"),
        "prompt_tokens": result.get("prompt_tokens", 0),
        "response_tokens": result.get("response_tokens", 0),
        "total_tokens": result.get("total_tokens", 0),
        "latency_ms": result.get("latency_ms", 0),
        "estimated_cost": result.get("estimated_cost", 0.0),
        "json_valid": result.get("json_valid"),
    }


def process_once() -> bool:
    """Claim + process one job. Returns True if a job was handled, False if the queue was empty."""
    job = helm_client.claim()
    if not job:
        return False

    job_id = job["job_id"]
    stop = threading.Event()

    def _beat():
        while not stop.wait(HEARTBEAT_INTERVAL):
            helm_client.heartbeat(job_id)

    beat_thread = threading.Thread(target=_beat, daemon=True)
    beat_thread.start()
    try:
        result = dispatch.run_job(job)
        if result.get("error"):
            helm_client.post_fail(job_id, result["error"])
        else:
            helm_client.post_result(job_id, _result_body(result))
    except Exception as e:  # noqa: BLE001
        logger.exception("Job %s crashed", job_id)
        try:
            helm_client.post_fail(job_id, f"worker exception: {e}")
        except Exception:
            logger.exception("Failed to report failure for %s", job_id)
    finally:
        stop.set()
    return True


def run_forever() -> None:
    logger.info("llm-worker started; polling %s", os.getenv("HELM_INTERNAL_URL", "http://helm:8001"))
    while True:
        try:
            worked = process_once()
        except Exception:  # noqa: BLE001 — never let the loop die
            logger.exception("claim/poll error")
            worked = False
        if not worked:
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    run_forever()
