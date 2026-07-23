"""Tests for the result-hook registry — post-processing run when a queued LLM job succeeds."""


def test_advisor_chat_reply_hook_saves_message(db):
    from backend.services import result_hooks, job_queue
    from backend.models import ChatMessage
    job = job_queue.enqueue(db, context="advisor_chat", task_type="chat", request_payload={"prompt": "hi"})
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text="Here is advice.")
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))
    msgs = db.query(ChatMessage).filter(ChatMessage.role == "assistant").all()
    assert any(m.content == "Here is advice." for m in msgs)


def test_run_hook_noop_for_unregistered_context(db):
    from backend.services import result_hooks, job_queue
    job = job_queue.enqueue(db, context="workout_log", task_type="plan_workout", request_payload={})
    result_hooks.run_hook(db, job)   # no hook for workout_log — must not raise


def test_ingredient_classify_hook_remaps_to_original_names_and_caches(db):
    import json
    from backend.services import result_hooks, job_queue
    from backend.models import IngredientCategory

    # "Garlic (minced)" normalizes to "garlic"; the LLM result is keyed by the
    # normalized form. context_key carries the original names.
    job = job_queue.enqueue(
        db, context="ingredient_classify", task_type="ingredient_classify",
        request_payload={"context_key": json.dumps(["Garlic (minced)"])},
    )
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text=json.dumps({"garlic": "Produce"}))
    job = job_queue.get_job(db, claimed.job_id)

    result_hooks.run_hook(db, job)

    # response_text is remapped to the ORIGINAL name so the frontend's
    # `categories[ing.name]` lookup (RecipeBank.tsx) succeeds.
    assert json.loads(job.response_text) == {"Garlic (minced)": "Produce"}

    # Cache miss is persisted under the NORMALIZED name, mirroring the sync path.
    cached = db.query(IngredientCategory).filter(IngredientCategory.name == "garlic").first()
    assert cached is not None
    assert cached.category == "Produce"


def test_ingredient_classify_hook_defaults_invalid_category_to_other(db):
    import json
    from backend.services import result_hooks, job_queue
    from backend.models import IngredientCategory

    job = job_queue.enqueue(
        db, context="ingredient_classify", task_type="ingredient_classify",
        request_payload={"context_key": json.dumps(["dragonfruit"])},
    )
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text=json.dumps({"dragonfruit": "NotACategory"}))
    job = job_queue.get_job(db, claimed.job_id)

    result_hooks.run_hook(db, job)

    assert json.loads(job.response_text) == {"dragonfruit": "Other"}
    cached = db.query(IngredientCategory).filter(IngredientCategory.name == "dragonfruit").first()
    assert cached is not None
    assert cached.category == "Other"


def test_ingredient_classify_hook_noop_without_response_text(db):
    from backend.services import result_hooks, job_queue
    job = job_queue.enqueue(db, context="ingredient_classify", task_type="ingredient_classify", request_payload={})
    result_hooks.run_hook(db, job)  # no response_text — must not raise
