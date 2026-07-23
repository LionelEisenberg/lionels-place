"""Tests for daily_calculator.py — macro aggregation and body metrics."""

import pytest

from backend.services.daily_calculator import (
    compute_daily_totals,
    get_latest_body_metrics,
)
from backend.models import Meal, DailySummary


class TestComputeDailyTotals:
    def test_no_meals_returns_zeros(self, db):
        result = compute_daily_totals("2026-03-17", db)
        assert result["calories_in"] == 0.0
        assert result["protein_g"] == 0.0
        assert result["meal_count"] == 0

    def test_single_meal(self, db):
        db.add(Meal(
            date="2026-03-17", meal="Lunch", description="Chicken",
            calories=500, protein_g=40, carbs_g=30, fat_g=15, fiber_g=5,
        ))
        db.commit()
        result = compute_daily_totals("2026-03-17", db)
        assert result["calories_in"] == 500.0
        assert result["protein_g"] == 40.0
        assert result["carbs_g"] == 30.0
        assert result["fat_g"] == 15.0
        assert result["fiber_g"] == 5.0
        assert result["meal_count"] == 1

    def test_multiple_meals_sum_correctly(self, db):
        db.add(Meal(
            date="2026-03-17", meal="Breakfast", description="Eggs",
            calories=300, protein_g=25, carbs_g=5, fat_g=20, fiber_g=0,
        ))
        db.add(Meal(
            date="2026-03-17", meal="Lunch", description="Chicken",
            calories=500, protein_g=40, carbs_g=30, fat_g=15, fiber_g=5,
        ))
        db.commit()
        result = compute_daily_totals("2026-03-17", db)
        assert result["calories_in"] == 800.0
        assert result["protein_g"] == 65.0
        assert result["meal_count"] == 2

    def test_different_dates_dont_bleed(self, db):
        db.add(Meal(
            date="2026-03-17", meal="Lunch", description="Chicken",
            calories=500, protein_g=40, carbs_g=30, fat_g=15, fiber_g=5,
        ))
        db.add(Meal(
            date="2026-03-16", meal="Dinner", description="Steak",
            calories=700, protein_g=50, carbs_g=10, fat_g=35, fiber_g=0,
        ))
        db.commit()
        result = compute_daily_totals("2026-03-17", db)
        assert result["calories_in"] == 500.0
        assert result["meal_count"] == 1


class TestGetLatestBodyMetrics:
    def test_no_data_returns_none_tuple(self, db):
        assert get_latest_body_metrics(db) == (None, None)

    def test_returns_most_recent_row(self, db):
        db.add(DailySummary(date="2026-03-15", weight_lbs=182.0, bf_pct=15.0))
        db.add(DailySummary(date="2026-03-17", weight_lbs=180.0, bf_pct=14.5))
        db.commit()
        assert get_latest_body_metrics(db) == (180.0, 14.5)

    def test_skips_rows_missing_bf_pct(self, db):
        db.add(DailySummary(date="2026-03-17", weight_lbs=180.0, bf_pct=None))
        db.add(DailySummary(date="2026-03-15", weight_lbs=182.0, bf_pct=15.0))
        db.commit()
        assert get_latest_body_metrics(db) == (182.0, 15.0)

    def test_skips_rows_missing_weight(self, db):
        db.add(DailySummary(date="2026-03-17", weight_lbs=None, bf_pct=14.5))
        db.commit()
        assert get_latest_body_metrics(db) == (None, None)


def test_recompute_active_burn_counts_in_log_matched(db):
    """est_active_burn = sum of credited Google burn over IN-LOG (logged OR locked-in)
    matched workouts; a still-pending Google-only workout contributes nothing."""
    from backend.models import Activity, Workout, WorkoutSession, DailySummary
    from backend.services.daily_calculator import recompute_active_burn
    from backend.services.burn import credited_burn
    D = "2026-07-14"

    def _act(gid, kcal, activity="strength", start="12:00"):
        s = WorkoutSession(google_id=gid, date=D, exercise_type="x", exercise_type_raw="WORKOUT",
                           category="strength", start_time=f"{D}T{start}:00", end_time=f"{D}T13:30:00",
                           duration_min=60.0, calories_kcal=kcal, source="google")
        db.add(s); db.flush()
        a = Activity(date=D, activity=activity, google_session_id=s.id)
        db.add(a); db.flush()
        return a

    a_logged = _act("g1", 300.0)                                  # (a) manually logged (has a row)
    db.add(Workout(date=D, category="Upper Body", equipment_type="", exercise="Bench",
                   weight_lbs="", reps_sets="8", notes="", targeted_muscle_group="", activity_id=a_logged.id))
    a_final = _act("g2", 500.0, activity="run", start="17:00")    # (b) locked in
    a_final.finalized = True
    _act("g3", 999.0, activity="swim", start="13:00")            # (c) still pending -> excluded
    db.commit()

    total = recompute_active_burn(D, db)
    assert total == credited_burn(300.0) + credited_burn(500.0)   # (a)+(b); (c) excluded
    assert db.query(DailySummary).filter(DailySummary.date == D).first().est_active_burn == total
