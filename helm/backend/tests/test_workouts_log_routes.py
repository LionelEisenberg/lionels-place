"""Route tests for /api/workouts/log and /api/workouts/session-history."""
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from backend.database import Base, get_db
from backend.routers import workouts
from backend.models import Workout, WorkoutSession


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


def _seed(session):
    from backend.services import activity_service as acts
    rows = [
        Workout(date="2026-06-17", category="Upper Body", equipment_type="Barbell",
                exercise="Bench Press", weight_lbs="135", reps_sets="8, 8, 7",
                notes="", targeted_muscle_group="Chest"),
        Workout(date="2026-06-17", category="Cardio", equipment_type="None",
                exercise="Pool Swim", weight_lbs="", reps_sets="30 laps",
                notes="", targeted_muscle_group="Cardio"),
    ]
    session.add_all(rows)
    session.flush()
    for w in rows:
        acts.attach_exercise(session, w)
    sessions = [
        WorkoutSession(google_id="g1", date="2026-06-17", exercise_type="Weightlifting",
                       exercise_type_raw="WORKOUT", category="strength",
                       start_time="2026-06-17T14:48:00", end_time="2026-06-17T15:58:00",
                       duration_min=70.0, avg_hr=119, source="google"),
        WorkoutSession(google_id="g2", date="2026-06-17", exercise_type="Pool swim",
                       exercise_type_raw="SWIMMING_POOL", category="cardio",
                       start_time="2026-06-17T16:00:00", end_time="2026-06-17T16:21:00",
                       duration_min=21.0, avg_hr=133, source="google"),
    ]
    session.add_all(sessions)
    session.flush()
    for g in sessions:
        acts.link_google_session(session, g)
    session.commit()


def test_log_endpoint(client):
    c, session = client
    _seed(session)
    r = c.get("/api/workouts/log?start=2026-06-01&end=2026-06-30")
    assert r.status_code == 200
    days = r.json()
    assert len(days) == 1 and days[0]["day_type"] is None
    by = {s["activity"]: s for s in days[0]["sessions"]}
    assert set(by) == {"strength", "swim"}
    assert by["strength"]["avg_hr"] == 119
    assert by["strength"]["exercises"][0]["exercise"] == "Bench Press"
    assert by["swim"]["exercises"][0]["reps_sets"] == "30 laps"
    assert days[0]["exercise_count"] == 2 and days[0]["total_sets"] == 4
    assert days[0]["is_cardio"] is False


def test_session_history_endpoint(client):
    c, session = client
    _seed(session)
    r = c.get("/api/workouts/session-history?activity=strength")
    assert r.status_code == 200
    assert r.json()[0]["avg_hr"] == 119


def test_run_detail_endpoint(client):
    c, session = client
    from backend.models import RunDetail
    run = WorkoutSession(google_id="r1", date="2026-07-10", exercise_type="Run",
                         exercise_type_raw="RUNNING", category="cardio",
                         start_time="2026-07-10T18:04:00", end_time="2026-07-10T18:33:00",
                         duration_min=28.7, avg_hr=152, source="google")
    session.add(run)
    session.commit()
    session.add(RunDetail(
        workout_session_id=run.id,
        route='[[37.7749, -122.4194], [37.78, -122.41]]',
        splits='[{"distance_m": 1000.0, "seconds": 331.0, "avg_hr": 148, "marker": [37.78, -122.41]}]',
        route_status="ok"))
    session.commit()

    r = c.get(f"/api/workouts/run-detail/{run.id}")
    assert r.status_code == 200
    body = r.json()
    assert body["route_status"] == "ok"
    assert body["route"][0] == [37.7749, -122.4194]
    assert body["splits"][0]["seconds"] == 331.0
    assert body["splits"][0]["marker"] == [37.78, -122.41]

    assert c.get("/api/workouts/run-detail/99999").status_code == 404
