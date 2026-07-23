"""
Daily totals computation service.
Aggregates meal macros for a given date and manages daily summary records.
"""

from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..models import Meal, DailySummary, Workout
from .tdee_service import compute_per_day_tdee
from .workout_type import infer_workout_type as _canonical_infer_workout_type


def get_latest_body_metrics(db: Session) -> tuple[float | None, float | None]:
    """
    Query the most recent DailySummary with non-null weight_lbs and bf_pct.
    Returns (weight_lbs, bf_pct) or (None, None) if no data exists.
    """
    row = (
        db.query(DailySummary.weight_lbs, DailySummary.bf_pct)
        .filter(DailySummary.weight_lbs.isnot(None), DailySummary.bf_pct.isnot(None))
        .order_by(DailySummary.date.desc())
        .first()
    )
    if row:
        return (row.weight_lbs, row.bf_pct)
    return (None, None)


def infer_workout_type_from_exercises(db: Session, date: str) -> str | None:
    """Look up workouts for the date and return the canonical workout type.

    Returns None when there are no logged workouts (vs an empty string before).
    """
    workouts = db.query(Workout).filter(Workout.date == date).all()
    return _canonical_infer_workout_type(workouts)


def compute_daily_totals(date: str, db: Session) -> dict:
    """
    Sum all meal macros for the given date string.
    Returns a dict with calories_in, protein_g, carbs_g, fat_g, fiber_g, meal_count.
    """
    result = db.query(
        func.coalesce(func.sum(Meal.calories), 0).label("calories_in"),
        func.coalesce(func.sum(Meal.protein_g), 0).label("protein_g"),
        func.coalesce(func.sum(Meal.carbs_g), 0).label("carbs_g"),
        func.coalesce(func.sum(Meal.fat_g), 0).label("fat_g"),
        func.coalesce(func.sum(Meal.fiber_g), 0).label("fiber_g"),
        func.count(Meal.id).label("meal_count"),
    ).filter(Meal.date == date).one()

    return {
        "calories_in": float(result.calories_in),
        "protein_g": float(result.protein_g),
        "carbs_g": float(result.carbs_g),
        "fat_g": float(result.fat_g),
        "fiber_g": float(result.fiber_g),
        "meal_count": int(result.meal_count),
    }


def get_or_create_daily(date: str, db: Session) -> DailySummary:
    """
    Get the DailySummary for a date, or create one if it doesn't exist.
    Always recalculates macro totals from meals.
    """
    daily = db.query(DailySummary).filter(DailySummary.date == date).first()
    if not daily:
        daily = DailySummary(date=date)
        db.add(daily)

    # Ensure day_of_week is populated (handles legacy records or incorrect create logic)
    if not daily.day_of_week or not str(daily.day_of_week).strip():
        day_of_week = ""
        for fmt in ("%Y-%m-%d", "%m/%d/%y", "%d/%m/%y"):
            try:
                dt = datetime.strptime(date, fmt)
                day_of_week = dt.strftime("%A")
                break
            except ValueError:
                continue
        
        if day_of_week:
            daily.day_of_week = day_of_week
            # If we just fixed the day name for an existing record, commit it now
            db.add(daily)
            db.commit()

    # Infer workout_type from exercises if not manually set
    if not daily.workout_type:
        # Flush pending workout inserts so the query below sees them
        # (database is configured with autoflush=False).
        db.flush()
        inferred = infer_workout_type_from_exercises(db, date)
        if inferred:
            daily.workout_type = inferred

    # Recalculate macro totals from meals
    totals = compute_daily_totals(date, db)
    daily.calories_in = totals["calories_in"]
    daily.protein_g = totals["protein_g"]
    daily.carbs_g = totals["carbs_g"]
    daily.fat_g = totals["fat_g"]
    daily.fiber_g = totals["fiber_g"]

    # Compute and store all TDEE values
    sedentary, formula, cico = compute_per_day_tdee(date, db)
    daily.sedentary_tdee = sedentary
    daily.formula_tdee = formula
    daily.cico_tdee = cico

    # Net deficit = sedentary base + exercise - food
    daily.net_deficit = daily.sedentary_tdee + (daily.est_active_burn or 0) - daily.calories_in

    db.commit()
    db.refresh(daily)
    return daily


def recalc_daily(date: str, db: Session) -> DailySummary:
    """Shorthand to recalculate and return the daily summary for a date."""
    return get_or_create_daily(date, db)


def recompute_active_burn(date: str, db: Session) -> float:
    """Derive a day's est_active_burn = sum of credited Google burn (kcal * 0.7) over
    the day's IN-LOG workouts (has manual exercise rows OR finalized) that are MATCHED
    to a Google session — the kcal comes from the match. A logged workout with no
    Google match contributes nothing (no measured kcal). Recomputed from scratch —
    replaces the incremental apply-once machinery, so burn can't drift or carry stale
    MET. Fires on lock-in and on each sync (which links the kcal). Returns the total."""
    from ..models import Activity, Workout, WorkoutSession
    from .burn import credited_burn
    acts = db.query(Activity).filter(Activity.date == date).all()
    total = 0.0
    if acts:
        with_rows = {aid for (aid,) in db.query(Workout.activity_id)
                     .filter(Workout.activity_id.in_([a.id for a in acts] or [0])).distinct().all()}
        sess = {s.id: s for s in db.query(WorkoutSession).filter(
            WorkoutSession.id.in_([a.google_session_id for a in acts if a.google_session_id] or [0])).all()}
        for a in acts:
            in_log = (a.id in with_rows) or a.finalized      # solved = logged or locked in
            g = sess.get(a.google_session_id) if a.google_session_id else None
            if in_log and g and g.calories_kcal:
                total += credited_burn(g.calories_kcal)
    daily = get_or_create_daily(date, db)          # ensure row + fresh calories_in / tdee
    daily.est_active_burn = total
    daily.net_deficit = (daily.sedentary_tdee or 0) + total - (daily.calories_in or 0)
    db.commit()
    return total
