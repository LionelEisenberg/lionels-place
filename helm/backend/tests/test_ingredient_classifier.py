"""Tests for the sync ingredient-classify entry point (classify_ingredients),
which routes cache misses through the LLM job queue via enqueue_and_wait."""

# Import models at module level so they register with Base before the db fixture
# calls create_all (same pattern as other test files in this suite).
import backend.models  # noqa: F401


def test_classify_ingredients_all_cached_skips_queue(db, monkeypatch):
    from backend.services import ingredient_classifier
    from backend.models import IngredientCategory

    db.add(IngredientCategory(name="garlic", category="Produce"))
    db.commit()

    def _boom(*a, **k):
        raise AssertionError("enqueue_and_wait should not be called on an all-cache-hit request")
    monkeypatch.setattr(ingredient_classifier.job_queue, "enqueue_and_wait", _boom)

    result = ingredient_classifier.classify_ingredients(["garlic"], db)
    assert result == {"garlic": "Produce"}


def test_classify_ingredients_cache_miss_uses_queue_result(db, monkeypatch):
    from backend.services import ingredient_classifier
    from backend.models import IngredientCategory

    captured = {}

    def _fake_wait(db_arg, *, context, task_type, request_payload, provider=None,
                   service=None, method=None, timeout_s=None):
        captured["context"] = context
        captured["task_type"] = task_type
        captured["payload"] = request_payload
        # Simulate the worker + result hook: persist the classified category
        # into IngredientCategory (mirrors _apply_ingredient_classify) and
        # return a succeeded job.
        db_arg.add(IngredientCategory(name="dragonfruit", category="Produce"))
        db_arg.commit()

        class FakeJob:
            status = "succeeded"
        return FakeJob()

    monkeypatch.setattr(ingredient_classifier.job_queue, "enqueue_and_wait", _fake_wait)

    result = ingredient_classifier.classify_ingredients(["dragonfruit"], db)
    assert result == {"dragonfruit": "Produce"}
    assert captured["context"] == "ingredient_classify"
    assert captured["task_type"] == "ingredient_classify"
    assert captured["payload"]["want_json"] is True


def test_classify_ingredients_queue_timeout_falls_back_to_other(db, monkeypatch):
    from backend.services import ingredient_classifier

    monkeypatch.setattr(ingredient_classifier.job_queue, "enqueue_and_wait", lambda *a, **k: None)

    result = ingredient_classifier.classify_ingredients(["dragonfruit"], db)
    assert result == {"dragonfruit": "Other"}


def test_classify_ingredients_queue_failure_falls_back_to_other(db, monkeypatch):
    from backend.services import ingredient_classifier

    class FailedJob:
        status = "failed"
    monkeypatch.setattr(ingredient_classifier.job_queue, "enqueue_and_wait", lambda *a, **k: FailedJob())

    result = ingredient_classifier.classify_ingredients(["dragonfruit"], db)
    assert result == {"dragonfruit": "Other"}


def test_classify_ingredients_mixed_cache_hit_and_miss(db, monkeypatch):
    from backend.services import ingredient_classifier
    from backend.models import IngredientCategory

    db.add(IngredientCategory(name="garlic", category="Produce"))
    db.commit()

    def _fake_wait(db_arg, **k):
        db_arg.add(IngredientCategory(name="dragonfruit", category="Produce"))
        db_arg.commit()
        class FakeJob:
            status = "succeeded"
        return FakeJob()

    monkeypatch.setattr(ingredient_classifier.job_queue, "enqueue_and_wait", _fake_wait)

    result = ingredient_classifier.classify_ingredients(["garlic", "dragonfruit"], db)
    assert result == {"garlic": "Produce", "dragonfruit": "Produce"}
