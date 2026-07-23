"""Tests for the meals CRUD router."""

import asyncio
from datetime import datetime

from backend.models import Meal, MealItem
from backend.routers.meals import update_meal_items
from backend.schemas import MealItemData


def _today_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def test_update_meal_items_accepts_null_confidence(db):
    """Regression: items round-tripped from MealItemResponse (confidence=None)
    must be accepted by PUT /meals/{id}/items without 422."""
    meal = Meal(
        date=_today_iso(), meal="Lunch", description="seed",
        calories=0, protein_g=0, carbs_g=0, fat_g=0, fiber_g=0,
    )
    db.add(meal)
    db.flush()
    db.add(MealItem(
        meal_id=meal.id, name="Old item", quantity="1",
        calories=100, protein_g=10, carbs_g=10, fat_g=5, fiber_g=0,
        confidence=None, confidence_reason=None,
    ))
    db.commit()

    items = [
        MealItemData(
            name="Burrito Bowl", quantity="1",
            calories=700, protein_g=50, carbs_g=80, fat_g=20, fiber_g=10,
            confidence=None, confidence_reason=None,
        ),
    ]

    result = asyncio.run(update_meal_items(meal_id=meal.id, items=items, db=db))

    assert result.calories == 700
    assert len(result.items) == 1
    assert result.items[0].name == "Burrito Bowl"
    assert result.confidence is not None  # weighted-avg fallback (0.7)
