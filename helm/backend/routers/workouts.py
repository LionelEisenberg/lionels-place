"""
Workouts CRUD router — secondary/correction interface.
Provides editable table operations and progressive overload history.
"""

import json
from datetime import date
from typing import Iterable, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from ..database import get_db
from ..models import Workout, DailySummary, RunDetail, Activity, WorkoutSession
from ..schemas import (
    WorkoutCreate, WorkoutUpdate, WorkoutResponse, ExerciseProgressionResponse,
    ProgressionSession, DayLogResponse, SessionHistoryRow, RunDetailResponse,
    PendingGoogleSession, FinalizeActivityRequest, ActivityUpdate,
)
from ..services import workout_log_service as wls
from ..services import activity_service
from ..services.workout_log_service import assemble_log

router = APIRouter(prefix="/api/workouts", tags=["workouts"])


@router.get("/log", response_model=list[DayLogResponse])
async def workout_log(start: str = "", end: str = "", db: Session = Depends(get_db)):
    """Per-day activities: every stored activity appears — manual exercises grouped
    by activity, Google-linked activities carry session metrics."""
    return wls.assemble_log(db, start or "0000-00-00", end or "9999-99-99")


@router.get("/pending-google", response_model=list[PendingGoogleSession])
async def pending_google(today: str = "", db: Session = Depends(get_db)):
    """Watch-detected workouts not yet in the log, within the last 14 days — the
    Workout Log 'lock in' banner source.

    Google stores some workouts as MULTIPLE sessions (the same activity under two type
    enums, or phone + watch both recording), so one real workout can span several
    activities sharing a date + type + start-minute. We work at the *workout* grain,
    not the activity grain: cluster by (date, activity, start-minute), drop a cluster
    if ANY copy is already logged (has manual rows) or finalized, and surface one
    representative (the longest session) per remaining cluster. The generic `cardio`
    bucket (ambient walks) is excluded entirely."""
    from datetime import date as _date, timedelta, datetime
    from collections import defaultdict
    from ..services.burn import credited_burn
    import zoneinfo
    anchor = today or datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")
    start = (_date.fromisoformat(anchor) - timedelta(days=14)).isoformat()

    # All watch-detected workout activities in window (ANY state — we need the logged /
    # finalized copies too, to recognize a cluster as already handled).
    acts = (db.query(Activity)
            .filter(Activity.google_session_id.isnot(None), Activity.activity != "cardio",
                    Activity.date >= start, Activity.date <= anchor).all())
    if not acts:
        return []
    with_rows = {aid for (aid,) in db.query(Workout.activity_id)
                 .filter(Workout.activity_id.in_([a.id for a in acts])).distinct().all()}
    sess = {s.id: s for s in db.query(WorkoutSession)
            .filter(WorkoutSession.id.in_([a.google_session_id for a in acts])).all()}

    clusters: dict[tuple, list] = defaultdict(list)
    for a in acts:
        g = sess.get(a.google_session_id)
        start_min = g.start_time[11:16] if g and g.start_time else ""
        clusters[(a.date, a.activity, start_min)].append((a, g))

    out = []
    for members in clusters.values():
        if any(a.id in with_rows or a.finalized for a, _g in members):
            continue                     # this real workout is already logged / locked in
        a, g = max(members, key=lambda m: (m[1].duration_min or 0) if m[1] else 0)
        out.append(PendingGoogleSession(
            activity_id=a.id, date=a.date, activity=a.activity,
            label=a.label or a.activity.title(),
            start=(g.start_time[11:16] if g and g.start_time else None),
            end=(g.end_time[11:16] if g and g.end_time else None),
            duration_min=(g.duration_min if g else None),
            distance_m=(g.distance_m if g else None),
            calories_kcal=(g.calories_kcal if g else None),
            credited_kcal=(credited_burn(g.calories_kcal) if g else None),
            avg_hr=(g.avg_hr if g else None),
            pace_s_per_km=(g.avg_pace_s_per_km if g else None),
            elevation_gain_m=(g.elevation_gain_m if g else None),
            avg_cadence_spm=(g.avg_cadence_spm if g else None)))
    out.sort(key=lambda p: (p.date, p.start or ""), reverse=True)
    return out


@router.post("/activities/{activity_id}/finalize", response_model=DayLogResponse)
async def finalize_activity(activity_id: int, req: FinalizeActivityRequest,
                            db: Session = Depends(get_db)):
    """Lock a watch-detected activity into the log. Attaches any supplied exercises to
    the EXISTING activity (no new activity), sets finalized, and re-derives the day's
    est_active_burn = sum of its locked-in workouts' credited Google burn."""
    from ..models import Activity
    from ..services.daily_calculator import recompute_active_burn
    from fastapi import HTTPException

    act = db.query(Activity).filter(Activity.id == activity_id).first()
    if act is None:
        raise HTTPException(status_code=404, detail="activity not found")

    # Idempotent: finalize locks in once. A repeat call must not append duplicate
    # rows (the UI edits an already-locked-in activity through the normal edit flow).
    if act.finalized:
        days = assemble_log(db, act.date, act.date)
        return days[0] if days else DayLogResponse(date=act.date, sessions=[])

    for ex in req.exercises:
        if act.activity != "strength":
            # Row-less cardio: detail folds into the activity's own columns.
            activity_service.absorb_exercise(db, act, ex.exercise, ex.reps_sets or "", ex.notes or "")
        else:
            db.add(Workout(date=act.date, category=ex.category, equipment_type=ex.equipment_type,
                           exercise=ex.exercise, weight_lbs=ex.weight_lbs or "",
                           reps_sets=ex.reps_sets or "", notes=ex.notes or "",
                           targeted_muscle_group=ex.targeted_muscle_group, activity_id=act.id))
    act.finalized = True
    db.commit()

    # Locking a workout in re-derives the whole day's burn from its finalized workouts
    # (also clears any legacy MET residue sitting on that day).
    recompute_active_burn(act.date, db)

    days = assemble_log(db, act.date, act.date)
    return days[0] if days else DayLogResponse(date=act.date, sessions=[])


@router.put("/activities/{activity_id}", response_model=DayLogResponse)
async def update_activity(activity_id: int, req: ActivityUpdate, db: Session = Depends(get_db)):
    """Structured cardio edit: set the activity's own metadata columns.
    Returns the refreshed day so the frontend swaps it in place."""
    act = db.query(Activity).filter(Activity.id == activity_id).first()
    if act is None:
        raise HTTPException(status_code=404, detail="Activity not found")
    for key, value in req.model_dump(exclude_unset=True).items():
        setattr(act, key, value)
    db.commit()
    days = assemble_log(db, act.date, act.date)
    return days[0] if days else DayLogResponse(date=act.date, sessions=[])


@router.delete("/activities/{activity_id}")
async def delete_activity(activity_id: int, db: Session = Depends(get_db)):
    """Delete a manual-only cardio activity (row-less cardio has no rows whose
    deletion could prune it). Watch-linked activities and strength stay."""
    act = db.query(Activity).filter(Activity.id == activity_id).first()
    if act is None:
        raise HTTPException(status_code=404, detail="Activity not found")
    if act.google_session_id is not None:
        raise HTTPException(status_code=409, detail="Activity is linked to a watch session")
    if act.activity == "strength":
        raise HTTPException(status_code=409, detail="Delete the strength activity's exercise rows instead")
    date = act.date
    db.delete(act)
    db.commit()
    from ..services.daily_calculator import get_or_create_daily
    get_or_create_daily(date, db)
    return {"status": "deleted", "id": activity_id}


@router.get("/session-history", response_model=list[SessionHistoryRow])
async def workout_session_history(
    activity: str,
    limit: int = Query(default=20, le=2000),
    db: Session = Depends(get_db),
):
    """Past activities of a type (newest first), for the session panel."""
    return wls.session_history(db, activity, limit)


@router.get("/run-detail/{session_id}", response_model=RunDetailResponse)
async def run_detail(session_id: int, db: Session = Depends(get_db)):
    """TCX-derived route polyline + per-km splits for one Google run session.
    404 until the sync's TCX pass has produced a run_details row."""
    rd = db.query(RunDetail).filter(RunDetail.workout_session_id == session_id).first()
    if rd is None:
        raise HTTPException(status_code=404, detail="No run detail for that session")
    return RunDetailResponse(
        session_id=session_id,
        route=json.loads(rd.route) if rd.route else None,
        splits=json.loads(rd.splits) if rd.splits else None,
        route_status=rd.route_status,
    )


@router.get("", response_model=list[WorkoutResponse])
async def list_workouts(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    muscle_group: Optional[str] = None,
    exercise: Optional[str] = None,
    limit: int = Query(default=100, le=1000),
    db: Session = Depends(get_db),
):
    """List workouts, filtered by date range, muscle group, or exercise."""
    query = db.query(Workout)
    if start_date:
        query = query.filter(Workout.date >= start_date)
    if end_date:
        query = query.filter(Workout.date <= end_date)
    if muscle_group:
        query = query.filter(Workout.targeted_muscle_group == muscle_group)
    if exercise:
        query = query.filter(Workout.exercise.ilike(f"%{exercise}%"))
    return query.order_by(desc(Workout.date), desc(Workout.id)).limit(limit).all()


def _resolve_target_activity(db: Session, workout_in: WorkoutCreate) -> Activity | None:
    """Explicit attach target for a created row (per-activity edit flow).

    None when the payload doesn't declare one — caller falls back to the
    keyword heuristic. Declared targets must exist and share the row's date."""
    if workout_in.activity_id is None:
        return None
    act = db.query(Activity).filter(Activity.id == workout_in.activity_id).first()
    if act is None:
        raise HTTPException(status_code=404, detail="Activity not found")
    if act.date != workout_in.date:
        raise HTTPException(status_code=400, detail="Row date does not match the activity's date")
    return act


_ROW_FIELDS = ("id", "date", "category", "equipment_type", "exercise",
               "weight_lbs", "reps_sets", "notes", "targeted_muscle_group")


def _row_snapshot(w: Workout) -> dict:
    """Response payload captured BEFORE commit — an absorbed cardio row is
    deleted, so the ORM instance can't be refreshed afterwards."""
    return {f: getattr(w, f) for f in _ROW_FIELDS}


def _store_row(db: Session, workout: Workout, target: Activity | None) -> None:
    """Attach or absorb one flushed row (row-less cardio invariant): strength
    targets keep the row; cardio targets absorb it into activity columns."""
    if target is not None:
        if target.activity == "strength":
            workout.activity_id = target.id
        else:
            activity_service.absorb_exercise(
                db, target, workout.exercise, workout.reps_sets or "", workout.notes or "")
            db.delete(workout)
    else:
        activity_service.record_exercise(db, workout)


@router.post("", response_model=WorkoutResponse)
async def create_workout(workout_in: WorkoutCreate, db: Session = Depends(get_db)):
    """Create a new workout entry. Strength rows persist; cardio-destined rows
    are absorbed into their activity's columns (row-less cardio invariant)."""
    target = _resolve_target_activity(db, workout_in)
    workout = Workout(**workout_in.model_dump(exclude={"activity_id"}))
    db.add(workout)
    db.flush()
    resp = _row_snapshot(workout)
    _store_row(db, workout, target)
    db.commit()

    # Update the daily summary's workout_type based on all exercises for the day
    from ..services.daily_calculator import get_or_create_daily
    get_or_create_daily(workout_in.date, db)

    return resp


@router.put("/{workout_id}", response_model=WorkoutResponse)
async def update_workout(workout_id: int, workout_in: WorkoutUpdate, db: Session = Depends(get_db)):
    """Update an existing workout (inline edit)."""
    workout = db.query(Workout).filter(Workout.id == workout_id).first()
    if not workout:
        raise HTTPException(status_code=404, detail="Workout not found")

    update_data = workout_in.model_dump(exclude_unset=True)
    old_activity_id = workout.activity_id
    old_date = workout.date
    reclassified = any(
        key in update_data and update_data[key] != getattr(workout, key)
        for key in ("exercise", "category", "date")
    )
    for key, value in update_data.items():
        setattr(workout, key, value)

    resp = _row_snapshot(workout)
    new_date = workout.date
    if reclassified:
        # A strength row renamed into cardio gets absorbed (row deleted).
        activity_service.record_exercise(db, workout)
        activity_service.prune_if_empty(db, old_activity_id)

    db.commit()

    # Rider fix: PUT now re-derives the day's sticky workout_type (it used to skip it).
    from ..services.daily_calculator import get_or_create_daily
    get_or_create_daily(new_date, db)
    if old_date != new_date:
        get_or_create_daily(old_date, db)
    return resp


@router.delete("/{workout_id}")
async def delete_workout(workout_id: int, db: Session = Depends(get_db)):
    """Delete a workout entry."""
    workout = db.query(Workout).filter(Workout.id == workout_id).first()
    if not workout:
        raise HTTPException(status_code=404, detail="Workout not found")

    old_activity_id = workout.activity_id
    db.delete(workout)
    activity_service.prune_if_empty(db, old_activity_id)
    db.commit()
    return {"status": "deleted", "id": workout_id}


def _parse_max_weight(weight_str: str) -> float:
    """Parse a per-set weight string like '30, 35, 35' into the max numeric value.
    Returns 0.0 for non-numeric strings (e.g. 'BW', 'N/A').
    Correctly handles negative weights (assisted exercises like '-115').
    """
    if not weight_str:
        return 0.0
    max_val = None
    for token in weight_str.split(','):
        try:
            val = float(token.strip())
            if max_val is None or val > max_val:
                max_val = val
        except ValueError:
            pass
    return max_val if max_val is not None else 0.0


def _nearest_bodyweight_map(
    weigh_ins: list[tuple[str, float]],
    target_dates: Iterable[str],
) -> dict[str, float]:
    """Map each target date to the bodyweight measured closest to it in time.

    ``weigh_ins`` is a list of ``(YYYY-MM-DD, weight_lbs)`` for days with a real
    weigh-in. For each target date we pick the weigh-in with the smallest
    absolute day difference; ties resolve to the earlier weigh-in. This lets
    assisted lifts (negative weights) recover an effective weight on days
    without a same-day weigh-in instead of falling back to the raw assist level.

    Unparseable dates are skipped, and empty ``weigh_ins`` yields an empty map
    (callers then leave ``body_weight`` as ``None`` — nothing to resolve to).
    """
    parsed: list[tuple[date, float]] = []
    for d, weight in weigh_ins:
        try:
            parsed.append((date.fromisoformat(d), weight))
        except (ValueError, TypeError):
            continue
    if not parsed:
        return {}

    resolved: dict[str, float] = {}
    for target in target_dates:
        try:
            target_day = date.fromisoformat(target)
        except (ValueError, TypeError):
            continue
        _, weight = min(parsed, key=lambda pw: (abs((pw[0] - target_day).days), pw[0]))
        resolved[target] = weight
    return resolved


def _is_cardio_row(row: Workout) -> bool:
    """Whether a workout row is a cardio entry (no real load).

    Mirrors the frontend `isCardioEntry`: an entry counts as cardio when its
    equipment type is "None" or it carries no real weight ("", "-", "—", "0").
    Cardio progression (e.g. swimming) is returned in full rather than capped,
    so its chart can span the entire logged date range.
    """
    if (row.equipment_type or "None") == "None":
        return True
    return (row.weight_lbs or "").strip() in ("", "-", "—", "0")


@router.get("/exercise-search", response_model=list[str])
async def exercise_search(
    q: str = Query(default=""),
    limit: int = Query(default=10, le=30),
    db: Session = Depends(get_db),
):
    """Autocomplete: return distinct exercise names matching query string."""
    query = db.query(Workout.exercise).distinct()
    if q:
        query = query.filter(Workout.exercise.ilike(f"%{q}%"))
    results = query.order_by(Workout.exercise).limit(limit).all()
    return [r[0] for r in results]


@router.get("/progression/{exercise_name}", response_model=list[ExerciseProgressionResponse])
async def exercise_progression(
    exercise_name: str,
    limit: int = Query(default=30, le=100),
    db: Session = Depends(get_db),
):
    """
    Get progression history for an exercise, grouped by equipment type.

    Strength variants are capped at the most recent `limit` sessions for a tidy
    recent-progress view. Cardio variants (e.g. swimming) are returned in full
    so their chart can span the entire logged date range.
    """
    rows = (
        db.query(Workout)
        .filter(Workout.exercise.ilike(exercise_name))
        .order_by(desc(Workout.date), desc(Workout.id))
        .all()
    )

    groups: dict[str, list[Workout]] = {}
    for row in rows:
        key = row.equipment_type or "None"
        bucket = groups.setdefault(key, [])
        # Cardio is never capped; strength lifts keep only the most recent `limit`.
        if _is_cardio_row(row) or len(bucket) < limit:
            bucket.append(row)

    # Resolve each session's bodyweight to the weigh-in closest in time. Days
    # without a same-day weigh-in fall back to the nearest one so assisted lifts
    # still get an effective weight rather than showing the raw assist level.
    all_dates = {r.date for wl in groups.values() for r in wl}
    weigh_ins = db.query(DailySummary.date, DailySummary.weight_lbs).filter(
        DailySummary.weight_lbs.isnot(None),
        DailySummary.weight_lbs > 0,
    ).all()
    bw_map = _nearest_bodyweight_map(
        [(r.date, r.weight_lbs) for r in weigh_ins], all_dates
    )

    return [
        ExerciseProgressionResponse(
            exercise=workout_rows[0].exercise,
            equipment_type=equip_type,
            sessions=[
                ProgressionSession(
                    date=r.date,
                    weight_lbs=r.weight_lbs or "",
                    reps_sets=r.reps_sets or "",
                    notes=r.notes or "",
                    max_weight=_parse_max_weight(r.weight_lbs or ""),
                    body_weight=bw_map.get(r.date),
                )
                for r in workout_rows
            ],
        )
        for equip_type, workout_rows in groups.items()
    ]


@router.get("/history/{exercise_name}", response_model=list[WorkoutResponse])
async def exercise_history(
    exercise_name: str,
    limit: int = Query(default=20, le=100),
    db: Session = Depends(get_db),
):
    """
    Get the most recent entries for a specific exercise.
    Used for progressive overload — shows weight/rep progression.
    """
    return (
        db.query(Workout)
        .filter(Workout.exercise.ilike(exercise_name))
        .order_by(desc(Workout.date), desc(Workout.id))
        .limit(limit)
        .all()
    )


@router.post("/bulk")
async def bulk_import_workouts(workouts: list[WorkoutCreate], db: Session = Depends(get_db)):
    """Batch import workouts (e.g., from CSV paste)."""
    dates = set()
    for workout_in in workouts:
        target = _resolve_target_activity(db, workout_in)
        workout = Workout(**workout_in.model_dump(exclude={"activity_id"}))
        db.add(workout)
        db.flush()
        _store_row(db, workout, target)
        dates.add(workout_in.date)
    db.commit()

    # Rider fix: bulk now re-derives each touched day's sticky workout_type.
    from ..services.daily_calculator import get_or_create_daily
    for d in sorted(dates):
        get_or_create_daily(d, db)
    return {"status": "imported", "count": len(workouts)}
