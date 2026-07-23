"""Tests for the quick-add endpoints on the meals router."""

import asyncio
from datetime import datetime

from fastapi import HTTPException

from backend.models import Meal, MealItem, MealItemPin
from backend.routers.meals import (
    get_quick_add,
    create_pin,
    delete_pin,
    log_quick_add_meal,
)
from backend.schemas import QuickAddPinRequest, QuickAddLogRequest, MealItemData


def _today_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _seed_meal_with_item(db, name, quantity, **macros):
    defaults = dict(calories=100, protein_g=10, carbs_g=10, fat_g=5, fiber_g=2)
    defaults.update(macros)
    meal = Meal(
        date=_today_iso(), meal="Lunch", description=name, **defaults,
    )
    db.add(meal)
    db.flush()
    db.add(MealItem(meal_id=meal.id, name=name, quantity=quantity, **defaults))
    db.commit()


def test_get_quick_add_returns_popular_and_pinned(db):
    _seed_meal_with_item(db, "Chicken", "6oz", calories=280)
    _seed_meal_with_item(db, "Banana", "1", calories=105)

    result = asyncio.run(get_quick_add(db=db))

    assert result.window_days == 30
    assert len(result.popular) == 2
    assert result.pinned == []


def test_get_quick_add_dedupes_pinned_from_popular(db):
    _seed_meal_with_item(db, "Chicken", "6oz")
    _seed_meal_with_item(db, "Banana", "1")
    db.add(MealItemPin(name="chicken", quantity="6oz"))
    db.commit()

    result = asyncio.run(get_quick_add(db=db))

    assert len(result.pinned) == 1
    assert result.pinned[0].name.lower() == "chicken"
    popular_names = [p.name.lower() for p in result.popular]
    assert "chicken" not in popular_names
    assert "banana" in popular_names


def test_create_pin_creates_row(db):
    req = QuickAddPinRequest(name="Greek yogurt", quantity="1c")
    result = asyncio.run(create_pin(req, db=db))
    assert result.name.lower() == "greek yogurt"
    assert result.is_pinned is True


def test_create_pin_returns_409_when_duplicate(db):
    req = QuickAddPinRequest(name="Banana", quantity="1")
    asyncio.run(create_pin(req, db=db))
    try:
        asyncio.run(create_pin(req, db=db))
    except HTTPException as e:
        assert e.status_code == 409
        return
    raise AssertionError("Expected 409 HTTPException on duplicate pin")


def test_delete_pin_removes_row(db):
    pin = MealItemPin(name="oats", quantity="1c")
    db.add(pin)
    db.commit()
    db.refresh(pin)

    asyncio.run(delete_pin(pin.id, db=db))

    assert db.query(MealItemPin).count() == 0


def test_delete_pin_returns_404_when_missing(db):
    try:
        asyncio.run(delete_pin(99999, db=db))
    except HTTPException as e:
        assert e.status_code == 404
        return
    raise AssertionError("Expected 404 HTTPException on missing pin")


def test_log_quick_add_meal_creates_meal_with_items(db):
    explicit_date = "2026-01-15"
    req = QuickAddLogRequest(
        meal_type="Lunch",
        items=[
            MealItemData(
                name="Chicken", quantity="6oz",
                calories=280, protein_g=53, carbs_g=0, fat_g=6, fiber_g=0,
            ),
            MealItemData(
                name="Rice", quantity="1c",
                calories=205, protein_g=4, carbs_g=45, fat_g=0, fiber_g=1,
            ),
        ],
        date=explicit_date,
    )
    result = asyncio.run(log_quick_add_meal(req, db=db))

    assert result.meal == "Lunch"
    assert result.calories == 485
    assert result.protein_g == 57
    assert result.carbs_g == 45
    assert result.fat_g == 6
    assert result.fiber_g == 1
    assert result.date == explicit_date
    assert len(result.items) == 2
    assert "Chicken" in result.description and "Rice" in result.description


def test_log_quick_add_meal_rejects_empty_items(db):
    req = QuickAddLogRequest(meal_type="Snack", items=[], date=None)
    try:
        asyncio.run(log_quick_add_meal(req, db=db))
    except HTTPException as e:
        assert e.status_code == 400
        return
    raise AssertionError("Expected 400 HTTPException on empty items")


def test_log_quick_add_meal_defaults_date_to_today_pacific(db):
    """Verify the date=None code path uses Pacific timezone and zoneinfo."""
    import zoneinfo
    expected = datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")

    req = QuickAddLogRequest(
        meal_type="Snack",
        items=[
            MealItemData(
                name="Banana", quantity="1",
                calories=105, protein_g=1, carbs_g=27, fat_g=0, fiber_g=3,
            ),
        ],
        date=None,
    )
    result = asyncio.run(log_quick_add_meal(req, db=db))

    assert result.date == expected
    assert result.meal == "Snack"
    assert result.calories == 105
