"""Tests for the Helm internal-API client."""

from unittest.mock import MagicMock, patch
import helm_client


def _resp(json_body, status=200):
    r = MagicMock(); r.status_code = status; r.json.return_value = json_body
    r.raise_for_status = MagicMock()
    return r


def test_claim_returns_job(monkeypatch):
    monkeypatch.setenv("HELM_INTERNAL_URL", "http://helm:8001")
    monkeypatch.setenv("HELM_WORKER_SECRET", "s")
    with patch("httpx.post", return_value=_resp({"job_id": "j1", "task_type": "chat"})) as mp:
        job = helm_client.claim()
    assert job["job_id"] == "j1"
    assert mp.call_args.kwargs["headers"]["Authorization"] == "Bearer s"


def test_claim_returns_none_on_empty(monkeypatch):
    monkeypatch.setenv("HELM_INTERNAL_URL", "http://helm:8001")
    with patch("httpx.post", return_value=_resp(None)):
        assert helm_client.claim() is None


def test_post_result_and_fail(monkeypatch):
    monkeypatch.setenv("HELM_INTERNAL_URL", "http://helm:8001")
    with patch("httpx.post", return_value=_resp({"ok": True})) as mp:
        helm_client.post_result("j1", {"response_text": "hi", "total_tokens": 3})
        helm_client.post_fail("j1", "boom")
    assert mp.call_count == 2
    assert "/internal/llm-jobs/j1/result" in mp.call_args_list[0].args[0]
    assert "/internal/llm-jobs/j1/fail" in mp.call_args_list[1].args[0]
