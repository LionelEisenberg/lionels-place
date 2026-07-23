"""Tests for /api/workouts/progression.

Cardio entries (e.g. swimming) are returned in full so the chart can span the
entire logged date range; strength lifts stay capped at the recent `limit`.
"""

import asyncio

from backend.models import Workout, DailySummary
from backend.routers.workouts import exercise_progression, _is_cardio_row


def _add_sessions(db, *, exercise, equipment_type, weight_lbs, reps_sets,
                  category="Cardio", muscle="Full Body", count):
    """Insert `count` sessions for one exercise across distinct dates."""
    for i in range(count):
        db.add(Workout(
            date=f"2026-{(i // 28) + 1:02d}-{(i % 28) + 1:02d}",
            category=category,
            equipment_type=equipment_type,
            exercise=exercise,
            weight_lbs=weight_lbs,
            reps_sets=reps_sets,
            notes="",
            targeted_muscle_group=muscle,
        ))
    db.commit()


def test_swimming_progression_returns_all_dates(db):
    _add_sessions(db, exercise="Swimming", equipment_type="None",
                  weight_lbs="-", reps_sets="30 Laps", count=42)

    # Even with a tiny cap, cardio comes back in full.
    result = asyncio.run(exercise_progression("Swimming", limit=5, db=db))

    assert len(result) == 1
    assert len(result[0].sessions) == 42


def test_strength_progression_stays_capped_at_limit(db):
    _add_sessions(db, exercise="Bench Press", equipment_type="Barbell",
                  weight_lbs="135, 135", reps_sets="8, 8",
                  category="Upper Body", muscle="Chest", count=42)

    result = asyncio.run(exercise_progression("Bench Press", limit=30, db=db))

    assert len(result) == 1
    assert len(result[0].sessions) == 30


def test_is_cardio_row_detection():
    swim = Workout(date="2026-01-01", category="Cardio", equipment_type="None",
                   exercise="Swimming", weight_lbs="-", reps_sets="30 Laps",
                   notes="", targeted_muscle_group="Full Body")
    bodyweight_zero = Workout(date="2026-01-01", category="Cardio", equipment_type="Machine",
                              exercise="Rowing", weight_lbs="0", reps_sets="20 min",
                              notes="", targeted_muscle_group="Full Body")
    lift = Workout(date="2026-01-01", category="Upper Body", equipment_type="Barbell",
                   exercise="Bench Press", weight_lbs="135, 135", reps_sets="8, 8",
                   notes="", targeted_muscle_group="Chest")

    assert _is_cardio_row(swim) is True
    assert _is_cardio_row(bodyweight_zero) is True
    assert _is_cardio_row(lift) is False


def _add_assisted_workout(db, *, date, weight_lbs="-115"):
    """Insert one assisted-exercise session (negative weight = assistance)."""
    db.add(Workout(
        date=date,
        category="Upper Body",
        equipment_type="Machine",
        exercise="Assisted Pull-Up",
        weight_lbs=weight_lbs,
        reps_sets="8, 8",
        notes="",
        targeted_muscle_group="Back",
    ))
    db.commit()


def test_assisted_lift_uses_nearest_weigh_in_when_no_same_day_weight(db):
    """An assisted lift on a day with no weigh-in resolves bodyweight to the
    closest weigh-in, so the frontend can compute effective weight (200-115=85)
    instead of falling back to the raw assist level."""
    _add_assisted_workout(db, date="2026-02-10")
    db.add(DailySummary(date="2026-02-08", weight_lbs=200.0))  # 2 days earlier
    db.commit()

    result = asyncio.run(exercise_progression("Assisted Pull-Up", limit=30, db=db))

    assert result[0].sessions[0].body_weight == 200.0


def test_assisted_lift_picks_closest_of_two_weigh_ins(db):
    _add_assisted_workout(db, date="2026-02-10")
    db.add(DailySummary(date="2026-02-05", weight_lbs=190.0))  # 5 days before
    db.add(DailySummary(date="2026-02-12", weight_lbs=205.0))  # 2 days after (closest)
    db.commit()

    result = asyncio.run(exercise_progression("Assisted Pull-Up", limit=30, db=db))

    assert result[0].sessions[0].body_weight == 205.0


def test_assisted_lift_breaks_distance_ties_toward_earlier_weigh_in(db):
    _add_assisted_workout(db, date="2026-02-10")
    db.add(DailySummary(date="2026-02-08", weight_lbs=200.0))  # 2 days before
    db.add(DailySummary(date="2026-02-12", weight_lbs=210.0))  # 2 days after
    db.commit()

    result = asyncio.run(exercise_progression("Assisted Pull-Up", limit=30, db=db))

    # Equidistant → the earlier weigh-in wins (deterministic tie-break).
    assert result[0].sessions[0].body_weight == 200.0


def test_progression_uses_exact_day_weigh_in_when_present(db):
    """Regression guard: a same-day weigh-in is still used verbatim."""
    _add_assisted_workout(db, date="2026-02-10")
    db.add(DailySummary(date="2026-02-10", weight_lbs=198.0))  # same day
    db.add(DailySummary(date="2026-02-09", weight_lbs=300.0))  # decoy, one day off
    db.commit()

    result = asyncio.run(exercise_progression("Assisted Pull-Up", limit=30, db=db))

    assert result[0].sessions[0].body_weight == 198.0


def test_progression_leaves_bodyweight_none_when_no_weigh_ins(db):
    """No weigh-ins anywhere → nothing to resolve to; stays None (the frontend
    then falls back to the raw assist level, which is unavoidable here)."""
    _add_assisted_workout(db, date="2026-02-10")

    result = asyncio.run(exercise_progression("Assisted Pull-Up", limit=30, db=db))

    assert result[0].sessions[0].body_weight is None


def test_progression_ignores_zero_and_null_weigh_ins(db):
    """Bogus weigh-ins (0 / null) are skipped; the nearest *real* weight wins."""
    _add_assisted_workout(db, date="2026-02-10")
    db.add(DailySummary(date="2026-02-10", weight_lbs=0.0))     # same day but bogus
    db.add(DailySummary(date="2026-02-09", weight_lbs=None))    # null
    db.add(DailySummary(date="2026-02-06", weight_lbs=201.0))   # nearest real weigh-in
    db.commit()

    result = asyncio.run(exercise_progression("Assisted Pull-Up", limit=30, db=db))

    assert result[0].sessions[0].body_weight == 201.0
