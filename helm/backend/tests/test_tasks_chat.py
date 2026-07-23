"""Tests for extracted Tasks-chat marker handling + queue hook."""


def test_apply_task_actions_creates_and_cleans(db):
    from backend.routers.tasks import apply_task_actions
    from backend.models import Task
    clean = apply_task_actions(db, 'Sure! [CREATE_TASK: title="Update resume", category="Job Search", priority="high", due_date="none"] Done.')
    assert 'CREATE_TASK' not in clean
    assert db.query(Task).filter(Task.title == "Update resume").count() == 1


def test_tasks_chat_hook(db):
    from backend.services import result_hooks, job_queue
    from backend.models import Task
    job = job_queue.enqueue(db, context="tasks_chat", task_type="chat", request_payload={"prompt": "x"})
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text='[CREATE_TASK: title="Buy milk", category="Personal"] ok')
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))
    assert db.query(Task).filter(Task.title == "Buy milk").count() == 1
    refreshed = job_queue.get_job(db, claimed.job_id)
    assert 'CREATE_TASK' not in (refreshed.response_text or '')     # cleaned text stored back
