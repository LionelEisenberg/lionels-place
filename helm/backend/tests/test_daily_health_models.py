"""Schema/round-trip tests for the Google Health storage tables."""
from backend.models import DailyHealth, IntradayHeartRate, DailySummary


def test_daily_health_round_trip(db):
    row = DailyHealth(
        date="2026-06-02", steps=9240, resting_hr=52, hrv_ms=61.0,
        respiratory_rate=14.2, sleep_deep_min=92, sleep_light_min=190,
        sleep_rem_min=100, sleep_awake_min=24, sleep_efficiency_pct=93.0,
    )
    db.add(row); db.commit()
    got = db.query(DailyHealth).filter_by(date="2026-06-02").one()
    assert got.steps == 9240
    assert got.resting_hr == 52
    assert got.hrv_ms == 61.0


def test_intraday_round_trip(db):
    row = IntradayHeartRate(
        date="2026-06-02", samples='{"base":"00:00","interval_s":60,"bpm":[60,61]}',
        min_bpm=48, avg_bpm=71, max_bpm=151,
    )
    db.add(row); db.commit()
    got = db.query(IntradayHeartRate).filter_by(date="2026-06-02").one()
    assert got.max_bpm == 151
    assert '"bpm"' in got.samples


def test_daily_summary_has_sleep_source(db):
    row = DailySummary(date="2026-06-02", sleep_source="google")
    db.add(row); db.commit()
    got = db.query(DailySummary).filter_by(date="2026-06-02").one()
    assert got.sleep_source == "google"
