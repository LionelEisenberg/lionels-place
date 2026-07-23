"""Tests for ingredient classify — cache-first, only misses enqueue to the queue."""


def test_classify_names_async_cache_hit_skips_enqueue(db):
    from backend.routers import shopping_list
    from backend.models import IngredientCategory

    db.add(IngredientCategory(name="garlic", category="Produce"))
    db.commit()

    result = shopping_list.classify_names_async({"names": ["garlic"]}, db)
    assert result["cached"] == {"garlic": "Produce"}
    assert result["job_id"] is None


def test_classify_names_async_cache_miss_enqueues(db, monkeypatch):
    import json
    from backend.routers import shopping_list
    from backend.services.ingredient_classifier import IngredientClassifierService

    captured = {}

    def _fake_enqueue(self, contents, config, *, task_type, context, method=None, context_key=None):
        captured["task_type"] = task_type
        captured["context"] = context
        captured["context_key"] = context_key
        return "fake-job-id"

    monkeypatch.setattr(IngredientClassifierService, "_enqueue", _fake_enqueue)

    result = shopping_list.classify_names_async({"names": ["dragonfruit"]}, db)
    assert result["cached"] == {}
    assert result["job_id"] == "fake-job-id"
    assert captured["context"] == "ingredient_classify"
    assert captured["task_type"] == "ingredient_classify"
    # context_key carries the original (pre-normalization) names as JSON so the
    # result hook can remap the LLM's normalized-name keys back to originals.
    assert json.loads(captured["context_key"]) == ["dragonfruit"]


def test_classify_names_async_context_key_preserves_original_casing(db, monkeypatch):
    """A cache-miss ingredient with uppercase/parenthetical text must have its
    ORIGINAL (unnormalized) form stashed in context_key, not the normalized form."""
    import json
    from backend.routers import shopping_list
    from backend.services.ingredient_classifier import IngredientClassifierService

    captured = {}
    monkeypatch.setattr(
        IngredientClassifierService, "_enqueue",
        lambda self, contents, config, *, task_type, context, method=None, context_key=None: (
            captured.update(context_key=context_key) or "fake-job-id"
        ),
    )

    result = shopping_list.classify_names_async({"names": ["Garlic (minced)"]}, db)
    assert result["job_id"] == "fake-job-id"
    assert json.loads(captured["context_key"]) == ["Garlic (minced)"]


def test_classify_names_async_mixed_cache_hit_and_miss(db, monkeypatch):
    from backend.routers import shopping_list
    from backend.models import IngredientCategory
    from backend.services.ingredient_classifier import IngredientClassifierService

    db.add(IngredientCategory(name="garlic", category="Produce"))
    db.commit()

    monkeypatch.setattr(IngredientClassifierService, "_enqueue", lambda self, *a, **k: "fake-job-id")

    result = shopping_list.classify_names_async({"names": ["garlic", "dragonfruit"]}, db)
    assert result["cached"] == {"garlic": "Produce"}
    assert result["job_id"] == "fake-job-id"
