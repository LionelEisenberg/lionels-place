"""
Meals CRUD router — secondary/correction interface.
Provides editable table operations: list, update, delete, duplicate, suggestions.
"""

from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import desc

from ..database import get_db
from ..models import Meal, MealItem, MealItemPin
from ..schemas import MealCreate, MealUpdate, MealResponse, MealItemData
from ..services.daily_calculator import recalc_daily

router = APIRouter(prefix="/api/meals", tags=["meals"])


@router.get("", response_model=list[MealResponse])
async def list_meals(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = Query(default=100, le=1000),
    db: Session = Depends(get_db),
):
    """List meals, optionally filtered by date range."""
    query = db.query(Meal).options(joinedload(Meal.items))
    if start_date:
        query = query.filter(Meal.date >= start_date)
    if end_date:
        query = query.filter(Meal.date <= end_date)
    return query.order_by(desc(Meal.date), desc(Meal.id)).limit(limit).all()


@router.get("/stats")
async def meal_stats(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Aggregate stats for meals in a date range."""
    query = db.query(Meal)
    if start_date:
        query = query.filter(Meal.date >= start_date)
    if end_date:
        query = query.filter(Meal.date <= end_date)

    meals = query.all()
    if not meals:
        return {
            "avg_calories": 0, "avg_protein": 0, "avg_carbs": 0,
            "avg_fat": 0, "avg_fiber": 0, "meal_count": 0, "day_count": 0,
            "meals_per_day": 0,
        }

    daily: dict[str, dict] = {}
    for m in meals:
        if m.date not in daily:
            daily[m.date] = {"cal": 0, "pro": 0, "carb": 0, "fat": 0, "fib": 0}
        daily[m.date]["cal"] += m.calories
        daily[m.date]["pro"] += m.protein_g
        daily[m.date]["carb"] += m.carbs_g
        daily[m.date]["fat"] += m.fat_g
        daily[m.date]["fib"] += m.fiber_g

    day_count = len(daily)
    return {
        "avg_calories": round(sum(d["cal"] for d in daily.values()) / day_count),
        "avg_protein": round(sum(d["pro"] for d in daily.values()) / day_count),
        "avg_carbs": round(sum(d["carb"] for d in daily.values()) / day_count),
        "avg_fat": round(sum(d["fat"] for d in daily.values()) / day_count),
        "avg_fiber": round(sum(d["fib"] for d in daily.values()) / day_count),
        "meal_count": len(meals),
        "day_count": day_count,
        "meals_per_day": round(len(meals) / day_count, 1),
    }


@router.post("", response_model=MealResponse)
async def create_meal(meal_in: MealCreate, db: Session = Depends(get_db)):
    """Create a new meal entry."""
    meal = Meal(**meal_in.model_dump())
    db.add(meal)
    db.commit()
    db.refresh(meal)
    recalc_daily(meal.date, db)
    return meal


@router.put("/{meal_id}", response_model=MealResponse)
async def update_meal(meal_id: int, meal_in: MealUpdate, db: Session = Depends(get_db)):
    """Update an existing meal (inline edit)."""
    meal = db.query(Meal).filter(Meal.id == meal_id).first()
    if not meal:
        raise HTTPException(status_code=404, detail="Meal not found")

    old_date = meal.date
    update_data = meal_in.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(meal, key, value)

    db.commit()
    db.refresh(meal)

    # Recalc both old and new date if date changed
    recalc_daily(meal.date, db)
    if old_date != meal.date:
        recalc_daily(old_date, db)

    return meal


@router.put("/{meal_id}/items", response_model=MealResponse)
async def update_meal_items(
    meal_id: int, items: list[MealItemData], db: Session = Depends(get_db),
):
    """Bulk-replace meal items and recalculate meal totals from them."""
    meal = db.query(Meal).options(joinedload(Meal.items)).filter(Meal.id == meal_id).first()
    if not meal:
        raise HTTPException(status_code=404, detail="Meal not found")

    # Delete existing items
    db.query(MealItem).filter(MealItem.meal_id == meal_id).delete()

    # Insert new items
    for item_data in items:
        db.add(MealItem(meal_id=meal_id, **item_data.model_dump()))

    # Recalculate meal totals from items
    meal.calories = sum(i.calories for i in items)
    meal.protein_g = sum(i.protein_g for i in items)
    meal.carbs_g = sum(i.carbs_g for i in items)
    meal.fat_g = sum(i.fat_g for i in items)
    meal.fiber_g = sum(i.fiber_g for i in items)
    meal.description = ", ".join(i.name for i in items)

    # Recompute confidence from updated items
    from ..services.confidence import compute_meal_confidence
    meal.confidence = compute_meal_confidence(items)

    db.commit()
    db.refresh(meal)
    recalc_daily(meal.date, db)
    return meal


@router.delete("/{meal_id}")
async def delete_meal(meal_id: int, db: Session = Depends(get_db)):
    """Delete a meal entry."""
    meal = db.query(Meal).filter(Meal.id == meal_id).first()
    if not meal:
        raise HTTPException(status_code=404, detail="Meal not found")

    date = meal.date
    db.delete(meal)
    db.commit()
    recalc_daily(date, db)
    return {"status": "deleted", "id": meal_id}


@router.post("/duplicate/{meal_id}", response_model=MealResponse)
async def duplicate_meal(meal_id: int, date: Optional[str] = None, db: Session = Depends(get_db)):
    """Duplicate an existing meal with today's date (or specified date)."""
    from datetime import datetime
    import zoneinfo

    original = db.query(Meal).filter(Meal.id == meal_id).first()
    if not original:
        raise HTTPException(status_code=404, detail="Meal not found")

    target_date = date or datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")
    new_meal = Meal(
        date=target_date,
        meal=original.meal,
        description=original.description,
        calories=original.calories,
        protein_g=original.protein_g,
        carbs_g=original.carbs_g,
        fat_g=original.fat_g,
        fiber_g=original.fiber_g,
        confidence=original.confidence,
    )
    db.add(new_meal)
    db.flush()

    # Copy items with confidence data
    for item in db.query(MealItem).filter(MealItem.meal_id == meal_id).all():
        db.add(MealItem(
            meal_id=new_meal.id,
            name=item.name,
            quantity=item.quantity,
            calories=item.calories,
            protein_g=item.protein_g,
            carbs_g=item.carbs_g,
            fat_g=item.fat_g,
            fiber_g=item.fiber_g,
            confidence=item.confidence,
            confidence_reason=item.confidence_reason,
        ))

    db.commit()
    db.refresh(new_meal)
    recalc_daily(target_date, db)
    return new_meal


@router.get("/suggestions")
async def meal_suggestions(q: str = "", limit: int = 10, db: Session = Depends(get_db)):
    """Autocomplete search over meal descriptions from history."""
    if not q:
        # Return most recent unique descriptions
        meals = db.query(Meal.description).distinct().order_by(desc(Meal.id)).limit(limit).all()
    else:
        meals = (
            db.query(Meal.description)
            .filter(Meal.description.ilike(f"%{q}%"))
            .distinct()
            .order_by(desc(Meal.id))
            .limit(limit)
            .all()
        )
    return [m[0] for m in meals]


@router.post("/bulk")
async def bulk_import_meals(meals: list[MealCreate], db: Session = Depends(get_db)):
    """Batch import meals (e.g., from CSV paste)."""
    dates_affected = set()
    for meal_in in meals:
        meal = Meal(**meal_in.model_dump())
        db.add(meal)
        dates_affected.add(meal_in.date)

    db.commit()

    for date in dates_affected:
        recalc_daily(date, db)

    return {"status": "imported", "count": len(meals)}


# ==========================================
# Quick Add Panel
# ==========================================

from ..schemas import (
    QuickAddData,
    QuickAddItem,
    QuickAddPinRequest,
    QuickAddLogRequest,
)
from ..services import quick_add_service


@router.get("/quick-add", response_model=QuickAddData)
async def get_quick_add(db: Session = Depends(get_db)):
    """Return pinned + popular MealItems for the Quick Add panel."""
    pinned = quick_add_service.get_pinned_items(db)
    popular = quick_add_service.get_popular_items(db, window_days=30, limit=24)

    pinned_keys = {(p.name.lower(), p.quantity) for p in pinned}
    popular = [p for p in popular if (p.name.lower(), p.quantity) not in pinned_keys]

    return QuickAddData(pinned=pinned, popular=popular, window_days=30)


@router.post("/quick-add/pins", response_model=QuickAddItem)
async def create_pin(req: QuickAddPinRequest, db: Session = Depends(get_db)):
    """Pin a (name, quantity) pair so it always appears in the Quick Add panel."""
    name_lower = req.name.lower().strip()
    quantity = req.quantity.strip()

    # Pre-flight uniqueness check (avoids triggering an IntegrityError that
    # would poison the session — caller relies on getting a clean 409 + JSON body).
    existing = (
        db.query(MealItemPin)
        .filter(MealItemPin.name == name_lower, MealItemPin.quantity == quantity)
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="Already pinned")

    pin = quick_add_service.add_pin(db, name=name_lower, quantity=quantity)
    pinned = quick_add_service.get_pinned_items(db)
    for p in pinned:
        if p.pin_id == pin.id:
            return p
    # Orphan pin: no MealItem match exists yet — return a zero-macro placeholder
    # so the caller can display the chip immediately without a 500.
    return QuickAddItem(
        name=name_lower,
        quantity=quantity,
        calories=0,
        protein_g=0,
        carbs_g=0,
        fat_g=0,
        fiber_g=0,
        frequency=None,
        is_pinned=True,
        pin_id=pin.id,
    )


@router.delete("/quick-add/pins/{pin_id}", status_code=204)
async def delete_pin(pin_id: int, db: Session = Depends(get_db)):
    """Remove a pin."""
    if not quick_add_service.remove_pin(db, pin_id):
        raise HTTPException(status_code=404, detail="Pin not found")


@router.post("/quick-add/log", response_model=MealResponse)
async def log_quick_add_meal(req: QuickAddLogRequest, db: Session = Depends(get_db)):
    """Atomically create a Meal + MealItems from a Quick Add draft."""
    if not req.items:
        raise HTTPException(status_code=400, detail="Cannot log an empty meal")

    import zoneinfo
    target_date = req.date or datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")

    total_cal = sum(i.calories for i in req.items)
    total_pro = sum(i.protein_g for i in req.items)
    total_carb = sum(i.carbs_g for i in req.items)
    total_fat = sum(i.fat_g for i in req.items)
    total_fib = sum(i.fiber_g for i in req.items)
    description = ", ".join(i.name for i in req.items)

    meal = Meal(
        date=target_date,
        meal=req.meal_type,
        description=description,
        calories=total_cal,
        protein_g=total_pro,
        carbs_g=total_carb,
        fat_g=total_fat,
        fiber_g=total_fib,
        confidence=None,
    )
    db.add(meal)
    db.flush()

    for item in req.items:
        db.add(MealItem(
            meal_id=meal.id,
            name=item.name,
            quantity=item.quantity,
            calories=item.calories,
            protein_g=item.protein_g,
            carbs_g=item.carbs_g,
            fat_g=item.fat_g,
            fiber_g=item.fiber_g,
            confidence=None,
            confidence_reason=None,
        ))

    db.commit()
    db.refresh(meal)
    recalc_daily(target_date, db)
    return meal
