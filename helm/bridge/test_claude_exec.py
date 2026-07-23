# helm/bridge/test_claude_exec.py
"""Tests for the Claude executor."""

from unittest.mock import patch
import claude_exec


def test_strip_code_fences_json():
    assert claude_exec.strip_code_fences('```json\n{"a":1}\n```') == '{"a":1}'


def test_run_claude_returns_normalized(monkeypatch):
    async def fake_query(system_prompt, prompt, effort, model):
        return {"text": "hello", "model": "claude-opus-4-6", "input_tokens": 10,
                "output_tokens": 5, "cache_read_tokens": 0, "cache_creation_tokens": 0,
                "total_cost_usd": 0.01, "error": None}
    monkeypatch.setattr(claude_exec, "_query_claude", fake_query)
    out = claude_exec.run_claude(system_prompt="sys", prompt="hi", want_json=False,
                                 effort="high", model="claude-opus-4-6")
    assert out["text"] == "hello"
    assert out["total_tokens"] == 15
    assert out["json_valid"] is None


def test_run_claude_validates_json(monkeypatch):
    async def fake_query(system_prompt, prompt, effort, model):
        return {"text": '```json\n{"ok":true}\n```', "model": "m", "input_tokens": 1,
                "output_tokens": 1, "cache_read_tokens": 0, "cache_creation_tokens": 0,
                "total_cost_usd": 0.0, "error": None}
    monkeypatch.setattr(claude_exec, "_query_claude", fake_query)
    out = claude_exec.run_claude(system_prompt="", prompt="x", want_json=True, effort="low", model="m")
    assert out["text"] == '{"ok":true}'   # fences stripped
    assert out["json_valid"] is True


def test_run_claude_surfaces_error(monkeypatch):
    async def fake_query(system_prompt, prompt, effort, model):
        return {"text": None, "error": "CLI crashed"}
    monkeypatch.setattr(claude_exec, "_query_claude", fake_query)
    out = claude_exec.run_claude(system_prompt="", prompt="x", want_json=False, effort="low", model="m")
    assert out["error"] == "CLI crashed"
