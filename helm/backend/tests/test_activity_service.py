"""activity_service: the only creator/linker of Activity rows."""
from backend.models import Activity, Workout, WorkoutSession
from backend.services import activity_service as acts


def _w(ex, cat, date="2026-07-13", reps=""):
    return Workout(date=date, category=cat, equipment_type="", exercise=ex,
                   weight_lbs="", reps_sets=reps, notes="", targeted_muscle_group="")


def _gs(**kw):
    base = dict(date="2026-07-13", source="google", category="cardio",
                exercise_type="Pool swim", exercise_type_raw="SWIMMING_POOL",
                start_time="2026-07-13T16:00:00", end_time="2026-07-13T16:21:00",
                duration_min=21.0, avg_hr=133)
    base.update(kw)
    return WorkoutSession(**base)


# ----------------------------------------------------------- attach_exercise
def test_strength_members_share_one_activity(db):
    lift = _w("Bench Press", "Upper Body")
    warmup = _w("Backwards Walking", "Cardio")
    db.add_all([lift, warmup]); db.flush()
    a1 = acts.attach_exercise(db, lift)
    a2 = acts.attach_exercise(db, warmup)
    db.commit()
    assert a1.id == a2.id and a1.activity == "strength"
    assert lift.activity_id == warmup.activity_id == a1.id
    assert db.query(Activity).count() == 1


def test_other_cardio_gets_keyword_activity(db):
    swim = _w("Pool Swim", "Cardio", reps="30 laps")
    stairs = _w("Stair Master", "Cardio")
    db.add_all([swim, stairs]); db.flush()
    a_swim = acts.attach_exercise(db, swim)
    a_stairs = acts.attach_exercise(db, stairs)
    db.commit()
    assert a_swim.activity == "swim" and a_stairs.activity == "stairs"
    assert a_swim.id != a_stairs.id


def test_same_activity_same_date_reused_across_calls(db):
    s1 = _w("Pool Swim", "Cardio")
    db.add(s1); db.flush()
    first = acts.attach_exercise(db, s1)
    db.commit()
    s2 = _w("Evening Swim", "Cardio")
    db.add(s2); db.flush()
    second = acts.attach_exercise(db, s2)
    db.commit()
    assert first.id == second.id


def test_different_dates_different_activities(db):
    a = _w("Pool Swim", "Cardio", date="2026-07-12")
    b = _w("Pool Swim", "Cardio", date="2026-07-13")
    db.add_all([a, b]); db.flush()
    assert acts.attach_exercise(db, a).id != acts.attach_exercise(db, b).id


def test_reattach_moves_row_between_activities(db):
    w = _w("Pool Swim", "Cardio")
    db.add(w); db.flush()
    old = acts.attach_exercise(db, w)
    db.commit()
    w.exercise = "Morning Run"                      # user corrected the entry
    new = acts.attach_exercise(db, w)
    acts.prune_if_empty(db, old.id)
    db.commit()
    assert new.activity == "run" and w.activity_id == new.id
    assert db.query(Activity).filter(Activity.id == old.id).first() is None  # emptied → pruned


def test_reattach_prunes_even_without_autoflush(db):
    # Prod sessions run autoflush=False (database.py) — prune must not rely on it.
    w = _w("Pool Swim", "Cardio")
    db.add(w); db.flush()
    old = acts.attach_exercise(db, w)
    db.commit()
    with db.no_autoflush:
        w.exercise = "Morning Run"
        acts.attach_exercise(db, w)
        acts.prune_if_empty(db, old.id)
    db.commit()
    assert db.query(Activity).filter(Activity.id == old.id).first() is None


# ----------------------------------------------------------- prune_if_empty
def test_prune_keeps_google_linked_activity(db):
    g = _gs(google_id="g1")
    db.add(g); db.commit()
    a = Activity(date="2026-07-13", activity="swim", google_session_id=g.id)
    db.add(a); db.commit()
    acts.prune_if_empty(db, a.id)
    db.commit()
    assert db.query(Activity).filter(Activity.id == a.id).first() is not None


def test_prune_keeps_activity_with_rows(db):
    w = _w("Pool Swim", "Cardio")
    db.add(w); db.flush()
    a = acts.attach_exercise(db, w)
    db.commit()
    acts.prune_if_empty(db, a.id)
    db.commit()
    assert db.query(Activity).count() == 1


def test_prune_handles_none_and_missing(db):
    acts.prune_if_empty(db, None)          # no-op, no crash
    acts.prune_if_empty(db, 999)           # missing id, no crash


# ----------------------------------------------------------- link_google_session
def test_link_matches_manual_activity_and_sets_label(db):
    swim = _w("Pool Swim", "Cardio", reps="30 laps")
    db.add(swim); db.flush()
    manual = acts.attach_exercise(db, swim)
    g = _gs(google_id="g1")
    db.add(g); db.flush()
    linked = acts.link_google_session(db, g)
    db.commit()
    assert linked.id == manual.id
    assert linked.google_session_id == g.id
    assert linked.label == "Pool swim"           # display label from Google


def test_link_strength_keeps_label_none(db):
    lift = _w("Bench Press", "Upper Body")
    db.add(lift); db.flush()
    acts.attach_exercise(db, lift)
    g = _gs(google_id="g1", exercise_type="Weightlifting", exercise_type_raw="WORKOUT",
            category="strength")
    db.add(g); db.flush()
    linked = acts.link_google_session(db, g)
    db.commit()
    # Always "Strength" at read time regardless of Google's label.
    assert linked.activity == "strength" and linked.label is None


def test_link_creates_google_only_activity(db):
    g = _gs(google_id="r1", exercise_type="Run", exercise_type_raw="RUNNING")
    db.add(g); db.flush()
    a = acts.link_google_session(db, g)
    db.commit()
    assert a.activity == "run" and a.label == "Run"
    assert a.google_session_id == g.id
    assert db.query(Workout).filter(Workout.activity_id == a.id).count() == 0


def test_link_is_permanent_and_idempotent(db):
    g = _gs(google_id="r1", exercise_type="Run", exercise_type_raw="RUNNING")
    db.add(g); db.flush()
    first = acts.link_google_session(db, g)
    db.commit()
    again = acts.link_google_session(db, g)
    db.commit()
    assert again.id == first.id
    assert db.query(Activity).count() == 1


def test_two_runs_one_day_two_activities(db):
    g1 = _gs(google_id="r1", exercise_type="Run", exercise_type_raw="RUNNING",
             start_time="2026-07-13T07:00:00", end_time="2026-07-13T07:20:00",
             duration_min=20.0)
    g2 = _gs(google_id="r2", exercise_type="Run", exercise_type_raw="RUNNING",
             start_time="2026-07-13T18:00:00", end_time="2026-07-13T18:30:00",
             duration_min=30.0)
    db.add_all([g1, g2]); db.flush()
    a1 = acts.link_google_session(db, g1)
    a2 = acts.link_google_session(db, g2)
    db.commit()
    assert a1.id != a2.id
    assert {a1.activity, a2.activity} == {"run"}


def test_stair_label_reservation(db):
    # A WORKOUT-typed "Stair climber" must link to the stairs activity, never strength.
    lift_row = _w("Bench Press", "Upper Body")
    stair_row = _w("Stair Master", "Cardio")
    db.add_all([lift_row, stair_row]); db.flush()
    strength_act = acts.attach_exercise(db, lift_row)
    stairs_act = acts.attach_exercise(db, stair_row)
    g = _gs(google_id="gstair", exercise_type="Stair climber", exercise_type_raw="WORKOUT",
            category="strength", duration_min=10.5, avg_hr=171)
    db.add(g); db.flush()
    linked = acts.link_google_session(db, g)
    db.commit()
    assert linked.id == stairs_act.id
    assert db.get(Activity, strength_act.id).google_session_id is None


def test_longest_first_when_two_candidates(db):
    # Two strength-typed sessions on one date: the manual strength activity takes the
    # LONGEST one no matter the arrival order (mirrors the old read-time rule).
    lift_row = _w("Bench Press", "Upper Body")
    db.add(lift_row); db.flush()
    manual = acts.attach_exercise(db, lift_row)
    short = _gs(google_id="gshort", exercise_type="Workout", exercise_type_raw="WORKOUT",
                category="strength", duration_min=10.0,
                start_time="2026-07-13T15:00:00", end_time="2026-07-13T15:10:00")
    long_ = _gs(google_id="glong", exercise_type="Strength Training",
                exercise_type_raw="STRENGTH_TRAINING", category="strength",
                duration_min=47.0, start_time="2026-07-13T14:00:00",
                end_time="2026-07-13T14:47:00")
    db.add_all([short, long_]); db.flush()
    a_short = acts.link_google_session(db, short)      # shorter arrives FIRST
    a_long = acts.link_google_session(db, long_)
    db.commit()
    assert a_long.id == manual.id                       # longest takes the manual activity
    assert a_short.id != manual.id                      # shorter got its own Google-only activity


# ----------------------------------------------------------- sync wiring
def test_upsert_returns_row_and_links(db):
    from backend.services import google_health_service as ghs
    parsed = dict(google_id="gr9", date="2026-07-13", exercise_type="Run",
                  exercise_type_raw="RUNNING", category="cardio",
                  start_time="2026-07-13T18:00:00", end_time="2026-07-13T18:30:00",
                  duration_min=30.0)
    row = ghs._upsert_workout_session(db, parsed)
    assert row is not None and row.id is not None
    a = acts.link_google_session(db, row)
    db.commit()
    assert db.query(Activity).one().id == a.id


def test_longest_first_when_longer_arrives_first(db):
    # Reverse arrival order of test_longest_first_when_two_candidates: the longer
    # session arrives FIRST and takes the manual activity directly.
    lift_row = _w("Bench Press", "Upper Body")
    db.add(lift_row); db.flush()
    manual = acts.attach_exercise(db, lift_row)
    short = _gs(google_id="gshort", exercise_type="Workout", exercise_type_raw="WORKOUT",
                category="strength", duration_min=10.0,
                start_time="2026-07-13T15:00:00", end_time="2026-07-13T15:10:00")
    long_ = _gs(google_id="glong", exercise_type="Strength Training",
                exercise_type_raw="STRENGTH_TRAINING", category="strength",
                duration_min=47.0, start_time="2026-07-13T14:00:00",
                end_time="2026-07-13T14:47:00")
    db.add_all([short, long_]); db.flush()
    a_long = acts.link_google_session(db, long_)       # longer arrives FIRST
    a_short = acts.link_google_session(db, short)
    db.commit()
    assert a_long.id == manual.id
    assert a_short.id != manual.id


# ----------------------------------------------------------- canonical activity
def test_is_canonical_activity():
    from backend.services.activity_service import is_canonical_activity
    for good in ["strength", "swim", "run", "bike", "row", "elliptical", "hike", "stairs", "cardio"]:
        assert is_canonical_activity(good) is True
    for bad in ["", None, "Strength", "yoga", "lifting", "swimming"]:
        assert is_canonical_activity(bad) is False


def test_get_or_create_activity_coalesces_and_sets_label(db):
    from backend.services.activity_service import get_or_create_activity
    a1 = get_or_create_activity(db, "2026-07-14", "strength", "Strength")
    a2 = get_or_create_activity(db, "2026-07-14", "strength", None)  # same day+activity
    db.commit()
    assert a1.id == a2.id                      # coalesced
    assert a1.activity == "strength" and a1.label == "Strength"

    swim = get_or_create_activity(db, "2026-07-14", "swim", "Pool swim")
    db.commit()
    assert swim.id != a1.id and swim.label == "Pool swim"
    from backend.models import Activity
    assert db.query(Activity).count() == 2
