"""Tests for worker provider dispatch."""

from unittest.mock import patch
import dispatch


def _job(**kw):
    base = {"job_id": "j1", "task_type": "chat", "provider": None, "model": None,
            "effort": None, "json_requested": False, "attempt_count": 1,
            "request_payload": {"system_prompt": "s", "prompt": "hi", "want_json": False, "image_base64": None}}
    base.update(kw)
    return base


def test_dispatch_defaults_to_claude(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "claude")
    monkeypatch.setenv("LLM_FALLBACK", "")
    with patch.object(dispatch, "_run_claude", return_value={"text": "c", "error": None}) as mc:
        out = dispatch.run_job(_job())
    assert out["text"] == "c"
    mc.assert_called_once()


def test_dispatch_image_forces_gemini(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "claude")
    job = _job(request_payload={"system_prompt": "", "prompt": "describe", "want_json": False, "image_base64": "aGk="})
    with patch.object(dispatch, "_run_gemini", return_value={"text": "g", "error": None}) as mg:
        with patch.object(dispatch, "_run_claude") as mc:
            out = dispatch.run_job(job)
    assert out["text"] == "g"
    mc.assert_not_called()


def test_dispatch_falls_back_on_error(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "claude")
    monkeypatch.setenv("LLM_FALLBACK", "gemini")
    with patch.object(dispatch, "_run_claude", return_value={"text": "", "error": "bridge down"}):
        with patch.object(dispatch, "_run_gemini", return_value={"text": "g", "error": None}) as mg:
            out = dispatch.run_job(_job())
    assert out["text"] == "g"
    mg.assert_called_once()


def test_dispatch_no_fallback_returns_error(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "claude")
    monkeypatch.setenv("LLM_FALLBACK", "")
    with patch.object(dispatch, "_run_claude", return_value={"text": "", "error": "bridge down"}):
        out = dispatch.run_job(_job())
    assert out["error"] == "bridge down"
