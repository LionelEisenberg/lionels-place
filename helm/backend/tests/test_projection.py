"""Tests for projection service — lifted from routers/goals.py."""

from datetime import date, datetime, timedelta

from backend.models import DailySummary
from backend.services.projection import project_weight_to_target


def _seed_linear_weight(db, start_date: date, count: int, start_lbs: float, slope_per_day: float):
    for i in range(count):
        d = (start_date + timedelta(days=i)).strftime("%Y-%m-%d")
        db.add(DailySummary(date=d, weight_lbs=start_lbs + slope_per_day * i))
    db.commit()


def test_projection_returns_none_with_too_few_points(db):
    # Seed 3 points ending today so they fall inside the 60-day window but are
    # too few (< 7) to project a date.
    seed_start = datetime.utcnow().date() - timedelta(days=2)
    _seed_linear_weight(db, seed_start, count=3, start_lbs=180, slope_per_day=-0.1)

    result = project_weight_to_target(target_lbs=170, db=db)

    assert result.current_value is not None
    assert result.starting_value is None             # not requested
    assert result.projected_date is None
    assert result.pace_per_week is None


def test_projection_estimates_date_with_seven_or_more_points(db):
    # 30 days of -0.2 lb/day ending today → current ~174.2 lbs, target 170 ~21 days out
    today = datetime.utcnow().date()
    seed_start = today - timedelta(days=29)
    _seed_linear_weight(db, seed_start, count=30, start_lbs=180, slope_per_day=-0.2)

    result = project_weight_to_target(target_lbs=170, db=db)

    assert result.current_value is not None
    assert result.starting_value is None             # not requested
    assert result.pace_per_week is not None
    assert -1.5 < result.pace_per_week < -1.3       # ~-1.4 lb/week
    assert result.projected_date is not None


def test_projection_resolves_starting_weight_for_phase(db):
    # Phase starts at the back of a 30-day window — exact date match
    today = datetime.utcnow().date()
    seed_start = today - timedelta(days=29)
    _seed_linear_weight(db, seed_start, count=30, start_lbs=200, slope_per_day=-0.1)

    phase_start = seed_start.isoformat()
    result = project_weight_to_target(
        target_lbs=180, db=db, phase_start_date=phase_start,
    )

    assert result.starting_value == 200.0
    assert result.current_value is not None
    # current should be ~200 + (-0.1 * 29) = 197.1
    assert abs(result.current_value - 197.1) < 0.01


def test_projection_starting_value_uses_earliest_weight_on_or_after_phase_start(db):
    # Seed weight starting AFTER the phase start_date — should pick first available
    seed_start = date(2026, 4, 5)
    _seed_linear_weight(db, seed_start, count=10, start_lbs=210, slope_per_day=0.0)

    # Phase starts 4 days before any logged weight
    result = project_weight_to_target(
        target_lbs=200, db=db, phase_start_date="2026-04-01",
    )

    assert result.starting_value == 210.0           # earliest weight on/after 04-01


def test_projection_starting_value_none_when_no_weight_after_phase_start(db):
    # Seed weights, but phase starts after all of them
    _seed_linear_weight(db, date(2026, 1, 1), count=10, start_lbs=210, slope_per_day=0.0)

    result = project_weight_to_target(
        target_lbs=200, db=db, phase_start_date="2030-01-01",
    )

    assert result.starting_value is None


def test_projection_all_history_window_regresses_data_older_than_any_bounded_window(db):
    """window_days=None regresses over ALL weigh-ins, even ones older than any
    trailing window — so its slope reflects the full history, unlike a bounded
    window that only sees the recent cluster."""
    today = datetime.utcnow().date()
    # Old low cluster ~500 days ago (far outside any trailing window) and a
    # recent flat cluster in the last 10 days.
    for i in range(10):
        db.add(DailySummary(date=(today - timedelta(days=500 - i)).isoformat(), weight_lbs=150.0))
    for i in range(10):
        db.add(DailySummary(date=(today - timedelta(days=9 - i)).isoformat(), weight_lbs=200.0))
    db.commit()

    all_hist = project_weight_to_target(target_lbs=140, db=db, window_days=None)
    bounded = project_weight_to_target(target_lbs=140, db=db, window_days=60)

    # Both see the recent cluster as "current".
    assert all_hist.current_value == 200.0
    assert bounded.current_value == 200.0
    # All-history connects the old low cluster to the recent high one → clearly gaining.
    assert all_hist.pace_per_week is not None and all_hist.pace_per_week > 0.3
    # A 60-day window sees only the recent flat cluster → ~0 pace.
    assert bounded.pace_per_week is not None and abs(bounded.pace_per_week) < 0.1


def test_weight_projection_endpoint_window_days_0_means_all_history(db):
    """The /weight-projection endpoint maps window_days=0 → all-history (not a
    zero-day window). The frontend's "Overall" forecast mode relies on this."""
    import asyncio

    from backend.models import Phase
    from backend.routers.phases import get_weight_projection

    today = datetime.utcnow().date()
    for i in range(10):
        db.add(DailySummary(date=(today - timedelta(days=500 - i)).isoformat(), weight_lbs=150.0))
    for i in range(10):
        db.add(DailySummary(date=(today - timedelta(days=9 - i)).isoformat(), weight_lbs=200.0))
    phase = Phase(
        phase_type="cut",
        start_date=(today - timedelta(days=500)).isoformat(),
        target_calories=2000, target_protein_g=180, target_carbs_g=150,
        target_fat_g=60, target_fiber_g=30, target_weight_lbs=140,
    )
    db.add(phase)
    db.commit()

    resp = asyncio.run(get_weight_projection(phase_id=phase.id, window_days=0, db=db))

    # window_days=0 → all-history regression spanning both clusters → gaining.
    # (If 0 were treated as a 0-day window, only today's weigh-in would qualify
    #  and pace_per_week would be None.)
    assert resp.pace_per_week is not None and resp.pace_per_week > 0.3
