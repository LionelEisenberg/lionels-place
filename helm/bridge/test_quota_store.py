"""Tests for the worker-local Gemini quota/RPM store."""

import importlib
import os
import pytest


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKER_STATE_DIR", str(tmp_path))
    import quota_store
    importlib.reload(quota_store)     # re-read WORKER_STATE_DIR
    return quota_store


def test_increment_and_get_count(store):
    assert store.get_count("2026-06-30", "free-tier-1", "m") == 0
    store.increment("2026-06-30", "free-tier-1", "m")
    store.increment("2026-06-30", "free-tier-1", "m")
    assert store.get_count("2026-06-30", "free-tier-1", "m") == 2
    # isolated per (date, project, model)
    assert store.get_count("2026-06-30", "free-tier-2", "m") == 0


def test_rpm_timestamps(store):
    assert store.get_last_ts("free-tier-1") == 0.0
    store.set_last_ts("free-tier-1", 123.5)
    assert store.get_last_ts("free-tier-1") == 123.5


def test_state_persists_across_reopen(store):
    store.increment("d", "p", "m")
    import importlib
    importlib.reload(store)            # new connection, same file
    assert store.get_count("d", "p", "m") == 1
