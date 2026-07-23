"""Tests for quick_add_service — popularity, pinning, log."""

from datetime import datetime, timedelta

from backend.models import Meal, MealItem, MealItemPin
from backend.services.quick_add_service import (
    get_popular_items,
    get_pinned_items,
    add_pin,
    remove_pin,
)


def _today_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _days_ago(n: int) -> str:
    return (datetime.now() - timedelta(days=n)).strftime("%Y-%m-%d")


def _add_meal_with_item(db, date, name, quantity, calories=100, protein_g=10, carbs_g=10, fat_g=5, fiber_g=2):
    meal = Meal(
        date=date, meal="Lunch", description=name,
        calories=calories, protein_g=protein_g, carbs_g=carbs_g, fat_g=fat_g, fiber_g=fiber_g,
    )
    db.add(meal)
    db.flush()
    db.add(MealItem(
        meal_id=meal.id, name=name, quantity=quantity,
        calories=calories, protein_g=protein_g, carbs_g=carbs_g, fat_g=fat_g, fiber_g=fiber_g,
    ))
    db.commit()
    return meal


def test_get_popular_items_groups_by_lower_name_and_quantity(db):
    _add_meal_with_item(db, _today_iso(), "Chicken breast", "6oz")
    _add_meal_with_item(db, _today_iso(), "chicken breast", "6oz")
    _add_meal_with_item(db, _today_iso(), "CHICKEN BREAST", "6oz")
    _add_meal_with_item(db, _today_iso(), "Banana", "1")

    popular = get_popular_items(db, window_days=30, limit=10)

    assert len(popular) == 2
    chicken = next(p for p in popular if p.name.lower() == "chicken breast")
    banana = next(p for p in popular if p.name.lower() == "banana")
    assert chicken.frequency == 3
    assert banana.frequency == 1


def test_get_popular_items_excludes_outside_window(db):
    _add_meal_with_item(db, _today_iso(), "Recent", "1c")
    _add_meal_with_item(db, _days_ago(60), "Old", "1c")

    popular = get_popular_items(db, window_days=30, limit=10)

    names = [p.name.lower() for p in popular]
    assert "recent" in names
    assert "old" not in names


def test_get_popular_items_uses_most_recent_macros(db):
    _add_meal_with_item(db, _days_ago(5), "Oats", "1c", calories=300, protein_g=11)
    _add_meal_with_item(db, _today_iso(), "Oats", "1c", calories=320, protein_g=12)

    popular = get_popular_items(db, window_days=30, limit=10)

    assert len(popular) == 1
    assert popular[0].calories == 320
    assert popular[0].protein_g == 12
    assert popular[0].frequency == 2


def test_get_popular_items_respects_limit(db):
    for i in range(12):
        _add_meal_with_item(db, _today_iso(), f"item{i}", "1")
        _add_meal_with_item(db, _today_iso(), f"item{i}", "1")  # bump frequency to 2

    popular = get_popular_items(db, window_days=30, limit=5)
    assert len(popular) == 5


def test_add_pin_lowercases_name(db):
    pin = add_pin(db, name="Greek Yogurt", quantity="1c")
    assert pin.name == "greek yogurt"
    assert pin.quantity == "1c"
    assert pin.id is not None


def test_add_pin_uniqueness(db):
    add_pin(db, name="Banana", quantity="1")
    try:
        add_pin(db, name="banana", quantity="1")
    except Exception:
        return  # IntegrityError expected
    raise AssertionError("Expected IntegrityError on duplicate pin")


def test_remove_pin_returns_true_when_found(db):
    pin = add_pin(db, name="Banana", quantity="1")
    assert remove_pin(db, pin.id) is True


def test_remove_pin_returns_false_when_missing(db):
    assert remove_pin(db, 99999) is False


def test_get_pinned_items_returns_pin_with_canonical_macros(db):
    _add_meal_with_item(db, _days_ago(2), "Greek yogurt", "1c", calories=130, protein_g=17)
    add_pin(db, name="Greek Yogurt", quantity="1c")

    pinned = get_pinned_items(db)

    assert len(pinned) == 1
    assert pinned[0].name == "Greek yogurt"  # original casing preserved
    assert pinned[0].calories == 130
    assert pinned[0].protein_g == 17
    assert pinned[0].is_pinned is True
    assert pinned[0].pin_id is not None
    assert pinned[0].frequency is None


def test_get_pinned_items_filters_orphan_pins(db):
    add_pin(db, name="Nonexistent food", quantity="1c")
    pinned = get_pinned_items(db)
    assert pinned == []
