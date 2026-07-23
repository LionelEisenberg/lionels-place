"""Tests for BaseLLMService._enqueue (queue submission)."""


def test_enqueue_builds_payload_and_returns_job_id(monkeypatch):
    from backend.services.base_llm import BaseLLMService
    captured = {}
    class _Job: job_id = "jid123"
    def fake_enqueue(db, **kw):
        captured.update(kw); return _Job()
    monkeypatch.setattr("backend.services.base_llm.job_queue.enqueue", fake_enqueue)
    monkeypatch.setattr("backend.services.base_llm.SessionLocal", lambda: _FakeDB())
    svc = BaseLLMService()

    class Cfg:
        system_instruction = "SYS"; response_mime_type = "application/json"
    jid = svc._enqueue(contents="hello", config=Cfg(), task_type="plan_workout",
                       context="workout_log", method="plan_workout")
    assert jid == "jid123"
    p = captured["request_payload"]
    assert p == {"system_prompt": "SYS", "prompt": "hello", "want_json": True, "image_base64": None}
    assert captured["task_type"] == "plan_workout"
    assert captured["context"] == "workout_log"
    assert captured["method"] == "plan_workout"


class _FakeDB:
    def close(self): pass


def test_enqueue_passes_model_effort(monkeypatch):
    from backend.services.base_llm import BaseLLMService
    captured = {}
    class _Job: job_id = "j"
    monkeypatch.setattr("backend.services.base_llm.job_queue.enqueue", lambda db, **kw: (captured.update(kw) or _Job()))
    monkeypatch.setattr("backend.services.base_llm.SessionLocal", lambda: type("D", (), {"close": lambda s: None})())
    monkeypatch.setattr("backend.services.base_llm.get_setting", lambda k, d=None: {"llm_provider": "claude", "llm_model": "claude-opus-4-6", "llm_effort": "high"}.get(k, d))
    class Cfg: system_instruction = ""; response_mime_type = None
    BaseLLMService()._enqueue(contents="x", config=Cfg(), task_type="chat", context="c")
    assert captured["model"] == "claude-opus-4-6"
    assert captured["effort"] == "high"
