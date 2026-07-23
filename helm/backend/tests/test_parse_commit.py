"""Tests for parse router commit flow — per-intent date recalc."""

import asyncio

from backend.routers.parse import commit_intents
from backend.models import DailySummary
from backend.schemas import (
    CommitRequest,
    ParsedIntent,
    MealIntentData,
)


def test_commit_recalcs_daily_for_intent_date_when_different_from_request_date(db):
    """
    When an intent is dated to a different day than req.date (e.g. adding a meal
    to 'yesterday' from today's Dashboard), the affected day's DailySummary must
    be recalculated — not just req.date's.
    """
    yesterday = "2026-04-18"
    today = "2026-04-19"

    intent = ParsedIntent(
        type="meal",
        date=yesterday,
        meal_data=MealIntentData(
            meal="Dinner",
            description="Burger",
            calories=800,
            protein_g=40,
            carbs_g=50,
            fat_g=40,
            fiber_g=3,
            items=[],
        ),
    )
    req = CommitRequest(date=today, intents=[intent])

    asyncio.run(commit_intents(req, db))

    yesterday_summary = db.query(DailySummary).filter(DailySummary.date == yesterday).first()
    assert yesterday_summary is not None, "Yesterday's DailySummary should exist after commit"
    assert yesterday_summary.calories_in == 800, (
        f"Yesterday's calories_in should reflect the committed meal (800), "
        f"got {yesterday_summary.calories_in}"
    )


def test_commit_workout_attaches_to_declared_activity_and_sets_no_burn(db):
    from backend.schemas import CommitRequest, ParsedIntent, WorkoutIntentData, ExerciseEntryData
    from backend.models import Workout, Activity, DailySummary
    import asyncio

    strength = ParsedIntent(type="workout", workout_data=WorkoutIntentData(
        activity="strength", label="Strength",
        exercises=[ExerciseEntryData(exercise="Bench Press", category="Upper Body",
                                     equipment_type="Barbell", weight_lbs="135",
                                     reps_sets="8, 8, 7", targeted_muscle_group="Chest")]))
    swim = ParsedIntent(type="workout", workout_data=WorkoutIntentData(
        activity="swim", label="Pool swim",
        exercises=[ExerciseEntryData(exercise="Swim", category="Cardio",
                                     equipment_type="None", weight_lbs="",
                                     reps_sets="30 laps", targeted_muscle_group="Cardio")]))
    req = CommitRequest(date="2026-07-14", intents=[strength, swim])
    asyncio.run(commit_intents(req, db))

    acts = db.query(Activity).order_by(Activity.activity).all()
    assert {a.activity for a in acts} == {"strength", "swim"}
    bench = db.query(Workout).filter(Workout.exercise == "Bench Press").first()
    assert bench.activity_id == next(a.id for a in acts if a.activity == "strength")
    daily = db.query(DailySummary).filter(DailySummary.date == "2026-07-14").first()
    assert (daily.est_active_burn or 0) == 0


def test_commit_workout_invalid_activity_falls_back_to_heuristic(db):
    from backend.schemas import CommitRequest, ParsedIntent, WorkoutIntentData, ExerciseEntryData
    from backend.models import Workout, Activity
    import asyncio

    intent = ParsedIntent(type="workout", workout_data=WorkoutIntentData(
        activity="yoga",   # not canonical -> per-row heuristic
        exercises=[ExerciseEntryData(exercise="Bench Press", category="Upper Body",
                                     equipment_type="Barbell", weight_lbs="135",
                                     reps_sets="8", targeted_muscle_group="Chest")]))
    req = CommitRequest(date="2026-07-14", intents=[intent])
    asyncio.run(commit_intents(req, db))

    w = db.query(Workout).filter(Workout.exercise == "Bench Press").first()
    act = db.query(Activity).filter(Activity.id == w.activity_id).first()
    assert act is not None and act.activity == "strength"   # heuristic bucketed the lift


def test_commit_mislabeled_strength_entry_in_cardio_intent_keeps_row(db):
    """An LLM-mislabelled split (strength-style entry inside a cardio intent)
    must never be absorbed — that would silently destroy the weights."""
    from backend.schemas import CommitRequest, ParsedIntent, WorkoutIntentData, ExerciseEntryData
    from backend.models import Workout, Activity
    import asyncio

    intent = ParsedIntent(type="workout", workout_data=WorkoutIntentData(
        activity="swim", label="Pool swim",
        exercises=[
            ExerciseEntryData(exercise="Swim", category="Cardio", equipment_type="None",
                              weight_lbs="", reps_sets="30 laps", targeted_muscle_group="Cardio"),
            ExerciseEntryData(exercise="Bench Press", category="Upper Body",
                              equipment_type="Barbell", weight_lbs="135",
                              reps_sets="8, 8", targeted_muscle_group="Chest"),
        ]))
    req = CommitRequest(date="2026-07-14", intents=[intent])
    asyncio.run(commit_intents(req, db))

    swim = db.query(Activity).filter(Activity.activity == "swim").one()
    assert swim.laps == 30                                   # cardio entry absorbed
    bench = db.query(Workout).filter(Workout.exercise == "Bench Press").one()
    strength = db.query(Activity).filter(Activity.activity == "strength").one()
    assert bench.activity_id == strength.id                  # weights kept as a row
    assert db.query(Workout).count() == 1                    # no row on the swim
