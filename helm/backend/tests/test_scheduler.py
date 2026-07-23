"""Tests for the in-process Google Health sync scheduler."""
from unittest.mock import MagicMock

from backend import scheduler


def test_run_sync_job_swallows_errors(monkeypatch):
    monkeypatch.setattr(scheduler, "SessionLocal", lambda: MagicMock())
    def boom(db):
        raise RuntimeError("kaboom")
    monkeypatch.setattr(scheduler.ghs, "run_sync", boom)
    # Must NOT raise — a scheduler job that throws would kill the thread.
    scheduler._run_sync_job()


def test_start_scheduler_registers_hourly_job():
    s = scheduler.start_scheduler()
    try:
        assert s.get_job("google_health_sync") is not None
    finally:
        scheduler.shutdown_scheduler()
