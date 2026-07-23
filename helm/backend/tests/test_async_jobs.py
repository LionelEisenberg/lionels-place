"""Tests for the /async endpoints — job creation via the queue, status polling."""

from backend.routers import async_jobs


def test_plan_workout_async_enqueues_llmjob(db, monkeypatch):
    from backend.routers import async_jobs
    from backend.schemas import WorkoutPlanRequest
    from backend.models import LLMJob
    # _enqueue() opens its own session via base_llm.SessionLocal — point that at the test db.
    monkeypatch.setattr("backend.services.base_llm.SessionLocal", lambda: db)
    resp = async_jobs.plan_workout_async(WorkoutPlanRequest(day_type="Push", notes="n"), db)
    job = db.query(LLMJob).filter(LLMJob.job_id == resp.job_id).first()
    assert job is not None
    assert job.task_type == "plan_workout"
    assert job.context == "workout_log"
    assert job.status == "queued"
    payload = __import__("json").loads(job.request_payload)
    assert payload["want_json"] is True and "JSON SCHEMA" in payload["prompt"]


def test_get_job_status_reads_llmjob(db):
    from backend.routers import async_jobs
    from backend.services import job_queue
    job = job_queue.enqueue(db, context="workout_log", task_type="plan_workout",
                            request_payload={"prompt": "p", "want_json": True})
    # simulate the worker completing it
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text='{"workout_type": "Push"}', json_valid=True)
    status = async_jobs.get_job_status(claimed.job_id, db)
    assert status.status == "completed"          # succeeded -> completed
    assert status.result == {"workout_type": "Push"}


def test_advisor_chat_async_enqueues_and_saves_user_msg(db, monkeypatch):
    from backend.routers import async_jobs
    from backend.schemas import AdvisorChatRequest
    from backend.models import LLMJob, ChatMessage
    # _enqueue() opens its own session via base_llm.SessionLocal — point that at the test db.
    monkeypatch.setattr("backend.services.base_llm.SessionLocal", lambda: db)
    resp = async_jobs.advisor_chat_async(AdvisorChatRequest(message="how am I doing?"), db)
    job = db.query(LLMJob).filter(LLMJob.job_id == resp.job_id).first()
    assert job is not None and job.context == "advisor_chat" and job.task_type == "chat"
    assert db.query(ChatMessage).filter(ChatMessage.role == "user", ChatMessage.content == "how am I doing?").count() == 1
