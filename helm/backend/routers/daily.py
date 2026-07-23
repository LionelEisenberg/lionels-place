"""
Daily summary router.
Provides auto-computed summaries from meals + manual fields (weight, TDEE, burn).
"""

import json
import os
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from ..database import get_db
from ..models import Meal, DailySummary, Workout, Phase
from ..schemas import DailySummaryUpdate, DailySummaryResponse, RunningTotalsResponse, DashboardStatsResponse, TDEEInfoResponse
from ..services.daily_calculator import get_or_create_daily, compute_daily_totals
from ..services.phase_service import resolve_targets
from ..services.tdee_service import get_effective_tdee

router = APIRouter(prefix="/api/daily", tags=["daily"])

_ROUTER_DIR = os.path.dirname(os.path.abspath(__file__))
_HABITS_CONFIG_PATH = os.path.join(_ROUTER_DIR, "..", "..", "habits_config.json")

@router.get("", response_model=list[DailySummaryResponse])
async def list_daily(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = Query(default=30, le=5000),
    db: Session = Depends(get_db),
):
    """List daily summaries, optionally filtered by date range."""
    from ..services.daily_calculator import infer_workout_type_from_exercises
    query = db.query(DailySummary)
    if start_date:
        query = query.filter(DailySummary.date >= start_date)
    if end_date:
        query = query.filter(DailySummary.date <= end_date)
    rows = query.order_by(desc(DailySummary.date)).limit(limit).all()

    # Backfill workout_type for any days missing it
    dirty = False
    for row in rows:
        if not row.workout_type:
            inferred = infer_workout_type_from_exercises(db, row.date)
            if inferred:
                row.workout_type = inferred
                dirty = True
    if dirty:
        db.commit()

    return rows


@router.get("/dashboard-stats", response_model=DashboardStatsResponse)
async def get_dashboard_stats(db: Session = Depends(get_db)):
    """Compute streaks and weekly progress metrics for the top panel."""
    from datetime import timedelta, datetime
    import zoneinfo
    tz = zoneinfo.ZoneInfo("America/Los_Angeles")
    today_dt = datetime.now(tz)
    today_str = today_dt.strftime("%Y-%m-%d")

    # Ensure today's record exists so its deficit (TDEE) counts towards the week
    get_or_create_daily(today_str, db)
    
    # Fast Streak Query using raw SQL (find the most recent date with NO record, and count days since then)
    from sqlalchemy import text
    
    # MEAL STREAK
    # Find the most recent date before or equal to today where calories_in <= 0 or is missing
    # To do this, we count the number of consecutive days backwards from today where calories_in > 0
    meal_streak_query = text("""
        WITH RECURSIVE dates(d) AS (
            SELECT :today
            UNION ALL
            SELECT date(d, '-1 day')
            FROM dates
            WHERE EXISTS (
                SELECT 1 FROM daily_summaries 
                WHERE date = d AND calories_in > 0
            ) AND d >= date(:today, '-1000 days')  -- safety limit
        )
        SELECT count(*) - 1 FROM dates;
    """)
    meal_streak = db.execute(meal_streak_query, {"today": today_dt.strftime("%Y-%m-%d")}).scalar() or 0

    # If today is empty but yesterday had calories, the recursive CTE stops immediately (count=1 -> streak=0).
    # We want to allow today to be empty without breaking the streak.
    if meal_streak == 0:
        yesterday_str = (today_dt - timedelta(days=1)).strftime("%Y-%m-%d")
        meal_streak = db.execute(meal_streak_query, {"today": yesterday_str}).scalar() or 0

    # WORKOUT STREAK
    workout_streak_query = text("""
        WITH RECURSIVE dates(d) AS (
            SELECT :today
            UNION ALL
            SELECT date(d, '-1 day')
            FROM dates
            WHERE EXISTS (
                SELECT 1 FROM workouts WHERE date = d
            ) AND d >= date(:today, '-1000 days')
        )
        SELECT count(*) - 1 FROM dates;
    """)
    workout_streak = db.execute(workout_streak_query, {"today": today_dt.strftime("%Y-%m-%d")}).scalar() or 0

    if workout_streak == 0:
        yesterday_str = (today_dt - timedelta(days=1)).strftime("%Y-%m-%d")
        workout_streak = db.execute(workout_streak_query, {"today": yesterday_str}).scalar() or 0


    # Weekly Tally (Monday = 0, Sunday = 6)
    # Get all days for the current week (from this past Monday to today)
    start_of_week = today_dt - timedelta(days=today_dt.weekday())
    start_date_str = start_of_week.strftime("%Y-%m-%d")
    end_date_str = (start_of_week + timedelta(days=6)).strftime("%Y-%m-%d")

    # Tally workout sessions by type across the week (using DailySummary.workout_type)
    from ..services.daily_calculator import infer_workout_type_from_exercises
    week_dailies_with_workouts = db.query(DailySummary).filter(
        DailySummary.date >= start_date_str,
        DailySummary.date <= end_date_str,
    ).all()

    # Backfill workout_type for any days that have workouts but no type set
    for wd in week_dailies_with_workouts:
        if not wd.workout_type:
            inferred = infer_workout_type_from_exercises(db, wd.date)
            if inferred:
                wd.workout_type = inferred
    db.commit()

    push = sum(1 for d in week_dailies_with_workouts if d.workout_type and 'push' in d.workout_type.lower())
    pull = sum(1 for d in week_dailies_with_workouts if d.workout_type and 'pull' in d.workout_type.lower())
    legs = sum(1 for d in week_dailies_with_workouts if d.workout_type and 'leg' in d.workout_type.lower())
    week_workouts = db.query(Workout).filter(
        Workout.date >= start_date_str,
        Workout.date <= end_date_str
    ).all()
    total_workouts = len(set(w.date for w in week_workouts))  # Unique days worked out

    # Cumulative Deficit
    week_dailies = db.query(DailySummary).filter(
        DailySummary.date >= start_date_str,
        DailySummary.date <= end_date_str
    ).order_by(DailySummary.date.asc()).all()
    
    # Sum deficits from stored values — skip days with no sedentary TDEE
    weekly_deficit = sum(
        (d.sedentary_tdee + (d.est_active_burn or 0) - (d.calories_in or 0))
        for d in week_dailies
        if d.sedentary_tdee and d.sedentary_tdee > 0
    )

    # Calculate rolling 7-day weight change (progress)
    # Instead of comparing just this week (which resets on Monday), we compare latest to ~7 days ago.
    lookup_start = (today_dt - timedelta(days=14)).strftime("%Y-%m-%d")
    recent_dailies_for_weight = db.query(DailySummary).filter(
        DailySummary.date >= lookup_start,
        DailySummary.weight_lbs != None,
        DailySummary.weight_lbs > 0
    ).order_by(DailySummary.date.asc()).all()

    weight_change_this_week = None
    if recent_dailies_for_weight:
        latest_w = recent_dailies_for_weight[-1]
        latest_date = datetime.strptime(latest_w.date, "%Y-%m-%d")
        
        # Find the entry closest to 7 days prior
        best_diff = 999
        base_w = None
        
        for d in recent_dailies_for_weight[:-1]:
            d_date = datetime.strptime(d.date, "%Y-%m-%d")
            diff_days = (latest_date - d_date).days
            # How close is this to 7 days?
            closeness = abs(diff_days - 7)
            if closeness < best_diff:
                best_diff = closeness
                base_w = d
        
        if base_w:
            weight_change_this_week = latest_w.weight_lbs - base_w.weight_lbs
        else:
            weight_change_this_week = 0.0



    # Determine Today's Target from PPL rotation
    # Rotation: Push → Pull → Legs → Push → Pull → Legs → Rest
    PPL_NEXT = {"Push": "Pull", "Pull": "Legs", "Legs": "Push"}

    today_workout_target = "Rest / Unknown"
    today_daily_for_target = db.query(DailySummary).filter(DailySummary.date == today_str).first()
    today_workout = db.query(Workout).filter(Workout.date == today_str).first()

    if today_daily_for_target and today_daily_for_target.workout_type:
        # Already set (manually or from a committed workout)
        today_workout_target = today_daily_for_target.workout_type
    elif today_workout:
        today_workout_target = "Completed"
    else:
        # Derive from last PPL workout type in the rotation
        last_workout_day = (
            db.query(DailySummary)
            .filter(
                DailySummary.workout_type.in_(list(PPL_NEXT.keys())),
                DailySummary.date < today_str,
            )
            .order_by(DailySummary.date.desc())
            .first()
        )
        if last_workout_day:
            # Check if 6 sessions done this week → suggest Rest
            sessions_this_week = push + pull + legs
            if sessions_this_week >= 6:
                today_workout_target = "Rest"
            else:
                today_workout_target = PPL_NEXT[last_workout_day.workout_type]
        
    # ── Sparkline arrays (last 7 days) ──────────────────────────────────────
    sparkline_dates = [
        (today_dt - timedelta(days=i)).strftime("%Y-%m-%d")
        for i in range(6, -1, -1)
    ]
    sparkline_rows = db.query(DailySummary).filter(
        DailySummary.date.in_(sparkline_dates)
    ).all()
    sparkline_by_date = {row.date: row for row in sparkline_rows}

    weight_sparkline: list[Optional[float]] = []
    deficit_sparkline: list[float] = []
    sleep_sparkline: list[Optional[float]] = []
    for d in sparkline_dates:
        row = sparkline_by_date.get(d)
        weight_sparkline.append(row.weight_lbs if row else None)
        if row and row.sedentary_tdee and row.sedentary_tdee > 0:
            day_deficit = row.sedentary_tdee + (row.est_active_burn or 0) - (row.calories_in or 0)
        else:
            day_deficit = 0.0
        deficit_sparkline.append(day_deficit)
        sleep_sparkline.append(row.sleep_hours if row else None)

    # ── Current weight & goal progress ──────────────────────────────────────
    latest_weight_row = (
        db.query(DailySummary)
        .filter(DailySummary.weight_lbs.isnot(None), DailySummary.weight_lbs > 0)
        .order_by(DailySummary.date.desc())
        .first()
    )
    current_weight = latest_weight_row.weight_lbs if latest_weight_row else None

    current_phase_row = (
        db.query(Phase)
        .filter(Phase.end_date.is_(None))
        .first()
    )
    weight_goal = current_phase_row.target_weight_lbs if current_phase_row else None

    weight_lost_total: Optional[float] = None
    weight_remaining: Optional[float] = None
    if current_weight is not None and weight_goal is not None:
        weight_remaining = round(current_weight - weight_goal, 1)
        # Use oldest logged weight as the starting point for total loss
        oldest_weight_row = (
            db.query(DailySummary)
            .filter(DailySummary.weight_lbs.isnot(None), DailySummary.weight_lbs > 0)
            .order_by(DailySummary.date.asc())
            .first()
        )
        if oldest_weight_row:
            weight_lost_total = round(oldest_weight_row.weight_lbs - current_weight, 1)

    # ── TDEE (prefer CICO when available, fall back to formula) ──────────────
    today_daily_row = sparkline_by_date.get(today_str)
    tdee_cico = None
    tdee_sedentary = None
    if today_daily_row:
        tdee_cico = today_daily_row.cico_tdee if today_daily_row.cico_tdee else today_daily_row.formula_tdee
        tdee_sedentary = today_daily_row.sedentary_tdee

    # ── Sleep averages and today's times ─────────────────────────────────────
    sleep_values = [h for h in sleep_sparkline if h is not None]
    sleep_avg_7d = round(sum(sleep_values) / len(sleep_values), 1) if sleep_values else None

    sleep_bedtime: Optional[str] = None
    sleep_waketime: Optional[str] = None
    if today_daily_row:
        sleep_bedtime = today_daily_row.sleep_bedtime
        sleep_waketime = today_daily_row.sleep_waketime

    # ── Deficit in lbs (weekly) ───────────────────────────────────────────────
    deficit_lbs_weekly = round(weekly_deficit / 3500, 2) if weekly_deficit else None

    # Google Health vitals (reuse the same sparkline_dates window)
    from ..models import DailyHealth
    health_rows = {h.date: h for h in db.query(DailyHealth).filter(DailyHealth.date.in_(sparkline_dates)).all()}
    rhr_sparkline = [health_rows[d].resting_hr if d in health_rows else None for d in sparkline_dates]
    hrv_sparkline = [health_rows[d].hrv_ms if d in health_rows else None for d in sparkline_dates]
    _rhr_vals = [v for v in rhr_sparkline if v is not None]
    _hrv_vals = [v for v in hrv_sparkline if v is not None]
    resting_hr = _rhr_vals[-1] if _rhr_vals else None
    hrv_ms = _hrv_vals[-1] if _hrv_vals else None
    resting_hr_avg_7d = round(sum(_rhr_vals) / len(_rhr_vals), 1) if _rhr_vals else None
    hrv_avg_7d = round(sum(_hrv_vals) / len(_hrv_vals), 1) if _hrv_vals else None

    return DashboardStatsResponse(
        meal_streak=meal_streak,
        workout_streak=workout_streak,
        weekly_push=push,
        weekly_pull=pull,
        weekly_legs=legs,
        weekly_workouts_total=total_workouts,
        weekly_deficit=weekly_deficit,
        avg_weight_7d=round(weight_change_this_week, 1) if weight_change_this_week is not None else None,
        today_workout_target=today_workout_target,
        weight_sparkline=weight_sparkline,
        deficit_sparkline=deficit_sparkline,
        sleep_sparkline=sleep_sparkline,
        current_weight=current_weight,
        weight_goal=weight_goal,
        weight_lost_total=weight_lost_total,
        weight_remaining=weight_remaining,
        tdee_cico=tdee_cico,
        tdee_sedentary=tdee_sedentary,
        sleep_avg_7d=sleep_avg_7d,
        sleep_bedtime=sleep_bedtime,
        sleep_waketime=sleep_waketime,
        deficit_lbs_weekly=deficit_lbs_weekly,
        resting_hr=resting_hr,
        resting_hr_avg_7d=resting_hr_avg_7d,
        rhr_sparkline=rhr_sparkline,
        hrv_ms=hrv_ms,
        hrv_avg_7d=hrv_avg_7d,
        hrv_sparkline=hrv_sparkline,
    )


@router.get("/today", response_model=RunningTotalsResponse)
async def get_today(db: Session = Depends(get_db)):
    """Get today's running totals with phase-aware target resolution."""
    import zoneinfo
    today = datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")
    totals = compute_daily_totals(today, db)

    daily = db.query(DailySummary).filter(DailySummary.date == today).first()
    weight = daily.weight_lbs if daily else None
    if weight is None:
        recent = (
            db.query(DailySummary)
            .filter(DailySummary.weight_lbs.isnot(None))
            .order_by(desc(DailySummary.date))
            .first()
        )
        weight = recent.weight_lbs if recent else None

    targets = resolve_targets(today, db)

    protein_g = totals["protein_g"]
    sleep_hours = daily.sleep_hours if daily else None
    return RunningTotalsResponse(
        date=today,
        calories_in=totals["calories_in"],
        protein_g=protein_g,
        carbs_g=totals["carbs_g"],
        fat_g=totals["fat_g"],
        fiber_g=totals["fiber_g"],
        protein_target=targets.protein_g,
        protein_pct=round((protein_g / targets.protein_g) * 100, 1) if targets.protein_g else 0,
        carbs_target=targets.carbs_g,
        fat_target=targets.fat_g,
        fiber_target=targets.fiber_g,
        calorie_target=targets.calories,
        weight_lbs=weight,
        sleep_hours=sleep_hours,
        meal_count=totals["meal_count"],
        phase_type=targets.phase_type,
        phase_day=targets.day_of_phase,
        phase_total_days=targets.total_phase_days,
        in_refeed=(targets.source == "refeed"),
        refeed_day=targets.refeed_day,
        refeed_total_days=targets.refeed_total_days,
    )


@router.get("/tdee", response_model=TDEEInfoResponse)
async def get_tdee_info(db: Session = Depends(get_db)):
    """Return the current best TDEE estimate (formula or CICO-derived)."""
    info = get_effective_tdee(db)
    return TDEEInfoResponse(**info.__dict__)


@router.get("/habits/config")
def get_habits_config():
    """Return habit descriptions plus display meta for the configurable custom habit."""
    from ..services.habit_config import habit_label, habit_emoji, habit_unit
    with open(_HABITS_CONFIG_PATH) as f:
        config = json.load(f)
    config["_meta"] = {"label": habit_label(), "emoji": habit_emoji(), "unit": habit_unit()}
    return config


@router.get("/{date}", response_model=DailySummaryResponse)
async def get_daily(date: str, db: Session = Depends(get_db)):
    """Get or compute daily summary for a specific date."""
    daily = get_or_create_daily(date, db)
    return daily


@router.put("/{date}", response_model=DailySummaryResponse)
async def update_daily(date: str, update: DailySummaryUpdate, db: Session = Depends(get_db)):
    """Update manual daily fields (weight, active burn, TDEE, notes)."""
    daily = get_or_create_daily(date, db)

    update_data = update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(daily, key, value)

    # Recompute TDEE values — but respect manual override of sedentary_tdee
    from ..services.tdee_service import compute_per_day_tdee
    sedentary, formula, cico = compute_per_day_tdee(date, db)
    if 'sedentary_tdee' not in update_data:
        daily.sedentary_tdee = sedentary
    daily.formula_tdee = formula
    daily.cico_tdee = cico
    daily.net_deficit = daily.sedentary_tdee + (daily.est_active_burn or 0) - daily.calories_in

    db.commit()
    db.refresh(daily)
    return daily
