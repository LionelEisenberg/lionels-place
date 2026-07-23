"""
Export router — CSV download endpoints for data portability.
"""

import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import desc

from ..database import get_db
from ..models import Meal, Workout, DailySummary
from ..services.habit_config import habit_qty_header

router = APIRouter(prefix="/api/export", tags=["export"])


def _csv_response(rows: list[dict], filename: str) -> StreamingResponse:
    """Generate a CSV StreamingResponse from a list of dicts."""
    if not rows:
        return StreamingResponse(io.StringIO(""), media_type="text/csv")

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    output.seek(0)

    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/meals")
async def export_meals(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Export meals as CSV."""
    query = db.query(Meal)
    if start_date:
        query = query.filter(Meal.date >= start_date)
    if end_date:
        query = query.filter(Meal.date <= end_date)

    meals = query.order_by(Meal.date, Meal.id).all()
    rows = [
        {
            "Date": m.date,
            "Meal": m.meal,
            "Description": m.description,
            "Calories": m.calories,
            "Protein (g)": m.protein_g,
            "Carbs (g)": m.carbs_g,
            "Fat (g)": m.fat_g,
            "Fiber (g)": m.fiber_g,
        }
        for m in meals
    ]
    return _csv_response(rows, "meals.csv")


@router.get("/workouts")
async def export_workouts(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Export workouts as CSV."""
    query = db.query(Workout)
    if start_date:
        query = query.filter(Workout.date >= start_date)
    if end_date:
        query = query.filter(Workout.date <= end_date)

    workouts = query.order_by(Workout.date, Workout.id).all()
    rows = [
        {
            "Date": w.date,
            "Category": w.category,
            "Equipment Type": w.equipment_type,
            "Exercise": w.exercise,
            "Weight (lbs)": w.weight_lbs,
            "Reps / Sets": w.reps_sets,
            "Notes": w.notes,
            "Targeted Muscle Group": w.targeted_muscle_group,
        }
        for w in workouts
    ]
    return _csv_response(rows, "workouts.csv")


@router.get("/daily")
async def export_daily(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Export daily summaries as CSV."""
    query = db.query(DailySummary)
    if start_date:
        query = query.filter(DailySummary.date >= start_date)
    if end_date:
        query = query.filter(DailySummary.date <= end_date)

    daily = query.order_by(DailySummary.date).all()
    header = habit_qty_header()
    rows = [
        {
            "DOTW": d.day_of_week or "",
            "Date": d.date,
            "Workout": d.workout_type or "",
            "Weight (lbs)": d.weight_lbs or "",
            "Calories In": d.calories_in,
            "Protein (g)": d.protein_g,
            "Carbs (g)": d.carbs_g,
            "Fat (g)": d.fat_g,
            "Fiber (g)": d.fiber_g,
            "Est. Active Burn": d.est_active_burn,
            "Sedentary TDEE": d.sedentary_tdee,
            "Formula TDEE": d.formula_tdee,
            "CICO TDEE": d.cico_tdee,
            "Net Deficit": d.net_deficit,
            "Drinks Consumed": d.drinks_consumed if d.drinks_consumed is not None else "",
            header: d.habit_qty if d.habit_qty is not None else "",
            "Mood": d.mood or "",
            "Notes": d.notes or "",
        }
        for d in daily
    ]
    return _csv_response(rows, "daily.csv")
