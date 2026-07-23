"""
Weight projection — linear regression over recent DailySummary.weight_lbs values.

Lifted from routers/goals.py so it survives the deletion of the Goals concept;
now used by the Phases page to project target_weight_lbs.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from ..models import DailySummary


@dataclass
class WeightProjection:
    target_value: float
    current_value: Optional[float]
    starting_value: Optional[float]    # weight on/after phase start_date, if provided
    projected_date: Optional[str]      # ISO YYYY-MM-DD
    pace_per_week: Optional[float]     # lbs/week (negative = losing)
    days_remaining: Optional[int]


def _linear_regression(pts: list[tuple[float, float]]) -> tuple[float, float]:
    """Return (slope, intercept) from (x, y) points."""
    n = len(pts)
    if n < 2:
        return 0.0, 0.0
    sum_x = sum(p[0] for p in pts)
    sum_y = sum(p[1] for p in pts)
    sum_xy = sum(p[0] * p[1] for p in pts)
    sum_x2 = sum(p[0] * p[0] for p in pts)
    denom = n * sum_x2 - sum_x * sum_x
    if denom == 0:
        return 0.0, sum_y / n
    slope = (n * sum_xy - sum_x * sum_y) / denom
    intercept = (sum_y - slope * sum_x) / n
    return slope, intercept


def _starting_weight_for_phase(
    db: Session, phase_start_date: str,
) -> Optional[float]:
    """Earliest DailySummary.weight_lbs on or after `phase_start_date`."""
    row = (
        db.query(DailySummary)
        .filter(
            DailySummary.date >= phase_start_date,
            DailySummary.weight_lbs.isnot(None),
            DailySummary.weight_lbs > 0,
        )
        .order_by(DailySummary.date.asc())
        .first()
    )
    return row.weight_lbs if row else None


def project_weight_to_target(
    target_lbs: float,
    db: Session,
    window_days: Optional[int] = 60,
    phase_start_date: Optional[str] = None,
) -> WeightProjection:
    """Project the date when weight will hit `target_lbs` based on recent data.

    `window_days` is the trailing window (in days) of weight data to regress on;
    pass ``None`` to regress over all logged history (the "Overall" trend).

    If `phase_start_date` is provided, also resolves `starting_value` from the
    earliest weight on/after that date.
    """
    today = datetime.utcnow().date()

    query = db.query(DailySummary).filter(
        DailySummary.weight_lbs.isnot(None),
        DailySummary.weight_lbs > 0,
    )
    if window_days is not None:
        cutoff = (today - timedelta(days=window_days)).isoformat()
        query = query.filter(DailySummary.date >= cutoff)
    rows = query.order_by(DailySummary.date.asc()).all()

    current_value = rows[-1].weight_lbs if rows else None
    starting_value = (
        _starting_weight_for_phase(db, phase_start_date)
        if phase_start_date else None
    )

    if len(rows) < 7:
        return WeightProjection(
            target_value=target_lbs,
            current_value=current_value,
            starting_value=starting_value,
            projected_date=None,
            pace_per_week=None,
            days_remaining=None,
        )

    t0 = datetime.strptime(rows[0].date, "%Y-%m-%d").date()
    pts = [
        ((datetime.strptime(r.date, "%Y-%m-%d").date() - t0).days, r.weight_lbs)
        for r in rows
    ]
    slope, intercept = _linear_regression(pts)

    pace_per_week = round(slope * 7, 2)

    projected_date = None
    days_remaining = None
    if slope != 0 and current_value is not None:
        today_x = (today - t0).days
        days_to_goal = (target_lbs - (intercept + slope * today_x)) / slope
        if days_to_goal > 0:
            proj = today + timedelta(days=int(days_to_goal))
            projected_date = proj.isoformat()
            days_remaining = int(days_to_goal)

    return WeightProjection(
        target_value=target_lbs,
        current_value=current_value,
        starting_value=starting_value,
        projected_date=projected_date,
        pace_per_week=pace_per_week,
        days_remaining=days_remaining,
    )
