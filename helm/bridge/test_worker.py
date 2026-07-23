"""Tests for the worker poll loop (one iteration at a time; deps mocked)."""

from unittest.mock import patch
import worker


def _job():
    return {"job_id": "j1", "task_type": "chat", "provider": None, "model": None,
            "effort": None, "json_requested": False, "attempt_count": 1,
            "request_payload": {"system_prompt": "", "prompt": "hi", "want_json": False, "image_base64": None}}


def test_process_once_no_job_returns_false():
    with patch("worker.helm_client.claim", return_value=None):
        assert worker.process_once() is False       # nothing claimed


def test_process_once_success_posts_result():
    with patch("worker.helm_client.claim", return_value=_job()):
        with patch("worker.dispatch.run_job", return_value={"text": "hi", "model": "m",
                    "prompt_tokens": 1, "response_tokens": 2, "total_tokens": 3,
                    "latency_ms": 10, "estimated_cost": 0.0, "json_valid": None, "error": None}):
            with patch("worker.helm_client.post_result") as pr:
                with patch("worker.helm_client.post_fail") as pf:
                    assert worker.process_once() is True
    pr.assert_called_once()
    assert pr.call_args.args[0] == "j1"
    assert pr.call_args.args[1]["response_text"] == "hi"
    pf.assert_not_called()


def test_process_once_failure_posts_fail():
    with patch("worker.helm_client.claim", return_value=_job()):
        with patch("worker.dispatch.run_job", return_value={"text": "", "error": "boom"}):
            with patch("worker.helm_client.post_result") as pr:
                with patch("worker.helm_client.post_fail") as pf:
                    assert worker.process_once() is True
    pf.assert_called_once_with("j1", "boom")
    pr.assert_not_called()


def test_process_once_dispatch_exception_posts_fail():
    with patch("worker.helm_client.claim", return_value=_job()):
        with patch("worker.dispatch.run_job", side_effect=RuntimeError("kaboom")):
            with patch("worker.helm_client.post_fail") as pf:
                assert worker.process_once() is True
    assert "kaboom" in pf.call_args.args[1]


def test_process_once_heartbeats_during_slow_dispatch(monkeypatch):
    monkeypatch.setenv("WORKER_HEARTBEAT_INTERVAL", "0.05")
    import importlib, worker as w
    importlib.reload(w)
    beats = []
    def slow_run(job):
        import time; time.sleep(0.18)
        return {"text": "ok", "model": "m", "prompt_tokens": 0, "response_tokens": 0,
                "total_tokens": 0, "latency_ms": 0, "estimated_cost": 0.0,
                "json_valid": None, "error": None}
    job = {"job_id": "j1", "task_type": "chat", "provider": None, "model": None,
           "effort": None, "json_requested": False, "attempt_count": 1,
           "request_payload": {"system_prompt": "", "prompt": "hi", "want_json": False, "image_base64": None}}
    from unittest.mock import patch
    with patch("worker.helm_client.claim", return_value=job):
        with patch("worker.dispatch.run_job", side_effect=slow_run):
            with patch("worker.helm_client.post_result"):
                with patch("worker.helm_client.heartbeat", side_effect=lambda jid: beats.append(jid)):
                    assert w.process_once() is True
    assert len(beats) >= 1        # heartbeat fired during the ~0.18s dispatch (interval 0.05)
