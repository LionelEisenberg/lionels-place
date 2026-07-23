"""Ingestion: fetchers, upserts, gap-fill, run_sync, backfill. All httpx mocked."""
import json
import os
from datetime import date

import httpx

from backend.services import google_health_service as ghs
from backend.models import DailyHealth, IntradayHeartRate, DailySummary


def test_helm_date_format():
    assert ghs._helm_date(date(2026, 6, 2)) == "2026-06-02"


def test_start_date_default(monkeypatch):
    monkeypatch.delenv("GOOGLE_HEALTH_START_DATE", raising=False)
    assert ghs._start_date() == date(2026, 6, 2)


def test_start_date_env_override(monkeypatch):
    monkeypatch.setenv("GOOGLE_HEALTH_START_DATE", "2026-01-15")
    assert ghs._start_date() == date(2026, 1, 15)


def test_sync_range_clamps_to_start(monkeypatch):
    monkeypatch.setenv("GOOGLE_HEALTH_START_DATE", "2026-06-02")
    start, end = ghs._sync_range(last_synced=None, today=date(2026, 6, 3))
    assert start == date(2026, 6, 2) and end == date(2026, 6, 3)
    start, _ = ghs._sync_range(last_synced=date(2026, 6, 2), today=date(2026, 6, 10))
    assert start == date(2026, 6, 2)


class _Resp:
    def __init__(self, data): self._data = data; self.status_code = 200
    def json(self): return self._data
    def raise_for_status(self): pass


def test_fetch_step_rollup(monkeypatch):
    payload = {"rollupDataPoints": [
        {"civilStartTime": {"date": {"year": 2026, "month": 6, "day": 2}},
         "civilEndTime": {"date": {"year": 2026, "month": 6, "day": 3}},
         "steps": {"countSum": "9240"}},
        {"civilStartTime": {"date": {"year": 2026, "month": 6, "day": 3}},
         "civilEndTime": {"date": {"year": 2026, "month": 6, "day": 4}},
         "steps": {"countSum": "12010"}},
    ]}
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp(payload))
    out = ghs._fetch_step_rollup("tok", date(2026, 6, 2), date(2026, 6, 3))
    assert out == {"2026-06-02": 9240, "2026-06-03": 12010}


def test_fetch_daily_points(monkeypatch):
    payload = {"dataPoints": [
        {"dailyRestingHeartRate": {"date": {"year": 2026, "month": 6, "day": 2},
                                   "beatsPerMinute": "52"}},
    ]}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp(payload))
    out = ghs._fetch_daily_points("tok", "daily-resting-heart-rate", date(2026, 6, 2), date(2026, 6, 2))
    assert out == {"2026-06-02": 52.0}


def test_fetch_intraday_hr(monkeypatch):
    payload = {"dataPoints": [
        {"heartRate": {"beatsPerMinute": "60", "sampleTime": {"civilTime": {
            "date": {"year": 2026, "month": 6, "day": 2},
            "time": {"hours": 0, "minutes": 0}}}}},
        {"heartRate": {"beatsPerMinute": "62", "sampleTime": {"civilTime": {
            "date": {"year": 2026, "month": 6, "day": 2},
            "time": {"hours": 0, "minutes": 1}}}}},
    ]}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp(payload))
    out = ghs._fetch_intraday_hr("tok", date(2026, 6, 2))
    assert out["points"] == [{"t": "00:00", "bpm": 60}, {"t": "00:01", "bpm": 62}]
    assert out["min_bpm"] == 60 and out["max_bpm"] == 62 and out["avg_bpm"] == 61


def test_fetch_sleep(monkeypatch):
    payload = {"dataPoints": [{"sleep": {
        "interval": {
            "startTime": "2026-06-02T07:00:00Z", "startUtcOffset": "-25200s",
            "endTime": "2026-06-02T13:22:00Z", "endUtcOffset": "-25200s",
        },
        "stages": [
            {"startTime": "2026-06-02T07:00:00Z", "endTime": "2026-06-02T08:32:00Z", "type": "DEEP"},
            {"startTime": "2026-06-02T08:32:00Z", "endTime": "2026-06-02T11:42:00Z", "type": "LIGHT"},
            {"startTime": "2026-06-02T11:42:00Z", "endTime": "2026-06-02T13:22:00Z", "type": "REM"},
        ],
    }}]}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp(payload))
    out = ghs._fetch_sleep("tok", date(2026, 6, 2), date(2026, 6, 2))
    s = out["2026-06-02"]
    # DEEP=92min, LIGHT=190min, REM=100min, AWAKE=0. wake local=13:22Z-7h=06:22 → day 2026-06-02
    assert s["deep_min"] == 92 and s["rem_min"] == 100
    assert s["bedtime"] == "00:00" and s["waketime"] == "06:22"
    assert round(s["hours"], 1) == 6.4


def test_upsert_daily_health_idempotent(db):
    ghs._upsert_daily_health(db, "2026-06-02", steps=9240, resting_hr=52)
    ghs._upsert_daily_health(db, "2026-06-02", hrv_ms=61.0)
    rows = db.query(DailyHealth).filter_by(date="2026-06-02").all()
    assert len(rows) == 1
    assert rows[0].steps == 9240 and rows[0].hrv_ms == 61.0


def test_upsert_intraday(db):
    ghs._upsert_intraday_hr(db, "2026-06-02", {
        "points": [{"t": "00:00", "bpm": 60}, {"t": "00:01", "bpm": 62}],
        "min_bpm": 60, "max_bpm": 62, "avg_bpm": 61,
    })
    row = db.query(IntradayHeartRate).filter_by(date="2026-06-02").one()
    assert json.loads(row.samples)["points"][0]["bpm"] == 60
    assert row.max_bpm == 62


def test_gapfill_sleep_fills_blank(db):
    db.add(DailySummary(date="2026-06-02")); db.commit()
    ghs._gapfill_sleep(db, "2026-06-02", hours=7.1, bedtime="23:10", waketime="06:18")
    row = db.query(DailySummary).filter_by(date="2026-06-02").one()
    assert row.sleep_hours == 7.1 and row.sleep_source == "google"


def test_gapfill_sleep_never_overwrites_manual(db):
    db.add(DailySummary(date="2026-06-02", sleep_hours=8.0, sleep_source="manual")); db.commit()
    ghs._gapfill_sleep(db, "2026-06-02", hours=7.1, bedtime="23:10", waketime="06:18")
    row = db.query(DailySummary).filter_by(date="2026-06-02").one()
    assert row.sleep_hours == 8.0 and row.sleep_source == "manual"


def test_gapfill_sleep_never_overwrites_legacy(db):
    """Legacy manual entries (sleep_hours set, sleep_source=None) must not be overwritten."""
    db.add(DailySummary(date="2026-06-02", sleep_hours=8.0, sleep_source=None)); db.commit()
    ghs._gapfill_sleep(db, "2026-06-02", hours=7.1, bedtime="23:10", waketime="06:18")
    row = db.query(DailySummary).filter_by(date="2026-06-02").one()
    assert row.sleep_hours == 8.0 and row.sleep_source is None


def test_gapfill_sleep_updates_prior_google_fill(db):
    db.add(DailySummary(date="2026-06-02", sleep_hours=7.0, sleep_source="google")); db.commit()
    ghs._gapfill_sleep(db, "2026-06-02", hours=7.3, bedtime="23:00", waketime="06:20")
    row = db.query(DailySummary).filter_by(date="2026-06-02").one()
    assert row.sleep_hours == 7.3


def test_gapfill_sleep_creates_row_if_missing(db):
    ghs._gapfill_sleep(db, "2026-06-05", hours=6.4, bedtime="00:10", waketime="06:40")
    row = db.query(DailySummary).filter_by(date="2026-06-05").one()
    assert row.sleep_hours == 6.4 and row.sleep_source == "google"


from backend.models import OAuthCredential


def _connect(db):
    db.add(OAuthCredential(provider=ghs.PROVIDER, refresh_token_enc="x",
                           status="connected")); db.commit()


def test_run_sync_ingests_all(db, monkeypatch):
    _connect(db)
    # Pin start date to today so the sync range is exactly 1 day (date-stable).
    import datetime as _datetime_mod
    _today = _datetime_mod.datetime.utcnow().date()
    _today_str = _today.strftime("%Y-%m-%d")
    monkeypatch.setenv("GOOGLE_HEALTH_START_DATE", _today.isoformat())
    monkeypatch.setattr(ghs, "get_valid_access_token", lambda d: "tok")
    monkeypatch.setattr(ghs, "_fetch_step_rollup", lambda t, s, e: {_today_str: 9240})
    monkeypatch.setattr(ghs, "_fetch_daily_points",
                        lambda t, dt, s, e: {_today_str: {"daily-resting-heart-rate": 52.0,
                            "daily-heart-rate-variability": 61.0,
                            "daily-respiratory-rate": 14.2}[dt]})
    monkeypatch.setattr(ghs, "_fetch_intraday_hr",
                        lambda t, d: {"points": [{"t": "00:00", "bpm": 60}],
                                      "min_bpm": 60, "max_bpm": 60, "avg_bpm": 60})
    monkeypatch.setattr(ghs, "_fetch_sleep",
                        lambda t, s, e: {_today_str: {"hours": 7.1, "bedtime": "23:10",
                            "waketime": "06:18", "deep_min": 92, "light_min": 190,
                            "rem_min": 100, "awake_min": 24, "efficiency": 93.0}})
    result = ghs.run_sync(db)
    assert result["status"] == "connected"
    dh = db.query(ghs.DailyHealth).filter_by(date=_today_str).one()
    assert dh.steps == 9240 and dh.resting_hr == 52 and dh.hrv_ms == 61.0
    assert dh.sleep_deep_min == 92
    assert db.query(ghs.IntradayHeartRate).count() == 1
    assert db.query(ghs.DailySummary).filter_by(date=_today_str).one().sleep_hours == 7.1


def test_run_sync_isolates_metric_failure(db, monkeypatch):
    _connect(db)
    monkeypatch.setattr(ghs, "get_valid_access_token", lambda d: "tok")
    monkeypatch.setattr(ghs, "_fetch_step_rollup", lambda t, s, e: {"2026-06-02": 9240})
    def boom(*a, **k): raise RuntimeError("hrv endpoint 500")
    monkeypatch.setattr(ghs, "_fetch_daily_points", boom)
    monkeypatch.setattr(ghs, "_fetch_intraday_hr", lambda t, d: None)
    monkeypatch.setattr(ghs, "_fetch_sleep", lambda t, s, e: {})
    result = ghs.run_sync(db)
    assert db.query(ghs.DailyHealth).filter_by(date="2026-06-02").one().steps == 9240
    assert result["status"] == "connected"


def test_run_sync_not_connected(db):
    assert ghs.run_sync(db)["status"] == "not_connected"
