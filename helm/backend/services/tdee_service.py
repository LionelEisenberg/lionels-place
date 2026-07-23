"""
Dynamic TDEE calculation service.
- formula_tdee: Mifflin-St Jeor BMR × activity multiplier
- cico_tdee: Observed from weight trend + calorie intake via OLS regression
- sedentary_tdee: Calibrated from CICO when stable, else formula BMR × 1.2
"""

from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timedelta
from statistics import mean

from sqlalchemy.orm import Session
from sqlalchemy import desc

from ..models import DailySummary, Workout

# ==========================================
# Constants
# ==========================================

HEIGHT_CM = 186
AGE = 27
MIN_STABLE_DAYS = 28
LBS_PER_KG = 0.453592
KCAL_PER_LB = 3500.0


# ==========================================
# Data class
# ==========================================

@dataclass
class TDEEInfo:
    tdee: float
    source: str          # 'formula' | 'cico'
    formula_tdee: float | None
    cico_tdee: float | None
    n_days: int
    is_stable: bool
    confidence: float    # 0.0–1.0


# ==========================================
# BMR / Mifflin-St Jeor
# ==========================================

def compute_bmr(weight_lbs: float) -> float:
    """Raw Mifflin-St Jeor BMR (male), no activity multiplier."""
    weight_kg = weight_lbs * LBS_PER_KG
    return 10 * weight_kg + 6.25 * HEIGHT_CM - 5 * AGE + 5


def compute_formula_tdee(weight_lbs: float, workout_days_per_week: float) -> float:
    """BMR × activity multiplier."""
    bmr = compute_bmr(weight_lbs)

    if workout_days_per_week == 0:
        factor = 1.2
    elif workout_days_per_week <= 3:
        factor = 1.375
    elif workout_days_per_week <= 6:
        factor = 1.55
    else:
        factor = 1.725

    return bmr * factor


# ==========================================
# CICO regression
# ==========================================

def _ols_slope_and_avg_cal(rows: list) -> tuple[float, float, int]:
    """
    Given rows of (date_str, weight_lbs, calories_in), return
    (slope_lbs_per_day, avg_calories, n_valid).
    """
    valid = []
    for date_str, w, c in rows:
        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d")
            valid.append((dt, w, c))
        except (ValueError, TypeError):
            continue

    n = len(valid)
    if n < 2:
        return 0.0, 0.0, n

    day0 = valid[0][0]
    xs = [(dt - day0).days for dt, _, _ in valid]
    ys = [w for _, w, _ in valid]
    cals = [c for _, _, c in valid]

    n_f = float(n)
    sum_x = sum(xs)
    sum_y = sum(ys)
    sum_xy = sum(x * y for x, y in zip(xs, ys))
    sum_x2 = sum(x * x for x in xs)
    denom = n_f * sum_x2 - sum_x ** 2
    if denom == 0:
        return 0.0, mean(cals), n

    slope = (n_f * sum_xy - sum_x * sum_y) / denom
    return slope, mean(cals), n


def compute_cico_tdee_from_db(db: Session, as_of_date: str | None = None, lookback_days: int = 90) -> tuple[float | None, int, bool]:
    """
    Returns (cico_tdee, n_paired_days, is_stable).
    If as_of_date is None, uses today.
    """
    if as_of_date is None:
        end_date = datetime.now().strftime("%Y-%m-%d")
    else:
        end_date = as_of_date

    cutoff = (datetime.strptime(end_date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")

    rows = (
        db.query(DailySummary.date, DailySummary.weight_lbs, DailySummary.calories_in)
        .filter(
            DailySummary.date > cutoff,
            DailySummary.date <= end_date,
            DailySummary.weight_lbs > 0,
            DailySummary.calories_in > 100,
        )
        .order_by(DailySummary.date.asc())
        .all()
    )

    slope, avg_cal, n = _ols_slope_and_avg_cal([(r[0], r[1], r[2]) for r in rows])
    if n < 2:
        return None, n, False

    observed_tdee = avg_cal - (slope * KCAL_PER_LB)

    if observed_tdee < 1200 or observed_tdee > 5000:
        return None, n, False

    is_stable = n >= MIN_STABLE_DAYS
    return observed_tdee, n, is_stable


# ==========================================
# Per-day TDEE computation (stored on DailySummary)
# ==========================================

def compute_per_day_tdee(date: str, db: Session) -> tuple[float, float | None, float | None]:
    """
    Compute (sedentary_tdee, formula_tdee, cico_tdee) for a given date.

    Sedentary TDEE fallback chain:
    1. CICO-calibrated: cico_tdee - avg_est_active_burn_90d
    2. Formula sedentary: BMR × 1.2
    3. Zero (no weight data)
    """
    # --- Latest weight up to this date ---
    latest_weight_row = (
        db.query(DailySummary)
        .filter(DailySummary.weight_lbs > 0, DailySummary.date <= date)
        .order_by(desc(DailySummary.date))
        .first()
    )
    weight_lbs = latest_weight_row.weight_lbs if latest_weight_row else None

    # --- Formula TDEE ---
    formula_tdee = None
    if weight_lbs:
        cutoff_28 = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=28)).strftime("%Y-%m-%d")
        workout_dates = (
            db.query(Workout.date)
            .filter(Workout.date > cutoff_28, Workout.date <= date)
            .distinct()
            .all()
        )
        workout_days_per_week = len(workout_dates) / 4.0
        formula_tdee = round(compute_formula_tdee(weight_lbs, workout_days_per_week), 1)

    # --- CICO TDEE ---
    cico_tdee_val, n_days, is_stable = compute_cico_tdee_from_db(db, as_of_date=date)
    cico_tdee = round(cico_tdee_val, 1) if cico_tdee_val is not None else None

    # --- Sedentary TDEE (calibrated) ---
    sedentary_tdee = 0.0

    if is_stable and cico_tdee is not None:
        # avg_est_active_burn over same 90-day window (all days, including rest=0)
        cutoff_90 = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=90)).strftime("%Y-%m-%d")
        burn_rows = (
            db.query(DailySummary.est_active_burn)
            .filter(DailySummary.date > cutoff_90, DailySummary.date <= date)
            .all()
        )
        avg_burn = mean([r[0] or 0 for r in burn_rows]) if burn_rows else 0
        sedentary_tdee = round(cico_tdee - avg_burn, 1)
        # Sanity: sedentary can't be negative or below 1200
        if sedentary_tdee < 1200:
            sedentary_tdee = round(compute_bmr(weight_lbs) * 1.2, 1) if weight_lbs else 0.0
    elif weight_lbs:
        # Fallback: BMR × 1.2 (sedentary multiplier only)
        sedentary_tdee = round(compute_bmr(weight_lbs) * 1.2, 1)

    return sedentary_tdee, formula_tdee, cico_tdee


# ==========================================
# Main entry point (current-moment estimate for /api/daily/tdee)
# ==========================================

def get_effective_tdee(db: Session) -> TDEEInfo:
    """Compute the best available TDEE estimate (current moment)."""
    latest_weight_row = (
        db.query(DailySummary)
        .filter(DailySummary.weight_lbs > 0)
        .order_by(desc(DailySummary.date))
        .first()
    )
    weight_lbs = latest_weight_row.weight_lbs if latest_weight_row else None

    cutoff_28 = (datetime.now() - timedelta(days=28)).strftime("%Y-%m-%d")
    workout_dates = (
        db.query(Workout.date)
        .filter(Workout.date > cutoff_28)
        .distinct()
        .all()
    )
    workout_days_per_week = len(workout_dates) / 4.0

    formula_tdee = compute_formula_tdee(weight_lbs, workout_days_per_week) if weight_lbs else None
    cico_tdee, n_days, is_stable = compute_cico_tdee_from_db(db)

    if is_stable and cico_tdee is not None:
        confidence = min(1.0, 0.5 + 0.5 * (n_days - MIN_STABLE_DAYS) / 16)
        return TDEEInfo(
            tdee=cico_tdee,
            source='cico',
            formula_tdee=formula_tdee,
            cico_tdee=cico_tdee,
            n_days=n_days,
            is_stable=True,
            confidence=confidence,
        )
    elif weight_lbs is not None and formula_tdee is not None:
        confidence = min(0.5, 0.3 + 0.2 * (n_days / MIN_STABLE_DAYS))
        return TDEEInfo(
            tdee=formula_tdee,
            source='formula',
            formula_tdee=formula_tdee,
            cico_tdee=cico_tdee,
            n_days=n_days,
            is_stable=False,
            confidence=confidence,
        )
    else:
        return TDEEInfo(
            tdee=0,
            source='formula',
            formula_tdee=None,
            cico_tdee=None,
            n_days=0,
            is_stable=False,
            confidence=0.0,
        )
