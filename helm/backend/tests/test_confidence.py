"""Tests for meal confidence computation."""


class FakeItem:
    def __init__(self, calories, confidence):
        self.calories = calories
        self.confidence = confidence


def test_weighted_average_basic():
    from backend.services.confidence import compute_meal_confidence
    items = [FakeItem(300, 0.9), FakeItem(200, 0.5)]
    assert abs(compute_meal_confidence(items) - 0.74) < 0.01


def test_single_item():
    from backend.services.confidence import compute_meal_confidence
    items = [FakeItem(500, 0.85)]
    assert abs(compute_meal_confidence(items) - 0.85) < 0.01


def test_empty_items():
    from backend.services.confidence import compute_meal_confidence
    assert compute_meal_confidence([]) == 0.5


def test_zero_calorie_items():
    from backend.services.confidence import compute_meal_confidence
    items = [FakeItem(0, 0.9), FakeItem(0, 0.3)]
    assert compute_meal_confidence(items) == 0.5


def test_negative_calories_uses_abs():
    from backend.services.confidence import compute_meal_confidence
    items = [FakeItem(-100, 0.8), FakeItem(200, 0.6)]
    assert abs(compute_meal_confidence(items) - 0.667) < 0.01


def test_result_clamped():
    from backend.services.confidence import compute_meal_confidence
    items = [FakeItem(100, 1.5)]
    result = compute_meal_confidence(items)
    assert result <= 1.0


def test_confidence_color_high():
    from backend.services.confidence import confidence_color
    assert confidence_color(0.8) == "high"
    assert confidence_color(0.71) == "high"


def test_confidence_color_medium():
    from backend.services.confidence import confidence_color
    assert confidence_color(0.5) == "medium"
    assert confidence_color(0.4) == "medium"


def test_confidence_color_low():
    from backend.services.confidence import confidence_color
    assert confidence_color(0.3) == "low"
    assert confidence_color(0.0) == "low"
