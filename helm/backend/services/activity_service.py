"""The only creator/linker of Activity rows.

Manual write paths call attach_exercise for every Workout row they create or
re-categorize; the Google sync calls link_google_session after each session
upsert; DELETE/re-attach paths call prune_if_empty. Nothing else writes to the
activities table. None of these functions commit — callers own the transaction
(they flush where an id is needed) — except migrate_activities, the startup
backfill entry point, which owns its transaction."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Activity, Workout, WorkoutSession
from .activity_taxonomy import (
    CANONICAL_ACTIVITIES,
    activity_of,
    google_session_activity,
    is_strength_member,
)
from .cardio_text import parse_cardio_text


def is_canonical_activity(activity: str | None) -> bool:
    """Whether `activity` is a member of the taxonomy's canonical activity set."""
    return activity in CANONICAL_ACTIVITIES


def activity_for_workout(w: Workout) -> str:
    """Canonical activity a manual exercise row belongs to."""
    if is_strength_member(w.exercise, w.category):
        return "strength"
    return activity_of(w.exercise)


def _get_or_create(db: Session, date: str, activity: str) -> Activity:
    act = (db.query(Activity)
           .filter(Activity.date == date, Activity.activity == activity)
           .order_by(Activity.id)
           .first())
    if act is None:
        act = Activity(date=date, activity=activity)
        db.add(act)
        db.flush()          # need act.id for FKs
    return act


def get_or_create_activity(db: Session, date: str, activity: str, label: str | None = None) -> Activity:
    """LLM-declared-split entry point for an ALREADY-VALIDATED canonical activity:
    get-or-create by (date, activity) — coalesces repeat groups — and set label
    when provided. Validation/fallback is the caller's job (see parse commit)."""
    act = _get_or_create(db, date, activity)
    if label:
        act.label = label
    return act


def attach_exercise(db: Session, w: Workout) -> Activity:
    """Get-or-create the date's Activity for a manual exercise row and set its FK.

    Strength members (lifts + gym-warmup walks) share the date's single
    'strength' activity; every other cardio row gets its keyword activity.
    NOTE: only the activities backfill uses this directly — live writers go
    through record_exercise, which absorbs standalone-cardio rows instead."""
    act = _get_or_create(db, w.date, activity_for_workout(w))
    w.activity_id = act.id
    return act


def absorb_exercise(db: Session, act: Activity, exercise: str, reps_sets: str,
                    notes: str = "") -> None:
    """Fold one cardio "exercise" into the activity's own columns (row-less
    cardio invariant, 2026-07-16): parsed laps/distance/duration ADD to any
    existing values (mirrors the retired multi-row sum), notes append, the
    label defaults from the exercise name, and the activity is marked
    finalized — a manual entry is user-asserted by definition."""
    laps, dist, dur = parse_cardio_text(reps_sets)
    if laps is not None:
        act.laps = (act.laps or 0) + laps
    if dist is not None:
        act.distance_m = round((act.distance_m or 0) + dist, 1)
    if dur is not None:
        act.duration_min = round((act.duration_min or 0) + dur, 2)
    if notes:
        act.notes = f"{act.notes}; {notes}" if act.notes else notes
    if not act.label and exercise:
        act.label = exercise
    act.finalized = True


def record_exercise(db: Session, w: Workout) -> Activity:
    """Single entry point for manual writers. Strength members attach as rows
    (unchanged); a standalone-cardio row is ABSORBED into its activity's
    columns and deleted — no standalone-cardio activity ever keeps rows."""
    name = activity_for_workout(w)
    act = _get_or_create(db, w.date, name)
    if name == "strength":
        w.activity_id = act.id
    else:
        absorb_exercise(db, act, w.exercise, w.reps_sets or "", w.notes or "")
        db.delete(w)
        db.flush()
    return act


def prune_if_empty(db: Session, activity_id: int | None) -> None:
    """Delete a manual-only, never-confirmed activity that has no exercise rows.

    Google-linked activities always survive (the session still happened), and
    finalized activities survive too — row-less cardio carries its data in
    columns, so "no rows" no longer implies "empty"."""
    if activity_id is None:
        return
    # Prod sessions run autoflush=False: flush so the count sees pending FK repoints.
    db.flush()
    act = db.query(Activity).filter(Activity.id == activity_id).first()
    if act is None or act.google_session_id is not None or act.finalized:
        return
    if db.query(Workout).filter(Workout.activity_id == act.id).count() == 0:
        db.delete(act)


def _linked_session_ids(db: Session, date: str) -> set[int]:
    return {sid for (sid,) in db.query(Activity.google_session_id)
            .filter(Activity.date == date, Activity.google_session_id.isnot(None)).all()}


def link_google_session(db: Session, s: WorkoutSession) -> Activity | None:
    """Link one synced Google session to its date's Activity — or create one.

    Links are permanent: an already-linked session returns its activity untouched.
    A session flagged as a duplicate of a canonical sibling (see
    google_health_service.dedupe_sessions) gets NO activity — returns None.
    Matching mirrors the retired read-time rules — label-keyword activities
    (stairs) and raw-type sets via google_session_activity, and when several
    unlinked same-date sessions compete for one unlinked activity, the LONGEST
    wins regardless of sync arrival order: a shorter session that arrives first
    steps aside and gets its own Google-only activity."""
    if s.is_duplicate:
        return None
    existing = db.query(Activity).filter(Activity.google_session_id == s.id).first()
    if existing is not None:
        return existing

    act_name = google_session_activity(s.exercise_type_raw, s.exercise_type)
    candidate = (db.query(Activity)
                 .filter(Activity.date == s.date, Activity.activity == act_name,
                         Activity.google_session_id.is_(None))
                 .order_by(Activity.id)
                 .first())

    if candidate is not None:
        # Longest-first: yield the manual activity to a longer unlinked rival.
        linked = _linked_session_ids(db, s.date)
        rivals = [g for g in db.query(WorkoutSession).filter(WorkoutSession.date == s.date).all()
                  if g.id != s.id and g.id not in linked
                  and google_session_activity(g.exercise_type_raw, g.exercise_type) == act_name]
        if any((g.duration_min or 0) > (s.duration_min or 0) for g in rivals):
            candidate = None

    if candidate is None:
        candidate = Activity(date=s.date, activity=act_name)
        db.add(candidate)

    candidate.google_session_id = s.id
    if act_name != "strength":
        candidate.label = s.exercise_type   # strength is always "Strength" at read time
    db.flush()
    return candidate


def needs_activity_backfill(db: Session) -> bool:
    """Whether any workout row or session predates the activities spine."""
    if db.query(Workout).filter(Workout.activity_id.is_(None)).count() > 0:
        return True
    return db.query(WorkoutSession).filter(
        ~WorkoutSession.id.in_(
            db.query(Activity.google_session_id).filter(
                Activity.google_session_id.isnot(None)))).count() > 0


def migrate_activities(db: Session) -> None:
    """Backfill of the activities spine from flat workouts + sessions.

    Reuses the exact live write-path functions (attach_exercise /
    link_google_session), so the persisted assignment matches what the retired
    read-time matcher computed. Idempotent: attach only touches rows with a
    NULL FK and reuses existing (date, activity) rows; linking skips
    already-linked sessions. Commits once at the end."""
    rows = (db.query(Workout).filter(Workout.activity_id.is_(None))
            .order_by(Workout.date, Workout.id).all())
    for w in rows:
        attach_exercise(db, w)

    sessions = (db.query(WorkoutSession)
                .order_by(WorkoutSession.date,
                          WorkoutSession.duration_min.desc().nullslast())
                .all())
    linked = 0
    for s in sessions:
        link_google_session(db, s)
        linked += 1

    db.commit()

    orphans = db.query(Workout).filter(Workout.activity_id.is_(None)).count()
    total = db.query(Activity).count()
    print(f"[MIGRATE] activities backfill: {len(rows)} rows attached, "
          f"{linked} sessions passed through linker, {total} activities, "
          f"{orphans} orphan workouts", flush=True)
    if orphans:
        print("[MIGRATE] WARNING: orphan workouts remain with NULL activity_id", flush=True)


def migrate_cardio_metadata(db: Session) -> None:
    """One-time absorb of legacy cardio carrier rows into activity columns
    (row-less cardio, 2026-07-16). Idempotent — converges to zero rows
    attached to standalone-cardio activities. Owns its transaction."""
    rows = (db.query(Workout).join(Activity, Workout.activity_id == Activity.id)
            .filter(Activity.activity != "strength")
            .order_by(Workout.date, Workout.id).all())
    if not rows:
        return
    acts = {a.id: a for a in db.query(Activity).filter(
        Activity.id.in_({w.activity_id for w in rows})).all()}
    for w in rows:
        absorb_exercise(db, acts[w.activity_id], w.exercise, w.reps_sets or "", w.notes or "")
        db.delete(w)
    db.commit()
    print(f"[MIGRATE] row-less cardio: absorbed {len(rows)} carrier row(s) "
          f"into {len(acts)} activities", flush=True)
