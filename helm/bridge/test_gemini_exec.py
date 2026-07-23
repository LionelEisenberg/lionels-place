"""Tests for the Gemini executor (routing + quota; genai mocked)."""

import importlib
from unittest.mock import MagicMock
import pytest


@pytest.fixture
def gx(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKER_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("GEMINI_PAID_KEY", "paid")
    monkeypatch.setenv("GEMINI_FREE_KEY_1", "free1")
    import quota_store; importlib.reload(quota_store)
    import gemini_exec; importlib.reload(gemini_exec)
    return gemini_exec


def _fake_response(text="hi", pt=10, ct=5, tt=15):
    r = MagicMock()
    r.text = text
    r.usage_metadata = MagicMock(prompt_token_count=pt, candidates_token_count=ct, total_token_count=tt)
    return r


def test_run_gemini_uses_paid_for_parse_input(gx, monkeypatch):
    client = MagicMock()
    client.models.generate_content.return_value = _fake_response(text='{"ok":true}')
    monkeypatch.setattr(gx, "_client_for", lambda project: client)
    out = gx.run_gemini(task_type="parse_input", system_prompt="s", prompt="200g chicken",
                        want_json=True, image_base64=None, model=None)
    assert out["text"] == '{"ok":true}'
    assert out["total_tokens"] == 15
    assert out["json_valid"] is True
    assert out["error"] is None


def test_run_gemini_advances_on_rate_limit(gx, monkeypatch):
    good = MagicMock(); good.models.generate_content.return_value = _fake_response()
    bad = MagicMock(); bad.models.generate_content.side_effect = Exception("429 RESOURCE_EXHAUSTED")
    # first tier fails, second succeeds
    seq = [bad, good]
    monkeypatch.setattr(gx, "_client_for", lambda project: seq.pop(0))
    out = gx.run_gemini(task_type="chat", system_prompt="", prompt="hi",
                        want_json=False, image_base64=None, model=None)
    assert out["text"] == "hi"


def test_run_gemini_reports_error_when_all_fail(gx, monkeypatch):
    bad = MagicMock(); bad.models.generate_content.side_effect = Exception("boom non-retryable")
    monkeypatch.setattr(gx, "_client_for", lambda project: bad)
    out = gx.run_gemini(task_type="chat", system_prompt="", prompt="hi",
                        want_json=False, image_base64=None, model=None)
    assert out["error"]
