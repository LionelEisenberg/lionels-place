"""Read-time assembly of the Workout Log — a pure join over the activities spine.

A day exists iff it has >= 1 manually-logged OR finalized (locked-in) activity.
Google-only activities (linked session, zero exercise rows, not finalized) are
stored and linked by the write side but filtered out of the log view — user
decision 2026-07-14, deliberately reversible here at the read layer. A
manually-logged activity that ALSO has a Google session keeps its metrics
(route/splits/pace) — that is not "Google-only". session_history follows the
SAME visibility rule (user decision 2026-07-15): a never-locked-in watch
session doesn't count in the progression charts either.

Each activity joins its linked Google WorkoutSession (metrics) and its Workout
rows (exercises); nothing is matched or promoted at read time —
services/activity_service.py decided all links at write time, permanently.
Day-level aggregates (sets/volume/cardio-ness) are computed server-side so the
frontend renders instead of derives.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models import Activity, Workout, WorkoutSession, DailySummary, IntradayHeartRate, RunDetail
from . import google_health_service as ghs


# ----------------------------------------------------------------- aggregates
_NUM_PREFIX = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")


def _parse_float_prefix(tok: str) -> float | None:
    """JS-parseFloat semantics: leading numeric prefix, else None.

    Covers signs, bare/trailing decimals and exponents ("+45", ".5", "5.", "5e2");
    deliberately excludes Infinity/NaN, which parseFloat accepts but no real log
    token uses. Keeps server aggregates identical to the deployed client's math
    for tokens like "8 (F)", "15s", "4 x 8", "30 lbs" (prod audit: 155 such)."""
    m = _NUM_PREFIX.match(tok.strip())
    return float(m.group(0)) if m else None


def _parse_weights(weight_str: str) -> list[float]:
    out = []
    for tok in (weight_str or "").split(","):
        v = _parse_float_prefix(tok)
        if v is not None:
            out.append(v)
    return out


def _parse_reps(reps_str: str) -> list[float]:
    out = []
    for tok in (reps_str or "").split(","):
        tok = re.sub(r"\s*\(Fail\)", "", tok, flags=re.IGNORECASE)
        v = _parse_float_prefix(tok)
        if v is not None:
            out.append(v)
    return out


def count_sets(reps_str: str) -> int:
    """Number of comma-separated set tokens (mirrors the frontend's countSets)."""
    return len([t for t in (reps_str or "").split(",") if t.strip()])


def compute_volume(weight_str: str, reps_str: str) -> float:
    """Sum of |weight| x reps per set; a single weight applies to all sets, a short
    weight list repeats its last value (mirrors the frontend's computeVolume)."""
    weights = _parse_weights(weight_str)
    reps = _parse_reps(reps_str)
    if not weights or not reps:
        return 0.0
    vol = 0.0
    for i, r in enumerate(reps):
        w = weights[0] if len(weights) == 1 else (weights[i] if i < len(weights) else weights[-1])
        vol += abs(w) * r
    return vol


def _merged_distance(act: Activity, g: WorkoutSession | None) -> float | None:
    """Activity-column distance merged with the linked session's: runs treat
    Google as source of truth; other cardio keeps the manual value and lets
    Google fill a null. Strength never carries distance."""
    if act.activity == "strength":
        return None
    distance_m = act.distance_m
    if g is not None and g.distance_m is not None:
        if act.activity == "run" or distance_m is None:
            distance_m = g.distance_m
    return distance_m


def _activity_dict(act: Activity, g: WorkoutSession | None, exercises: list[Workout]) -> dict:
    category = "strength" if act.activity == "strength" else "cardio"
    pace = None
    if g is not None:
        pace = g.avg_pace_s_per_km
        if pace is None and g.distance_m and g.duration_min:
            pace = round((g.duration_min * 60.0) / (g.distance_m / 1000.0), 1)
    return {
        "id": act.id,
        "label": act.label or act.activity.title(),
        "category": category,
        "activity": act.activity,
        "google_session_id": (g.id if g else None),
        "start": (g.start_time[11:16] if g and g.start_time else None),
        "end": (g.end_time[11:16] if g and g.end_time else None),
        "duration_min": (g.duration_min if g and g.duration_min is not None else act.duration_min),
        "avg_hr": (g.avg_hr if g else None),
        "laps": act.laps,
        "distance_m": _merged_distance(act, g),
        "pace_s_per_km": pace,
        "calories_kcal": (g.calories_kcal if g else None),
        "credited_kcal": (ghs.credited_burn(g.calories_kcal) if g else None),  # 70% — what feeds est_active_burn
        "elevation_gain_m": (g.elevation_gain_m if g else None),
        "avg_cadence_spm": (g.avg_cadence_spm if g else None),
        "has_route": False,                # patched in assemble_log
        "notes": act.notes,
        "exercises": exercises,
    }


def assemble_log(db: Session, start: str, end: str) -> list[dict]:
    """Per-day activities over [start, end], newest day first. Pure join."""
    acts = (db.query(Activity).filter(Activity.date >= start, Activity.date <= end)
            .order_by(Activity.id).all())
    if not acts:
        return []
    g_by_id = {s.id: s for s in db.query(WorkoutSession).filter(
        WorkoutSession.date >= start, WorkoutSession.date <= end).all()}
    w_by_act: dict[int, list[Workout]] = defaultdict(list)
    for w in db.query(Workout).filter(Workout.date >= start, Workout.date <= end).all():
        if w.activity_id is not None:
            w_by_act[w.activity_id].append(w)
    daily = {d.date: d for d in db.query(DailySummary).filter(
        DailySummary.date >= start, DailySummary.date <= end).all()}
    # Date-scoped: only run details whose session falls inside the window
    # (fixes the old unbounded route_ids scan).
    route_ids = {sid for (sid,) in
                 db.query(RunDetail.workout_session_id)
                 .join(WorkoutSession, RunDetail.workout_session_id == WorkoutSession.id)
                 .filter(WorkoutSession.date >= start, WorkoutSession.date <= end,
                         RunDetail.route.isnot(None)).all()}

    # Visible iff it has manual exercise rows OR the user finalized (locked in) a
    # watch-detected session (a run finalized with zero rows still shows its metrics).
    visible = [a for a in acts if w_by_act.get(a.id) or a.finalized]
    if not visible:
        return []

    by_date: dict[str, list[Activity]] = defaultdict(list)
    for a in visible:
        by_date[a.date].append(a)

    out = []
    for date in sorted(by_date, reverse=True):
        day_acts = by_date[date]
        sessions = [_activity_dict(a, g_by_id.get(a.google_session_id), w_by_act.get(a.id, []))
                    for a in day_acts]
        for s in sessions:
            s["has_route"] = s["google_session_id"] in route_ids
        sessions.sort(key=lambda s: (s["start"] is None, s["start"] or ""))

        rows = [w for a in day_acts for w in w_by_act.get(a.id, [])]
        is_cardio = all(a.activity != "strength" for a in day_acts)
        day_type = daily[date].workout_type if date in daily else None
        if day_type is None and is_cardio:
            day_type = "Cardio"           # activities-derived fallback (e.g. run-only day)
        out.append({
            "date": date,
            "day_type": day_type,
            "exercise_count": len(rows),
            "total_sets": sum(count_sets(w.reps_sets) for w in rows),
            "total_volume": 0.0 if is_cardio else sum(
                compute_volume(w.weight_lbs, w.reps_sets) for w in rows),
            "is_cardio": is_cardio,
            "sessions": sessions,
        })
    return out


# ----------------------------------------------------------------- session history
def _max_hr_for(db: Session, s: WorkoutSession) -> int | None:
    if not (s.start_time and s.end_time):
        return None
    row = db.query(IntradayHeartRate).filter(IntradayHeartRate.date == s.date).first()
    if not row:
        return None
    pts = json.loads(row.samples).get("points", [])
    sliced = ghs.slice_hr_window(pts, s.start_time[11:16], s.end_time[11:16])
    return sliced["max_bpm"] if sliced else None


def _curve_max(db: Session, s: WorkoutSession | None) -> int | None:
    """Max HR from the cached session curve — the same source the panel's HR curve uses,
    so the two always agree. Falls back to the daily-slice only when no cache exists."""
    if s is None:
        return None
    if s.hr_curve:
        try:
            mx = json.loads(s.hr_curve).get("max_bpm")
            if mx is not None:
                return mx
        except Exception:
            pass
    return _max_hr_for(db, s)


def session_history(db: Session, activity: str, limit: int = 20) -> list[dict]:
    """Past sessions of an activity (newest first) for the panel.

    Reads the activities spine: Google metrics when linked, manual
    laps/distance/duration from the activity's own columns (row-less cardio).
    Strength is Google-driven only (manual-only strength days carry no metrics
    and are skipped). _curve_max runs only for the `limit` returned rows."""
    # Same visibility rule as the log: manually-logged rows or locked-in.
    has_rows = db.query(Workout.id).filter(Workout.activity_id == Activity.id).exists()
    q = (db.query(Activity)
         .filter(Activity.activity == activity)
         .filter(or_(Activity.finalized.is_(True), has_rows))
         .order_by(Activity.date.desc(), Activity.id.desc()))
    if activity == "strength":
        q = q.filter(Activity.google_session_id.isnot(None))
    acts = q.limit(limit).all()
    if not acts:
        return []

    g_ids = [a.google_session_id for a in acts if a.google_session_id is not None]
    g_by_id = ({s.id: s for s in db.query(WorkoutSession)
                .filter(WorkoutSession.id.in_(g_ids)).all()} if g_ids else {})

    out = []
    for a in acts:
        g = g_by_id.get(a.google_session_id)
        pace = None
        if activity == "run" and g is not None:
            pace = g.avg_pace_s_per_km
            if pace is None and g.distance_m and g.duration_min:
                pace = round((g.duration_min * 60.0) / (g.distance_m / 1000.0), 1)
        out.append({
            "date": a.date,
            "duration_min": (g.duration_min if g and g.duration_min is not None else a.duration_min),
            "avg_hr": (g.avg_hr if g else None),
            "max_hr": _curve_max(db, g),
            "laps": a.laps,
            "distance_m": _merged_distance(a, g),
            "pace_s_per_km": pace,
            "notes": a.notes,
        })
    return out
