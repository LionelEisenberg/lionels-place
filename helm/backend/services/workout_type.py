"""Canonical workout-type inference.

Single source of truth for mapping a day's logged exercises to a workout type.
Both the backend (DailySummary.workout_type) and the frontend (via the /daily
response) ultimately depend on this function.
"""

from __future__ import annotations

from ..models import Workout


WORKOUT_TYPES = ("Push", "Pull", "Legs", "Cardio", "Mixed")

PUSH_MUSCLES = {"chest", "triceps", "delts"}
PULL_MUSCLES = {"lats", "biceps", "traps", "rhomboids", "forearms / grip", "lower back"}
LEG_MUSCLES  = {"quads", "hamstrings", "glutes", "calves", "adductors", "abductors"}


def infer_workout_type(workouts: list[Workout]) -> str | None:
    """Return one of WORKOUT_TYPES, or None if the list is empty.

    Algorithm:
      1. Empty input → None.
      2. All workouts have category == "Cardio" → "Cardio".
      3. Otherwise count muscle-group memberships across all targeted_muscle_group
         values. If a single bucket holds strictly more than 50% of matched
         muscles → that bucket. (Strict > 0.5 means at most one bucket can win,
         so the order of checks is incidental.)
      4. Otherwise → "Mixed".
    """
    if not workouts:
        return None

    if all(w.category == "Cardio" for w in workouts):
        return "Cardio"

    push = pull = legs = 0
    for w in workouts:
        if not w.targeted_muscle_group:
            continue
        for raw in w.targeted_muscle_group.split(","):
            m = raw.strip().lower()
            if m in PUSH_MUSCLES:
                push += 1
            elif m in PULL_MUSCLES:
                pull += 1
            elif m in LEG_MUSCLES:
                legs += 1
            # Cardio / Core / Full Body / unknown muscles count toward no bucket

    total = push + pull + legs
    if total == 0:
        return "Mixed"
    if push / total > 0.5:
        return "Push"
    if pull / total > 0.5:
        return "Pull"
    if legs / total > 0.5:
        return "Legs"
    return "Mixed"
