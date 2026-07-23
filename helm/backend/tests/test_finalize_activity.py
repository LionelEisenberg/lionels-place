"""Route test for POST /api/workouts/activities/{id}/finalize."""
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from backend.database import Base, get_db
from backend.routers import workouts
from backend.models import Activity, Workout, WorkoutSession, DailySummary
from backend.services.google_health_service import credited_burn   # 30% tracker haircut


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


def _linked(sess, activity="strength", kcal=250.0, gid="gx", start="18:00"):
    s = WorkoutSession(google_id=gid, date="2026-07-14", exercise_type="Strength",
                       exercise_type_raw="WORKOUT", category="strength",
                       start_time=f"2026-07-14T{start}:00", end_time="2026-07-14T18:47:00",
                       duration_min=47.0, calories_kcal=kcal, source="google")
    sess.add(s); sess.flush()
    a = Activity(date="2026-07-14", activity=activity, label="Strength", google_session_id=s.id)
    sess.add(a); sess.commit()
    return a, s


def test_finalize_attaches_rows_sets_flag_and_applies_google_burn(client):
    c, sess = client
    a, s = _linked(sess)
    body = {"exercises": [{"exercise": "Bench Press", "category": "Upper Body",
                           "equipment_type": "Barbell", "weight_lbs": "135",
                           "reps_sets": "8, 8, 7", "targeted_muscle_group": "Chest"}]}
    r = c.post(f"/api/workouts/activities/{a.id}/finalize", json=body)
    assert r.status_code == 200

    sess.expire_all()
    assert sess.query(Activity).get(a.id).finalized is True
    assert sess.query(Workout).filter(Workout.activity_id == a.id).count() == 1
    daily = sess.query(DailySummary).filter(DailySummary.date == "2026-07-14").first()
    assert daily.est_active_burn == credited_burn(250.0)   # derived from the locked-in workout


def test_finalize_as_is_no_exercises(client):
    c, sess = client
    a, s = _linked(sess, activity="run", kcal=500.0)
    r = c.post(f"/api/workouts/activities/{a.id}/finalize", json={"exercises": []})
    assert r.status_code == 200
    sess.expire_all()
    assert sess.query(Activity).get(a.id).finalized is True
    assert sess.query(Workout).filter(Workout.activity_id == a.id).count() == 0
    assert sess.query(DailySummary).filter(DailySummary.date == "2026-07-14").first().est_active_burn == credited_burn(500.0)


def test_finalize_missing_activity_404(client):
    c, _ = client
    assert c.post("/api/workouts/activities/999/finalize", json={"exercises": []}).status_code == 404


def test_active_burn_sums_finalized_and_excludes_unfinalized(client):
    """est_active_burn is DERIVED: the sum of the day's LOCKED-IN workouts' credited
    burn. A workout whose Google session isn't finalized contributes nothing; locking
    another one in re-derives the day to the new sum (and can't drift)."""
    c, sess = client
    a1, _ = _linked(sess, activity="run", kcal=500.0, gid="g1", start="17:00")
    a2, _ = _linked(sess, activity="strength", kcal=300.0, gid="g2", start="12:00")  # left un-finalized
    day = lambda: sess.query(DailySummary).filter(DailySummary.date == "2026-07-14").first().est_active_burn

    assert c.post(f"/api/workouts/activities/{a1.id}/finalize", json={"exercises": []}).status_code == 200
    sess.expire_all()
    assert day() == credited_burn(500.0)                          # only the locked-in run counts

    assert c.post(f"/api/workouts/activities/{a2.id}/finalize", json={"exercises": []}).status_code == 200
    sess.expire_all()
    assert day() == credited_burn(500.0) + credited_burn(300.0)   # re-derived to the sum


def test_finalize_twice_is_idempotent(client):
    """A repeat finalize must not append duplicate rows or re-apply burn."""
    c, sess = client
    a, s = _linked(sess, kcal=250.0)
    body = {"exercises": [{"exercise": "Bench Press", "category": "Upper Body",
                           "equipment_type": "Barbell", "weight_lbs": "135",
                           "reps_sets": "8", "targeted_muscle_group": "Chest"}]}
    assert c.post(f"/api/workouts/activities/{a.id}/finalize", json=body).status_code == 200
    assert c.post(f"/api/workouts/activities/{a.id}/finalize", json=body).status_code == 200  # again
    sess.expire_all()
    assert sess.query(Workout).filter(Workout.activity_id == a.id).count() == 1   # not 2
    assert sess.query(DailySummary).filter(DailySummary.date == "2026-07-14").first().est_active_burn == credited_burn(250.0)
