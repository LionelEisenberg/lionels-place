"""Tests for RecipeBank parse-url/parse-text going through the llm_jobs queue.
No markers here — the job's JSON result IS the payload the page consumes."""

import json


def test_parse_url_prompt_builds_prompt_and_config():
    from backend.services.recipe_parser import RecipeParserService
    parser = RecipeParserService()
    prompt, config = parser.parse_url_prompt("https://example.com/recipe", "<html>Ribs recipe</html>", instructions="halve it")
    assert "https://example.com/recipe" in prompt
    assert "Ribs recipe" in prompt
    assert "halve it" in prompt
    assert config.response_mime_type == "application/json"


def test_parse_text_prompt_builds_prompt_and_config():
    from backend.services.recipe_parser import RecipeParserService
    parser = RecipeParserService()
    prompt, config = parser.parse_text_prompt("1 cup flour, mix well", instructions=None)
    assert "1 cup flour, mix well" in prompt
    assert config.response_mime_type == "application/json"


def test_recipe_parse_url_async_enqueues_job(db, monkeypatch):
    from backend.routers import async_jobs
    from backend.schemas import ParseUrlRequest
    from backend.services.recipe_parser import RecipeParserService

    monkeypatch.setattr(RecipeParserService, "_fetch_page", lambda self, url: "<html>fake page</html>")

    captured = {}

    def _fake_enqueue(self, contents, config, *, task_type, context, method=None, context_key=None):
        captured["task_type"] = task_type
        captured["context"] = context
        return "fake-job-id"

    monkeypatch.setattr(RecipeParserService, "_enqueue", _fake_enqueue)

    resp = async_jobs.recipe_parse_url_async(ParseUrlRequest(url="https://example.com/x", instructions=None), db)
    assert resp.job_id == "fake-job-id"
    assert captured["context"] == "recipe_parse"
    assert captured["task_type"] == "recipe_parse"


def test_recipe_parse_text_async_enqueues_job(db, monkeypatch):
    from backend.routers import async_jobs
    from backend.schemas import ParseTextRequest
    from backend.services.recipe_parser import RecipeParserService

    captured = {}

    def _fake_enqueue(self, contents, config, *, task_type, context, method=None, context_key=None):
        captured["task_type"] = task_type
        captured["context"] = context
        return "fake-job-id"

    monkeypatch.setattr(RecipeParserService, "_enqueue", _fake_enqueue)

    resp = async_jobs.recipe_parse_text_async(ParseTextRequest(text="a" * 25, source_url=None, instructions=None), db)
    assert resp.job_id == "fake-job-id"
    assert captured["context"] == "recipe_parse"


def test_recipe_parse_poll_result_is_recipe_json(db):
    """The poll result for a recipe_parse job is the recipe dict — no hook needed."""
    from backend.services import job_queue, result_hooks

    job = job_queue.enqueue(db, context="recipe_parse", task_type="recipe_parse", request_payload={"prompt": "x"})
    claimed = job_queue.claim_next(db)
    recipe_json = json.dumps({"name": "Test Recipe", "instructions": "1. Do it.", "ingredients": []})
    job_queue.record_result(db, claimed.job_id, response_text=recipe_json)
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))  # no-op, must not raise

    refreshed = job_queue.get_job(db, claimed.job_id)
    parsed = json.loads(refreshed.response_text)
    assert parsed["name"] == "Test Recipe"
