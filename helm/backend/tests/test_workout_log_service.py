"""Workout-log assembly (join over activities) and session history."""
from backend.services import workout_log_service as wls
from backend.services import activity_service as acts
from backend.models import Activity, Workout, WorkoutSession, IntradayHeartRate


def _w(ex, cat, reps="", date="2026-06-17"):
    return Workout(date=date, category=cat, equipment_type="", exercise=ex,
                   weight_lbs="", reps_sets=reps, notes="", targeted_muscle_group="")


def _add_w(db, ex, cat, reps="", date="2026-06-17", weight=""):
    """Manual-writer path: strength rows persist; cardio rows are absorbed
    into their activity's columns (row-less cardio) and return None."""
    w = _w(ex, cat, reps, date)
    w.weight_lbs = weight
    db.add(w)
    db.flush()
    acts.record_exercise(db, w)
    db.flush()
    return w if w in db else None


def _gs(**kw):
    base = dict(date="2026-06-17", source="google", category="cardio",
                start_time="2026-06-17T16:00:00", end_time="2026-06-17T16:21:00",
                duration_min=21.0, avg_hr=133)
    base.update(kw)
    return WorkoutSession(**base)


def _add_gs(db, finalized=False, **kw):
    g = _gs(**kw)
    db.add(g)
    db.flush()
    acts.link_google_session(db, g)
    if finalized:  # lock the watch session in, like the pending-banner flow does
        a = db.query(Activity).filter(Activity.google_session_id == g.id).first()
        if a is not None:
            a.finalized = True
    return g


# ----------------------------------------------------------------- assemble
def test_assemble_joins_activities(db):
    _add_w(db, "Bench Press", "Upper Body", reps="8, 8", weight="135")
    _add_w(db, "Pool Swim", "Cardio", reps="30 laps")
    _add_gs(db, google_id="g1", exercise_type="Weightlifting", exercise_type_raw="WORKOUT",
            category="strength", start_time="2026-06-17T14:48:00",
            end_time="2026-06-17T15:58:00", duration_min=70.0, avg_hr=119)
    _add_gs(db, google_id="g2", exercise_type="Pool swim", exercise_type_raw="SWIMMING_POOL")
    db.commit()
    days = wls.assemble_log(db, "2026-06-01", "2026-06-30")
    assert len(days) == 1
    by = {s["activity"]: s for s in days[0]["sessions"]}
    assert set(by) == {"strength", "swim"}
    assert by["strength"]["avg_hr"] == 119 and by["strength"]["label"] == "Strength"
    assert by["strength"]["start"] == "14:48"
    assert isinstance(by["strength"]["id"], int)                 # real activity PK
    assert by["strength"]["exercises"][0].exercise == "Bench Press"
    assert by["swim"]["avg_hr"] == 133 and by["swim"]["laps"] == 30
    assert [s["activity"] for s in days[0]["sessions"]] == ["strength", "swim"]  # chronological
    # Server-side day aggregates — rows are strength-only (row-less cardio)
    assert days[0]["exercise_count"] == 1
    assert days[0]["total_sets"] == 2                            # "8, 8" -> 2
    assert days[0]["total_volume"] == 135 * 8 + 135 * 8
    assert days[0]["is_cardio"] is False


def test_assemble_manual_only_has_no_hr(db):
    _add_w(db, "Bench Press", "Upper Body", date="2026-03-01")
    db.commit()
    days = wls.assemble_log(db, "2026-03-01", "2026-03-01")
    s = days[0]["sessions"][0]
    assert s["activity"] == "strength"
    assert s["avg_hr"] is None and s["google_session_id"] is None
    assert s["label"] == "Strength"


def test_google_only_run_day_hidden(db):
    # User decision (2026-07-14): activities tracked ONLY by Google — runs included —
    # do not appear in the workout log view. Stored + linked, but filtered at read.
    _add_gs(db, google_id="r1", exercise_type="Run", exercise_type_raw="RUNNING",
            date="2026-07-10", start_time="2026-07-10T18:04:00",
            end_time="2026-07-10T18:33:00", duration_min=28.7, avg_hr=152,
            distance_m=5210.0, avg_pace_s_per_km=330.5, calories_kcal=412.0)
    db.commit()
    assert wls.assemble_log(db, "2026-07-01", "2026-07-31") == []


def test_google_only_swim_day_hidden(db):
    _add_gs(db, google_id="g2", exercise_type="Pool swim", exercise_type_raw="SWIMMING_POOL")
    db.commit()
    assert wls.assemble_log(db, "2026-06-01", "2026-06-30") == []


def test_google_only_sessions_hidden_next_to_manual_day(db):
    # A day with manual rows still hides its Google-only siblings.
    _add_w(db, "Morning Run", "Cardio", reps="5 km", date="2026-07-10")
    _add_gs(db, google_id="r1", exercise_type="Run", exercise_type_raw="RUNNING",
            date="2026-07-10", start_time="2026-07-10T18:04:00",
            end_time="2026-07-10T18:33:00", duration_min=28.7)   # links to the manual activity
    _add_gs(db, google_id="r2", exercise_type="Run", exercise_type_raw="RUNNING",
            date="2026-07-10", start_time="2026-07-10T07:00:00",
            end_time="2026-07-10T07:20:00", duration_min=20.0)   # Google-only second run
    _add_gs(db, google_id="w1", exercise_type="Walk", exercise_type_raw="WALKING",
            date="2026-07-10", start_time="2026-07-10T12:00:00",
            end_time="2026-07-10T12:30:00", duration_min=30.0)   # Google-only walk
    db.commit()
    days = wls.assemble_log(db, "2026-07-01", "2026-07-31")
    assert len(days) == 1
    assert [s["activity"] for s in days[0]["sessions"]] == ["run"]   # only the manual one
    assert days[0]["sessions"][0]["distance_m"] == 5000.0            # absorbed "5 km"


def test_matched_run_single_card_google_distance_wins(db):
    _add_w(db, "Morning Run", "Cardio", reps="5 km", date="2026-07-10")
    _add_gs(db, google_id="r1", exercise_type="Run", exercise_type_raw="RUNNING",
            date="2026-07-10", start_time="2026-07-10T18:04:00",
            end_time="2026-07-10T18:33:00", duration_min=28.7, distance_m=5210.0,
            avg_pace_s_per_km=330.5)
    db.commit()
    days = wls.assemble_log(db, "2026-07-01", "2026-07-31")
    runs = [s for s in days[0]["sessions"] if s["activity"] == "run"]
    assert len(runs) == 1
    assert runs[0]["exercises"] == []                    # row-less cardio
    assert runs[0]["distance_m"] == 5210.0               # Google wins for runs


def test_manual_fallback_run_without_google(db):
    _add_w(db, "Treadmill Run", "Cardio", reps="4 km", date="2026-07-11")
    db.commit()
    days = wls.assemble_log(db, "2026-07-11", "2026-07-11")
    s = days[0]["sessions"][0]
    assert s["activity"] == "run" and s["google_session_id"] is None
    assert s["distance_m"] == 4000.0


def test_stairs_link_survives_to_read(db):
    _add_w(db, "Bench Press", "Upper Body")
    _add_w(db, "Stair Master", "Cardio", reps="10 min @ 55 ft/min")
    _add_gs(db, google_id="glift", exercise_type="Strength Training",
            exercise_type_raw="STRENGTH_TRAINING", category="strength",
            start_time="2026-06-17T14:00:00", end_time="2026-06-17T14:47:00",
            duration_min=47.0, avg_hr=122)
    _add_gs(db, google_id="gstair", exercise_type="Stair climber", exercise_type_raw="WORKOUT",
            category="strength", start_time="2026-06-17T15:00:00",
            end_time="2026-06-17T15:10:00", duration_min=10.5, avg_hr=171)
    db.commit()
    days = wls.assemble_log(db, "2026-06-01", "2026-06-30")
    by = {s["activity"]: s for s in days[0]["sessions"]}
    assert by["strength"]["avg_hr"] == 122
    assert by["stairs"]["avg_hr"] == 171 and by["stairs"]["label"] == "Stair climber"


def test_manual_run_with_google_link_has_route_flag(db):
    # A manually-logged run linked to a Google session keeps its route flag — it's
    # visible (has manual rows), unlike a Google-only run which is filtered out.
    from backend.models import RunDetail
    _add_w(db, "Morning Run", "Cardio", reps="5 km", date="2026-07-10")
    g = _add_gs(db, google_id="r1", exercise_type="Run", exercise_type_raw="RUNNING",
                date="2026-07-10", start_time="2026-07-10T18:04:00",
                end_time="2026-07-10T18:33:00")
    db.commit()
    db.add(RunDetail(workout_session_id=g.id, route='[[37.0,-122.0]]', route_status="ok"))
    db.commit()
    days = wls.assemble_log(db, "2026-07-01", "2026-07-31")
    assert days[0]["sessions"][0]["has_route"] is True


def test_assemble_mixed_timed_and_untimed_day(db):
    # Untimed (manual-only) activities sort AFTER google-timed ones, deterministically.
    _add_w(db, "Pool Swim", "Cardio", reps="20 laps")          # untimed manual swim
    _add_w(db, "Bench Press", "Upper Body")
    _add_gs(db, google_id="g1", exercise_type="Weightlifting", exercise_type_raw="WORKOUT",
            category="strength", start_time="2026-06-17T14:00:00",
            end_time="2026-06-17T15:00:00", duration_min=60.0)
    db.commit()
    days = wls.assemble_log(db, "2026-06-01", "2026-06-30")
    acts_order = [s["activity"] for s in days[0]["sessions"]]
    assert acts_order == ["strength", "swim"]                  # timed first, untimed last


def test_assemble_stored_day_type_not_overridden(db):
    from backend.models import DailySummary
    _add_w(db, "Pool Swim", "Cardio", reps="30 laps", date="2026-07-10")
    db.add(DailySummary(date="2026-07-10", workout_type="Legs"))
    db.commit()
    days = wls.assemble_log(db, "2026-07-10", "2026-07-10")
    assert days[0]["day_type"] == "Legs"                       # fallback must not override


def test_assemble_cardio_day_has_zero_volume(db):
    _add_w(db, "Pool Swim", "Cardio", reps="30 laps")
    db.commit()
    days = wls.assemble_log(db, "2026-06-17", "2026-06-17")
    assert days[0]["is_cardio"] is True and days[0]["total_volume"] == 0.0
    assert days[0]["day_type"] == "Cardio"                     # activities-derived fallback


# ----------------------------------------------------------------- aggregates
def test_count_sets_and_volume_port():
    assert wls.count_sets("8, 8, 9") == 3
    assert wls.count_sets("") == 0
    assert wls.count_sets("30 laps") == 1
    assert wls.compute_volume("135", "8, 8") == 135 * 16
    assert wls.compute_volume("30, 35, 35", "8, 8, 9") == 30 * 8 + 35 * 8 + 35 * 9
    assert wls.compute_volume("-115", "8, 8") == 115 * 16       # assisted: abs()
    assert wls.compute_volume("30, 35", "8, 8, 9") == 30 * 8 + 35 * 8 + 35 * 9  # last repeats
    assert wls.compute_volume("", "8, 8") == 0
    assert wls.compute_volume("135", "") == 0
    assert wls.compute_volume("135", "8 (Fail), 7") == 135 * 15  # "(Fail)" stripped
    # JS-parseFloat prefix fidelity (matches the deployed client's math)
    assert wls.compute_volume("55", "8 (F), 7") == 55 * 15       # "(F)" shorthand — prefix grabs the 8
    assert wls.compute_volume("135", "15s, 9s") == 135 * 24      # timed holds: "15s" -> 15
    assert wls.compute_volume("30 lbs", "8") == 240              # weight prefix: "30 lbs" -> 30
    assert wls.compute_volume("10", "4 x 8") == 40               # "4 x 8" -> 4, same as JS parseFloat
    assert wls.compute_volume("+45", "2") == 90                  # explicit plus sign
    assert wls.compute_volume(".5", "2") == 1.0                  # bare leading decimal
    assert wls._parse_float_prefix("5e2") == 500.0               # exponent form


# ----------------------------------------------------------------- history
def test_history_strength_google_driven_max_from_intraday(db):
    _add_gs(db, finalized=True, google_id="s1", exercise_type="Weightlifting",
            exercise_type_raw="WORKOUT", category="strength",
            start_time="2026-06-17T14:00:00", end_time="2026-06-17T15:00:00",
            duration_min=60.0, avg_hr=119)
    db.add(IntradayHeartRate(date="2026-06-17", min_bpm=110, avg_bpm=130, max_bpm=160,
           samples='{"points":[{"t":"14:10","bpm":120},{"t":"14:30","bpm":160},{"t":"14:50","bpm":110}]}'))
    db.commit()
    rows = wls.session_history(db, "strength")
    assert rows[0]["date"] == "2026-06-17" and rows[0]["avg_hr"] == 119
    assert rows[0]["max_hr"] == 160                    # intraday fallback (no cached curve)


def test_history_max_prefers_cached_curve(db):
    _add_gs(db, finalized=True, google_id="sc", exercise_type="Weightlifting",
            exercise_type_raw="WORKOUT", category="strength",
            start_time="2026-06-17T14:00:00", end_time="2026-06-17T15:00:00",
            duration_min=60.0, avg_hr=119,
            hr_curve='{"points":[],"min_bpm":92,"avg_bpm":119,"max_bpm":171}')
    db.commit()
    rows = wls.session_history(db, "strength")
    assert rows[0]["max_hr"] == 171


def test_history_strength_skips_manual_only_days(db):
    # Manual-only strength days carry no duration/HR — they'd be all-null noise.
    _add_w(db, "Bench Press", "Upper Body", date="2026-06-16")
    _add_gs(db, finalized=True, google_id="s1", exercise_type="Weightlifting",
            exercise_type_raw="WORKOUT", category="strength",
            start_time="2026-06-17T14:00:00", end_time="2026-06-17T15:00:00",
            duration_min=60.0, avg_hr=119)
    db.commit()
    rows = wls.session_history(db, "strength")
    assert [r["date"] for r in rows] == ["2026-06-17"]


def test_history_strength_excludes_stairs(db):
    _add_w(db, "Stair Master", "Cardio", reps="10 min", date="2026-06-17")
    _add_gs(db, google_id="hstair", exercise_type="Stair climber",
            exercise_type_raw="WORKOUT", category="strength",
            start_time="2026-06-17T15:00:00", end_time="2026-06-17T15:10:00",
            duration_min=10.5, avg_hr=171)
    _add_gs(db, finalized=True, google_id="hlift", exercise_type="Weightlifting",
            exercise_type_raw="WORKOUT", category="strength",
            start_time="2026-06-17T14:00:00", end_time="2026-06-17T15:00:00",
            duration_min=60.0, avg_hr=119)
    db.commit()
    srows = wls.session_history(db, "strength")
    assert all(r["avg_hr"] != 171 for r in srows) and any(r["avg_hr"] == 119 for r in srows)
    strows = wls.session_history(db, "stairs")
    assert strows[0]["avg_hr"] == 171 and strows[0]["duration_min"] == 10.5


def test_history_swim_merges_manual_laps_with_google(db):
    # THE fix: manual laps no longer vanish when a Google session is linked.
    _add_w(db, "Pool Swim", "Cardio", reps="30 laps")
    _add_gs(db, google_id="s2", exercise_type="Pool swim", exercise_type_raw="SWIMMING_POOL")
    db.commit()
    rows = wls.session_history(db, "swim")
    assert len(rows) == 1
    assert rows[0]["laps"] == 30 and rows[0]["avg_hr"] == 133 and rows[0]["duration_min"] == 21.0


def test_history_two_google_sessions_same_day_two_rows(db):
    # Deliberate semantics change: each Google session is its own activity, so two
    # same-type sessions on one date are two history rows (old code merged to one).
    _add_gs(db, finalized=True, google_id="sw1", exercise_type="Pool swim", exercise_type_raw="SWIMMING_POOL",
            start_time="2026-06-17T07:00:00", end_time="2026-06-17T07:21:00",
            duration_min=21.0, avg_hr=133)
    _add_gs(db, finalized=True, google_id="sw2", exercise_type="Pool swim", exercise_type_raw="SWIMMING_POOL",
            start_time="2026-06-17T18:00:00", end_time="2026-06-17T18:30:00",
            duration_min=30.0, avg_hr=141)
    db.commit()
    rows = wls.session_history(db, "swim")
    assert len(rows) == 2
    assert {r["avg_hr"] for r in rows} == {133, 141}


def test_history_cardio_without_google_still_appears(db):
    _add_w(db, "Pool Swim", "Cardio", reps="40 laps", date="2026-05-01")
    db.commit()
    rows = wls.session_history(db, "swim")
    assert len(rows) == 1
    assert rows[0]["date"] == "2026-05-01" and rows[0]["laps"] == 40
    assert rows[0]["avg_hr"] is None and rows[0]["duration_min"] is None


def test_history_run_google_driven_with_manual_fallback(db):
    _add_gs(db, google_id="r1", date="2026-07-10", exercise_type="Run",
            exercise_type_raw="RUNNING", start_time="2026-07-10T18:04:00",
            end_time="2026-07-10T18:33:00", duration_min=28.7, avg_hr=152,
            distance_m=5210.0, avg_pace_s_per_km=330.5)
    _add_gs(db, finalized=True, google_id="r2", date="2026-07-08", exercise_type="Run",
            exercise_type_raw="RUNNING", start_time="2026-07-08T18:00:00",
            end_time="2026-07-08T18:20:00", duration_min=20.0,
            distance_m=3000.0, avg_pace_s_per_km=350.0)
    _add_w(db, "Morning Run", "Cardio", reps="8 laps, 5 km", date="2026-07-10")  # merges, no duplicate
    _add_w(db, "Treadmill Run", "Cardio", reps="4 km", date="2026-07-01")  # manual-only fallback
    _add_w(db, "Pool Swim", "Cardio", reps="30 laps", date="2026-07-09")   # ignored
    db.commit()
    rows = wls.session_history(db, "run", limit=10)
    assert [r["date"] for r in rows] == ["2026-07-10", "2026-07-08", "2026-07-01"]
    assert rows[0]["distance_m"] == 5210.0 and rows[0]["pace_s_per_km"] == 330.5
    assert rows[0]["laps"] == 8            # manual laps survive on a Google run day
    assert rows[1]["pace_s_per_km"] == 350.0
    assert rows[2]["distance_m"] == 4000.0 and rows[2]["duration_min"] is None


def test_finalized_zero_row_activity_is_visible(db):
    from backend.models import Activity, WorkoutSession
    from backend.services.workout_log_service import assemble_log

    s = WorkoutSession(google_id="gr1", date="2026-07-14", exercise_type="Running",
                       exercise_type_raw="RUNNING", category="cardio",
                       start_time="2026-07-14T07:00:00", end_time="2026-07-14T07:35:00",
                       duration_min=35.0, distance_m=6000.0, source="google")
    db.add(s); db.flush()
    act_final = Activity(date="2026-07-14", activity="run", label="Running",
                         google_session_id=s.id, finalized=True)   # locked in, no rows
    act_hidden = Activity(date="2026-07-14", activity="swim", label="Pool swim")  # google-only, not final
    db.add_all([act_final, act_hidden]); db.commit()

    days = assemble_log(db, "2026-07-14", "2026-07-14")
    assert len(days) == 1
    labels = {sess["label"] for sess in days[0]["sessions"]}
    assert "Running" in labels
    assert "Pool swim" not in labels


def test_history_respects_limit(db):
    for i in range(5):
        _add_gs(db, finalized=True, google_id=f"rl{i}", date=f"2026-07-0{i + 1}", exercise_type="Run",
                exercise_type_raw="RUNNING", start_time=f"2026-07-0{i + 1}T18:00:00",
                end_time=f"2026-07-0{i + 1}T18:20:00", duration_min=20.0)
    db.commit()
    assert len(wls.session_history(db, "run", limit=3)) == 3


def test_history_hides_unfinalized_google_only(db):
    """A watch session never locked in doesn't count in progression charts."""
    _add_gs(db, google_id="ghost", exercise_type="Bike", exercise_type_raw="BIKING",
            date="2026-06-04", start_time="2026-06-04T10:00:00",
            end_time="2026-06-04T10:00:15", duration_min=0.25)
    _add_w(db, "Cycling", "Cardio", reps="6 miles", date="2026-06-10")
    db.commit()
    assert [r["date"] for r in wls.session_history(db, "bike")] == ["2026-06-10"]


def test_mile_logged_ride_gets_distance_in_log(db):
    _add_w(db, "Cycling", "Cardio", reps="23 mi, 2 hrs", date="2026-03-14")
    db.commit()
    days = wls.assemble_log(db, "2026-03-01", "2026-03-31")
    assert days[0]["sessions"][0]["distance_m"] == round(23 * 1609.34, 1)


# ------------------------------------------- non-run Google distance fallback
def test_bike_distance_falls_back_to_google(db):
    """A bike whose manual row carries no distance shows the session's km."""
    _add_w(db, "Cycling", "Cardio", reps="80 min", date="2026-07-13")
    _add_gs(db, google_id="gbike", exercise_type="Bike", exercise_type_raw="BIKING",
            date="2026-07-13", start_time="2026-07-13T16:30:00",
            end_time="2026-07-13T17:55:00", duration_min=80.5, distance_m=24709.2)
    db.commit()
    days = wls.assemble_log(db, "2026-07-01", "2026-07-31")
    bike = days[0]["sessions"][0]
    assert bike["activity"] == "bike"
    assert bike["distance_m"] == 24709.2


def test_bike_manual_distance_wins_over_google(db):
    """Non-run cardio keeps a manually logged distance over Google's."""
    _add_w(db, "Cycling", "Cardio", reps="20 km", date="2026-07-13")
    _add_gs(db, google_id="gbike2", exercise_type="Bike", exercise_type_raw="BIKING",
            date="2026-07-13", start_time="2026-07-13T16:30:00",
            end_time="2026-07-13T17:55:00", duration_min=80.5, distance_m=24709.2)
    db.commit()
    days = wls.assemble_log(db, "2026-07-01", "2026-07-31")
    bike = days[0]["sessions"][0]
    assert bike["distance_m"] == 20000.0


def test_history_bike_distance_falls_back_to_google(db):
    _add_w(db, "Cycling", "Cardio", reps="80 min", date="2026-07-13")
    _add_gs(db, google_id="gbike3", exercise_type="Bike", exercise_type_raw="BIKING",
            date="2026-07-13", start_time="2026-07-13T16:30:00",
            end_time="2026-07-13T17:55:00", duration_min=80.5, distance_m=24709.2)
    db.commit()
    hist = wls.session_history(db, "bike")
    assert hist[0]["distance_m"] == 24709.2


# ------------------------------------------- row-less cardio migration
def test_migrate_cardio_metadata_absorbs_and_deletes(db):
    # Simulate the pre-migration world: cardio carrier rows attached via the
    # backfill path (attach_exercise keeps rows).
    for ex, reps, notes in [("Cycling", "23 mi, 2 hrs", "hilly ride"),
                            ("Pool Swim", "30 laps", "")]:
        w = _w(ex, "Cardio", reps, date="2026-03-14")
        w.notes = notes
        db.add(w); db.flush()
        acts.attach_exercise(db, w)
    _add_w(db, "Bench Press", "Upper Body", reps="8, 8", weight="135", date="2026-03-14")
    db.commit()

    acts.migrate_cardio_metadata(db)

    from backend.models import Activity
    bike = db.query(Activity).filter(Activity.activity == "bike").one()
    assert bike.distance_m == round(23 * 1609.34, 1)
    assert bike.duration_min == 120.0
    assert bike.notes == "hilly ride" and bike.label == "Cycling" and bike.finalized
    swim = db.query(Activity).filter(Activity.activity == "swim").one()
    assert swim.laps == 30 and swim.finalized
    # Carrier rows deleted; strength row untouched
    assert [w.exercise for w in db.query(Workout).all()] == ["Bench Press"]

    acts.migrate_cardio_metadata(db)   # idempotent no-op
    assert db.query(Activity).filter(Activity.activity == "bike").one().distance_m == round(23 * 1609.34, 1)
