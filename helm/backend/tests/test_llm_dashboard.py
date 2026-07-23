"""Dashboard reads from llm_jobs (Phase 2C-1 Task 6)."""

# Import models at module level so they register with Base before the db fixture
# calls create_all (same pattern as other test files in this suite).
import backend.models  # noqa: F401


def test_dashboard_counts_from_llm_jobs(db):
    from backend.routers.gemini_dashboard import _summary_counts
    from backend.services import job_queue
    j = job_queue.enqueue(db, context="c", task_type="chat", request_payload={"prompt": "p"}, provider="claude")
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text="ok", total_tokens=5, estimated_cost=0.02, model="claude-opus-4-6")
    total, claude, gemini, cost = _summary_counts(db)
    assert total == 1 and claude == 1 and gemini == 0
    assert round(cost, 2) == 0.02
