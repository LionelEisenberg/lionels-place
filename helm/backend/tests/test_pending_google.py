"""Route test for GET /api/workouts/pending-google."""
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from backend.database import Base, get_db
from backend.routers import workouts
from backend.models import Activity, Workout, WorkoutSession


@pytest.fixture
def client():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    app = FastAPI()
    app.include_router(workouts.router)
    app.dependency_overrides[get_db] = lambda: SessionLocal()
    try:
        yield TestClient(app), session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


def _session(sess, gid, date, raw="SWIMMING_POOL", label="Pool swim", dur=30.0):
    s = WorkoutSession(google_id=gid, date=date, exercise_type=label, exercise_type_raw=raw,
                       category="cardio", start_time=f"{date}T16:00:00", end_time=f"{date}T16:30:00",
                       duration_min=dur, calories_kcal=300.0, source="google")
    sess.add(s); sess.flush()
    return s


def test_pending_lists_only_unfinalized_google_only_in_window(client):
    c, sess = client
    recent = "2026-07-14"
    s1 = _session(sess, "g1", recent)
    a1 = Activity(date=recent, activity="swim", label="Pool swim", google_session_id=s1.id)
    s2 = _session(sess, "g2", recent, raw="RUNNING", label="Running")
    a2 = Activity(date=recent, activity="run", label="Running", google_session_id=s2.id, finalized=True)
    s3 = _session(sess, "g3", recent, raw="WORKOUT", label="Strength")
    a3 = Activity(date=recent, activity="strength", label="Strength", google_session_id=s3.id)
    sess.add_all([a1, a2, a3]); sess.flush()
    sess.add(Workout(date=recent, category="Upper Body", equipment_type="Barbell", exercise="Bench",
                     weight_lbs="135", reps_sets="8", notes="", targeted_muscle_group="Chest",
                     activity_id=a3.id))
    old = "2026-06-01"
    s4 = _session(sess, "g4", old)
    sess.add(Activity(date=old, activity="swim", label="Pool swim", google_session_id=s4.id))
    # (e) generic cardio (watch-detected walk) -> excluded (ambient movement, not a workout)
    s5 = _session(sess, "g5", recent, raw="WALKING", label="Walk")
    sess.add(Activity(date=recent, activity="cardio", label="Walk", google_session_id=s5.id))
    sess.commit()

    r = c.get("/api/workouts/pending-google?today=2026-07-14")
    assert r.status_code == 200
    body = r.json()
    assert [x["activity_id"] for x in body] == [a1.id]
    assert body[0]["label"] == "Pool swim" and body[0]["duration_min"] == 30.0


def test_pending_clusters_dupes_and_hides_logged(client):
    """Google stores one workout as several sessions (two type enums, or phone+watch).
    The banner works at the workout grain: one row per real workout, and a workout
    whose duplicate is already logged is hidden entirely."""
    c, sess = client
    d = "2026-07-14"

    def _sess(gid, raw, label, start, dur):
        s = WorkoutSession(google_id=gid, date=d, exercise_type=label, exercise_type_raw=raw,
                           category="cardio", start_time=f"{d}T{start}:00", end_time=f"{d}T{start}:59",
                           duration_min=dur, calories_kcal=300.0, source="google")
        sess.add(s); sess.flush()
        return s

    # Un-logged run, duplicated by Google (two RUNNING sessions, same 17:14 start)
    ar1 = Activity(date=d, activity="run", label="Run", google_session_id=_sess("r1", "RUNNING", "Run", "17:14", 33.5).id)
    ar2 = Activity(date=d, activity="run", label="Run", google_session_id=_sess("r2", "RUNNING", "Run", "17:14", 33.3).id)
    # Logged strength, also duplicated (WORKOUT + WEIGHTLIFTING, same 12:09 start)
    as1 = Activity(date=d, activity="strength", label=None, google_session_id=_sess("s1", "WORKOUT", "Weightlifting", "12:09", 60.0).id)
    as2 = Activity(date=d, activity="strength", label=None, google_session_id=_sess("s2", "WEIGHTLIFTING", "Weightlifting", "12:09", 60.1).id)
    sess.add_all([ar1, ar2, as1, as2]); sess.flush()
    sess.add(Workout(date=d, category="Upper Body", equipment_type="Barbell", exercise="Bench",
                     weight_lbs="135", reps_sets="8", notes="", targeted_muscle_group="Chest",
                     activity_id=as1.id))          # logged on ONE strength copy
    sess.commit()

    body = c.get(f"/api/workouts/pending-google?today={d}").json()
    # Exactly one row — the run, deduped to its longest copy; strength cluster hidden.
    assert len(body) == 1
    assert body[0]["activity"] == "run" and body[0]["activity_id"] == ar1.id
    assert body[0]["duration_min"] == 33.5 and body[0]["date"] == d
    # the card needs the full watch metric set on the payload
    assert {"end", "avg_hr", "pace_s_per_km", "elevation_gain_m", "avg_cadence_spm"} <= body[0].keys()
