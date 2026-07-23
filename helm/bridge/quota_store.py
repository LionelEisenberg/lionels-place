"""Worker-local Gemini quota + RPM state (SQLite). Replaces the Helm gemini_quotas
table for the standalone worker — the worker has no access to Helm's DB.

Per-day counters are naturally ephemeral; losing this file only resets today's
free-tier counts, so the volume needs no backup.
"""

import os
import sqlite3
import threading

_STATE_DIR = os.getenv("WORKER_STATE_DIR", "/state")
_DB_PATH = os.path.join(_STATE_DIR, "provider_state.db")
_lock = threading.Lock()
_conn_obj: sqlite3.Connection | None = None


def _get_conn() -> sqlite3.Connection:
    global _conn_obj
    if _conn_obj is None:
        os.makedirs(_STATE_DIR, exist_ok=True)
        _conn_obj = sqlite3.connect(_DB_PATH, check_same_thread=False)
        _conn_obj.execute(
            "CREATE TABLE IF NOT EXISTS gemini_quota "
            "(date TEXT, project TEXT, model TEXT, count INTEGER, "
            "PRIMARY KEY (date, project, model))"
        )
        _conn_obj.execute(
            "CREATE TABLE IF NOT EXISTS gemini_rpm (project TEXT PRIMARY KEY, last_ts REAL)"
        )
        _conn_obj.commit()
    return _conn_obj


def get_count(date: str, project: str, model: str) -> int:
    with _lock:
        conn = _get_conn()
        row = conn.execute(
            "SELECT count FROM gemini_quota WHERE date=? AND project=? AND model=?",
            (date, project, model),
        ).fetchone()
        return row[0] if row else 0


def increment(date: str, project: str, model: str) -> None:
    with _lock:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO gemini_quota (date, project, model, count) VALUES (?,?,?,1) "
            "ON CONFLICT(date, project, model) DO UPDATE SET count = count + 1",
            (date, project, model),
        )
        conn.commit()


def get_last_ts(project: str) -> float:
    with _lock:
        conn = _get_conn()
        row = conn.execute("SELECT last_ts FROM gemini_rpm WHERE project=?", (project,)).fetchone()
        return row[0] if row else 0.0


def set_last_ts(project: str, ts: float) -> None:
    with _lock:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO gemini_rpm (project, last_ts) VALUES (?,?) "
            "ON CONFLICT(project) DO UPDATE SET last_ts = excluded.last_ts",
            (project, ts),
        )
        conn.commit()
