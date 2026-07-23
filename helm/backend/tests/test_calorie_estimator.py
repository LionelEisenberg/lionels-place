"""Tests for calorie_estimator.py — MET-based workout calorie estimation."""

import pytest
from backend.services.calorie_estimator import (
    _parse_set_count,
    _parse_volume,
    _dominant_category,
    estimate_workout_calories,
)
from backend.schemas import ExerciseEntryData


@pytest.mark.parametrize("input_str, expected", [
    ("8, 8, 9", 3),
    ("10", 1),
    ("12, 12, 10, 10", 4),
    ("", 0),
    (None, 0),
    ("  ,  ,  ", 0),
    ("8, , 9", 2),
])
def test_parse_set_count(input_str, expected):
    assert _parse_set_count(input_str) == expected


@pytest.mark.parametrize("weight_str, reps_str, expected", [
    ("30, 35, 35", "8, 8, 9", 835.0),
    ("50", "10", 500.0),
    ("30, 35", "8, 8, 9", 520.0),
    (None, "8, 8", 0.0),
    ("30, 35", None, 0.0),
    (None, None, 0.0),
    ("", "8, 8", 0.0),
    ("30, 35", "", 0.0),
    ("30, abc, 35", "8, 8, 9", 555.0),
])
def test_parse_volume(weight_str, reps_str, expected):
    assert _parse_volume(weight_str, reps_str) == expected


def _make_exercise(category: str = "Upper Body", **kwargs) -> ExerciseEntryData:
    """Helper to create an ExerciseEntryData with minimal required fields."""
    defaults = {
        "exercise": "Test Exercise",
        "category": category,
        "equipment_type": "Dumbbell",
        "targeted_muscle_group": "Chest",
    }
    defaults.update(kwargs)
    return ExerciseEntryData(**defaults)


@pytest.mark.parametrize("categories, expected", [
    (["Upper Body", "Upper Body", "Core"], "upper body"),
    (["Cardio"], "cardio"),
    (["Lower Body", "Lower Body", "Upper Body"], "lower body"),
    ([], "push"),
])
def test_dominant_category(categories, expected):
    exercises = [_make_exercise(category=c) for c in categories]
    assert _dominant_category(exercises) == expected


class TestEstimateWorkoutCalories:
    """Tests for the main MET × LBM calorie estimation function."""

    def test_empty_exercises_returns_zero(self):
        assert estimate_workout_calories([], 180.0, 15.0) == 0.0

    def test_fallback_path_when_no_body_metrics(self):
        exercises = [_make_exercise(category="Upper Body")]
        result = estimate_workout_calories(exercises, None, None)
        assert result == 280

    def test_fallback_with_swim_bonus(self):
        exercises = [_make_exercise(category="Cardio", exercise="Swimming laps")]
        result = estimate_workout_calories(exercises, None, None)
        assert result == 550

    def test_met_formula_produces_reasonable_estimate(self):
        exercises = [
            _make_exercise(
                category="Upper Body",
                weight_lbs="30, 35, 35",
                reps_sets="8, 8, 9",
            ),
            _make_exercise(
                category="Upper Body",
                weight_lbs="20, 25, 25",
                reps_sets="10, 10, 10",
            ),
        ]
        result = estimate_workout_calories(exercises, 180.0, 15.0)
        assert result == 99  # MET × LBM: 180 lbs, 15% BF, 6 sets upper body

    def test_swim_bonus_in_met_path(self):
        base_exercises = [_make_exercise(category="Upper Body", reps_sets="8, 8, 8")]
        swim_exercises = [
            _make_exercise(category="Upper Body", reps_sets="8, 8, 8"),
            _make_exercise(category="Cardio", exercise="Swim", reps_sets="1"),
        ]
        base_result = estimate_workout_calories(base_exercises, 180.0, 15.0)
        swim_result = estimate_workout_calories(swim_exercises, 180.0, 15.0)
        assert swim_result > base_result
