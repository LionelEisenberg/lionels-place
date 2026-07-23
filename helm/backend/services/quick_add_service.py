"""Quick Add service — popularity ranking, pinned lookup, pin CRUD."""

from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import Meal, MealItem, MealItemPin
from ..schemas import QuickAddItem


def get_popular_items(
    db: Session,
    window_days: int = 30,
    limit: int = 8,
) -> list[QuickAddItem]:
    """Return top-N most-frequent (lower(name), quantity) pairs in the window.
    Each item carries the macros from the most-recent matching MealItem row.
    """
    cutoff = (datetime.now() - timedelta(days=window_days)).strftime("%Y-%m-%d")
    name_lower = func.lower(MealItem.name)

    grouped = (
        db.query(
            name_lower.label("name_lower"),
            MealItem.quantity.label("quantity"),
            func.count(MealItem.id).label("freq"),
            func.max(MealItem.id).label("latest_id"),
        )
        .join(Meal, Meal.id == MealItem.meal_id)
        .filter(Meal.date >= cutoff)
        .group_by(name_lower, MealItem.quantity)
        .order_by(func.count(MealItem.id).desc(), func.max(MealItem.id).desc())
        .limit(limit)
        .all()
    )
    if not grouped:
        return []

    latest_ids = [g.latest_id for g in grouped]
    rows = db.query(MealItem).filter(MealItem.id.in_(latest_ids)).all()
    rows_by_id = {r.id: r for r in rows}
    freq_by_id = {g.latest_id: g.freq for g in grouped}

    pinned_keys = {
        (p.name, p.quantity)
        for p in db.query(MealItemPin.name, MealItemPin.quantity).all()
    }
    pin_id_by_key = {
        (p.name, p.quantity): p.id
        for p in db.query(MealItemPin).all()
    }

    out: list[QuickAddItem] = []
    for g in grouped:
        row = rows_by_id[g.latest_id]
        key = (g.name_lower, g.quantity)
        out.append(QuickAddItem(
            name=row.name,
            quantity=row.quantity,
            calories=row.calories,
            protein_g=row.protein_g,
            carbs_g=row.carbs_g,
            fat_g=row.fat_g,
            fiber_g=row.fiber_g,
            frequency=freq_by_id[g.latest_id],
            is_pinned=key in pinned_keys,
            pin_id=pin_id_by_key.get(key),
        ))
    return out


def add_pin(db: Session, name: str, quantity: str) -> MealItemPin:
    """Insert a new pin (lowercased name). Caller handles uniqueness conflicts."""
    pin = MealItemPin(name=name.lower().strip(), quantity=quantity.strip())
    db.add(pin)
    db.commit()
    db.refresh(pin)
    return pin


def remove_pin(db: Session, pin_id: int) -> bool:
    """Delete a pin by id. Returns True if deleted, False if not found."""
    pin = db.query(MealItemPin).filter(MealItemPin.id == pin_id).first()
    if not pin:
        return False
    db.delete(pin)
    db.commit()
    return True


def get_pinned_items(db: Session) -> list[QuickAddItem]:
    """For each pin, return a QuickAddItem with macros from the most-recent
    matching MealItem (by lower(name), quantity), regardless of date.
    Orphan pins (no matching MealItem) are filtered out.
    """
    pins = db.query(MealItemPin).order_by(MealItemPin.created_at).all()
    if not pins:
        return []

    name_lower = func.lower(MealItem.name)
    out: list[QuickAddItem] = []
    for pin in pins:
        latest = (
            db.query(MealItem)
            .filter(name_lower == pin.name, MealItem.quantity == pin.quantity)
            .order_by(MealItem.id.desc())
            .first()
        )
        if not latest:
            continue
        out.append(QuickAddItem(
            name=latest.name,
            quantity=latest.quantity,
            calories=latest.calories,
            protein_g=latest.protein_g,
            carbs_g=latest.carbs_g,
            fat_g=latest.fat_g,
            fiber_g=latest.fiber_g,
            frequency=None,
            is_pinned=True,
            pin_id=pin.id,
        ))
    return out
