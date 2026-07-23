"""Tests for the canonical workout_type inference function."""

from backend.models import Workout
from backend.services.workout_type import infer_workout_type, WORKOUT_TYPES


def w(category: str, muscles: str) -> Workout:
    """Build a stub Workout for tests — only category and targeted_muscle_group matter."""
    return Workout(
        date="2026-05-20",
        category=category,
        equipment_type="Dumbbell",
        exercise="x",
        weight_lbs="0",
        reps_sets="0",
        targeted_muscle_group=muscles,
    )


def test_workout_types_constant_is_canonical():
    assert WORKOUT_TYPES == ("Push", "Pull", "Legs", "Cardio", "Mixed")


def test_empty_list_returns_none():
    assert infer_workout_type([]) is None


def test_all_cardio_returns_cardio():
    workouts = [
        w("Cardio", "Cardio"),
        w("Cardio", "Cardio"),
    ]
    assert infer_workout_type(workouts) == "Cardio"


def test_pure_push_returns_push():
    workouts = [
        w("Upper Body", "Chest"),
        w("Upper Body", "Triceps"),
        w("Upper Body", "Delts"),
    ]
    assert infer_workout_type(workouts) == "Push"


def test_pure_pull_returns_pull():
    workouts = [
        w("Upper Body", "Lats"),
        w("Upper Body", "Biceps"),
        w("Upper Body", "Traps"),
    ]
    assert infer_workout_type(workouts) == "Pull"


def test_pure_legs_returns_legs():
    workouts = [
        w("Lower Body", "Quads"),
        w("Lower Body", "Hamstrings"),
        w("Lower Body", "Glutes"),
    ]
    assert infer_workout_type(workouts) == "Legs"


def test_fifty_fifty_push_pull_returns_mixed():
    workouts = [
        w("Upper Body", "Chest"),
        w("Upper Body", "Lats"),
    ]
    assert infer_workout_type(workouts) == "Mixed"


def test_dominant_push_with_token_pull_returns_push():
    workouts = [
        w("Upper Body", "Chest"),
        w("Upper Body", "Triceps"),
        w("Upper Body", "Delts"),
        w("Upper Body", "Biceps"),
    ]
    assert infer_workout_type(workouts) == "Push"


def test_strength_plus_cardio_uses_strength_branch():
    workouts = [
        w("Upper Body", "Chest"),
        w("Upper Body", "Triceps"),
        w("Cardio", "Cardio"),
    ]
    assert infer_workout_type(workouts) == "Push"


def test_multi_muscle_string_counts_each():
    workouts = [
        w("Upper Body", "Chest, Triceps"),
        w("Upper Body", "Delts"),
    ]
    assert infer_workout_type(workouts) == "Push"


def test_core_only_returns_mixed():
    workouts = [
        w("Core", "Core"),
        w("Core", "Core"),
    ]
    assert infer_workout_type(workouts) == "Mixed"


def test_full_body_only_returns_mixed():
    workouts = [
        w("Upper Body", "Full Body"),
    ]
    assert infer_workout_type(workouts) == "Mixed"


def test_muscle_match_is_case_insensitive():
    workouts = [
        w("Upper Body", "chest"),
        w("Upper Body", "TRICEPS"),
    ]
    assert infer_workout_type(workouts) == "Push"
