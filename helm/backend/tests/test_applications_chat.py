"""Tests for extracted Applications-chat marker handling + queue hook."""


def test_apply_application_actions_creates_and_cleans(db):
    from backend.routers.applications import apply_application_actions
    from backend.models import Application
    clean, created, updated = apply_application_actions(
        db,
        'Sure! [CREATE_APP: company_name="Riot Games", job_title="Backend Engineer", status="applied"] Done.',
    )
    assert 'CREATE_APP' not in clean
    assert len(created) == 1
    assert updated == []
    assert db.query(Application).filter(Application.company_name == "Riot Games").count() == 1


def test_applications_chat_hook(db):
    from backend.services import result_hooks, job_queue
    from backend.models import Application
    job = job_queue.enqueue(db, context="applications_chat", task_type="chat", request_payload={"prompt": "x"})
    claimed = job_queue.claim_next(db)
    job_queue.record_result(
        db, claimed.job_id,
        response_text='[CREATE_APP: company_name="Blizzard", job_title="SWE", status="applied"] ok',
    )
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))
    assert db.query(Application).filter(Application.company_name == "Blizzard").count() == 1
    refreshed = job_queue.get_job(db, claimed.job_id)
    assert 'CREATE_APP' not in (refreshed.response_text or '')     # cleaned text stored back
