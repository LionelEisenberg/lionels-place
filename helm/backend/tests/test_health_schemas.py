from backend.schemas import (
    DailyHealthResponse, IntradayHeartRateResponse, IntradayPoint, BackfillResult,
)


def test_daily_health_response_from_attrs():
    class Row:
        date = "2026-06-02"; steps = 9240; resting_hr = 52; hrv_ms = 61.0
        respiratory_rate = 14.2; sleep_deep_min = 92; sleep_light_min = 190
        sleep_rem_min = 100; sleep_awake_min = 24; sleep_efficiency_pct = 93.0
    r = DailyHealthResponse.model_validate(Row())
    assert r.steps == 9240 and r.hrv_ms == 61.0


def test_intraday_response():
    r = IntradayHeartRateResponse(date="2026-06-02", points=[{"t": "00:00", "bpm": 60}],
                                  min_bpm=48, avg_bpm=71, max_bpm=151)
    assert r.points[0].bpm == 60


def test_backfill_result():
    assert BackfillResult(status="started", start_date="2026-06-02").status == "started"
