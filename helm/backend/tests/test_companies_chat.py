"""Tests for extracted Companies-chat marker handling + queue hook."""


def test_apply_company_actions_adds_and_cleans(db):
    from backend.routers.companies import apply_company_actions
    from backend.models import Company
    clean, added, updated, removed_ids = apply_company_actions(
        db,
        'Sure! [ADD_COMPANY: name="Bungie", tier="gaming_t2", location="Bellevue"] Done.',
    )
    assert 'ADD_COMPANY' not in clean
    assert len(added) == 1
    assert updated == []
    assert removed_ids == []
    assert db.query(Company).filter(Company.name == "Bungie").count() == 1


def test_companies_chat_hook(db):
    from backend.services import result_hooks, job_queue
    from backend.models import Company
    job = job_queue.enqueue(db, context="companies_chat", task_type="chat", request_payload={"prompt": "x"})
    claimed = job_queue.claim_next(db)
    job_queue.record_result(
        db, claimed.job_id,
        response_text='[ADD_COMPANY: name="Bungie", tier="gaming_t2"] ok',
    )
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))
    assert db.query(Company).filter(Company.name == "Bungie").count() == 1
    refreshed = job_queue.get_job(db, claimed.job_id)
    assert 'ADD_COMPANY' not in (refreshed.response_text or '')     # cleaned text stored back
