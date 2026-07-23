"""Meal confidence computation — calorie-weighted average of item-level scores."""


def compute_meal_confidence(items) -> float:
    """Compute meal-level confidence as calorie-weighted average of item confidences.

    Args:
        items: list of objects with .calories and .confidence attributes
    Returns:
        float between 0.0 and 1.0
    """
    total_cal = sum(abs(i.calories) for i in items)
    if total_cal <= 0:
        return 0.5
    raw = sum(abs(i.calories) * (0.7 if i.confidence is None else i.confidence) for i in items) / total_cal
    return max(0.0, min(1.0, raw))


def confidence_color(score: float) -> str:
    """Map numeric confidence to display category."""
    if score > 0.7:
        return "high"
    elif score >= 0.4:
        return "medium"
    return "low"
