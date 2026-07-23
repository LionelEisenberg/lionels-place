"""One-time backfill: flat workouts + sessions -> activities, via the live write-path fns."""
from backend.models import Activity, Workout, WorkoutSession
from backend.services import activity_service as acts


def _w(ex, cat, date, reps=""):
    return Workout(date=date, category=cat, equipment_type="", exercise=ex,
                   weight_lbs="", reps_sets=reps, notes="", targeted_muscle_group="")


def _gs(date, raw, label, dur, start="16:00", google_id=None):
    return WorkoutSession(
        google_id=google_id, date=date, exercise_type=label, exercise_type_raw=raw,
        category="cardio", start_time=f"{date}T{start}:00", end_time=f"{date}T{start}:59",
        duration_min=dur, source="google")


def _seed_flat(db):
    db.add_all([
        # Day 1: lifts + warmup walk + swim, Google lift + Google swim + stair session
        _w("Bench Press", "Upper Body", "2026-06-17"),
        _w("Backwards Walking", "Cardio", "2026-06-17"),
        _w("Pool Swim", "Cardio", "2026-06-17", reps="30 laps"),
        _w("Stair Master", "Cardio", "2026-06-17"),
        _gs("2026-06-17", "STRENGTH_TRAINING", "Strength Training", 47.0, "14:00", "m1"),
        _gs("2026-06-17", "SWIMMING_POOL", "Pool swim", 21.0, "16:00", "m2"),
        _gs("2026-06-17", "WORKOUT", "Stair climber", 10.5, "15:00", "m3"),
        # Day 2: Google-only run
        _gs("2026-07-10", "RUNNING", "Run", 28.7, "18:04", "m4"),
        # Day 3: manual-only strength
        _w("Squat", "Lower Body", "2026-07-11"),
    ])
    db.commit()


def test_migration_attaches_everything(db):
    _seed_flat(db)
    acts.migrate_activities(db)

    assert db.query(Workout).filter(Workout.activity_id.is_(None)).count() == 0

    d1 = {a.activity: a for a in db.query(Activity).filter(Activity.date == "2026-06-17")}
    assert set(d1) == {"strength", "swim", "stairs"}
    # Strength holds the lift + the warmup walk, linked to the 47-min session.
    strength_rows = db.query(Workout).filter(Workout.activity_id == d1["strength"].id).all()
    assert {w.exercise for w in strength_rows} == {"Bench Press", "Backwards Walking"}
    assert d1["strength"].google_session_id is not None
    # Stair session linked by label, never to strength.
    stair_sess = db.query(WorkoutSession).filter(WorkoutSession.google_id == "m3").one()
    assert d1["stairs"].google_session_id == stair_sess.id
    assert d1["swim"].google_session_id is not None and d1["swim"].label == "Pool swim"

    run = db.query(Activity).filter(Activity.date == "2026-07-10").one()
    assert run.activity == "run" and run.google_session_id is not None

    manual = db.query(Activity).filter(Activity.date == "2026-07-11").one()
    assert manual.activity == "strength" and manual.google_session_id is None


def test_migration_longest_first_per_date(db):
    # Two strength-typed sessions, one manual strength day: longest links.
    db.add_all([
        _w("Bench Press", "Upper Body", "2026-06-18"),
        _gs("2026-06-18", "WORKOUT", "Workout", 10.0, "15:00", "n1"),
        _gs("2026-06-18", "STRENGTH_TRAINING", "Strength Training", 47.0, "14:00", "n2"),
    ])
    db.commit()
    acts.migrate_activities(db)
    linked = db.query(Activity).filter(Activity.date == "2026-06-18",
                                       Activity.activity == "strength",
                                       Activity.google_session_id.isnot(None)).all()
    long_sess = db.query(WorkoutSession).filter(WorkoutSession.google_id == "n2").one()
    manual_act = [a for a in linked
                  if db.query(Workout).filter(Workout.activity_id == a.id).count() > 0]
    assert len(manual_act) == 1 and manual_act[0].google_session_id == long_sess.id


def test_migration_is_idempotent(db):
    _seed_flat(db)
    acts.migrate_activities(db)
    count = db.query(Activity).count()
    acts.migrate_activities(db)                     # re-run: nothing new
    assert db.query(Activity).count() == count


def test_migration_tolerates_partially_populated_table(db):
    # Prod reality: Tasks 5/6 already created activities for RECENT data before the
    # backfill ever ran. The migration must fill in only what's missing.
    recent = _w("Bench Press", "Upper Body", "2026-07-13")
    db.add(recent); db.flush()
    acts.attach_exercise(db, recent)                # simulates a live T5 write
    recent_s = _gs("2026-07-13", "STRENGTH_TRAINING", "Strength Training", 45.0, "14:00", "r1")
    db.add(recent_s); db.flush()
    pre_linked_id = acts.link_google_session(db, recent_s).id   # simulates a live T6 write
    db.commit()
    _seed_flat(db)                                   # historical flat data
    acts.migrate_activities(db)
    assert db.query(Workout).filter(Workout.activity_id.is_(None)).count() == 0
    # The pre-existing recent activity is untouched and not duplicated.
    assert db.query(Activity).filter(Activity.date == "2026-07-13").count() == 1
    # And the live-linked session stays linked to the SAME activity.
    still = db.query(Activity).filter(Activity.google_session_id == recent_s.id).one()
    assert still.id == pre_linked_id


def test_needs_backfill_orphan_workout(db):
    # A single unattached manual row is enough to demand the backfill.
    db.add(_w("Bench Press", "Upper Body", "2026-06-20"))
    db.commit()
    assert acts.needs_activity_backfill(db) is True


def test_needs_backfill_unlinked_session_among_linked(db):
    # Session branch alone: no orphan workouts, one session linked live, one
    # never linked. A manual activity with NULL google_session_id also exists —
    # the NOT-IN subquery must filter those NULLs or it would return no rows.
    w = _w("Bench Press", "Upper Body", "2026-06-21")
    db.add(w); db.flush()
    acts.attach_exercise(db, w)                     # activity with NULL session id
    linked_s = _gs("2026-06-21", "RUNNING", "Run", 30.0, "18:00", "p1")
    db.add(linked_s); db.flush()
    acts.link_google_session(db, linked_s)
    db.add(_gs("2026-06-22", "SWIMMING_POOL", "Pool swim", 20.0, "16:00", "p2"))
    db.commit()
    assert db.query(Workout).filter(Workout.activity_id.is_(None)).count() == 0
    assert acts.needs_activity_backfill(db) is True


def test_needs_backfill_false_when_converged(db):
    # Fully migrated state: every row attached, every session linked -> no-op.
    _seed_flat(db)
    acts.migrate_activities(db)
    assert acts.needs_activity_backfill(db) is False
