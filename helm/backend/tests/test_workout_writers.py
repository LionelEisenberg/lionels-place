"""Every manual writer creates/attaches activities; PUT/bulk re-derive the daily."""
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from backend.database import Base, get_db
from backend.routers import workouts
from backend.models import Activity, Workout, DailySummary


@pytest.fixture
def client():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    app = FastAPI()
    app.include_router(workouts.router)
    app.dependency_overrides[get_db] = lambda: session
    try:
        yield TestClient(app), session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


BENCH = dict(date="2026-07-13", category="Upper Body", equipment_type="Barbell",
             exercise="Bench Press", weight_lbs="135", reps_sets="8, 8",
             notes="", targeted_muscle_group="Chest")
SWIM = dict(date="2026-07-13", category="Cardio", equipment_type="None",
            exercise="Pool Swim", weight_lbs="", reps_sets="30 laps",
            notes="", targeted_muscle_group="Cardio")


def test_post_creates_and_attaches_activity(client):
    c, s = client
    r = c.post("/api/workouts", json=BENCH)
    assert r.status_code == 200
    w = s.query(Workout).one()
    act = s.query(Activity).one()
    assert w.activity_id == act.id and act.activity == "strength"


def test_bulk_attaches_and_rederives_daily(client):
    c, s = client
    r = c.post("/api/workouts/bulk", json=[BENCH, SWIM])
    assert r.status_code == 200
    acts = {a.activity for a in s.query(Activity).all()}
    assert acts == {"strength", "swim"}
    assert all(w.activity_id is not None for w in s.query(Workout).all())
    # Rider fix: bulk now re-derives the daily's workout_type.
    assert s.query(DailySummary).filter(DailySummary.date == "2026-07-13").first() is not None


def test_put_absorbs_strength_row_renamed_to_cardio(client):
    c, s = client
    c.post("/api/workouts", json=BENCH)
    w = s.query(Workout).one()
    old_act = w.activity_id
    r = c.put(f"/api/workouts/{w.id}",
              json={"exercise": "Pool Swim", "category": "Cardio", "reps_sets": "30 laps"})
    assert r.status_code == 200
    s.expire_all()
    assert s.query(Workout).count() == 0                # absorbed, not moved
    swim = s.query(Activity).filter(Activity.activity == "swim").one()
    assert swim.laps == 30 and swim.finalized
    assert s.get(Activity, old_act) is None             # emptied strength activity pruned
    # Rider fix: PUT re-derives the daily.
    assert s.query(DailySummary).filter(DailySummary.date == "2026-07-13").first() is not None


def test_put_reattaches_on_date_change(client):
    c, s = client
    c.post("/api/workouts", json=BENCH)
    w = s.query(Workout).one()
    c.put(f"/api/workouts/{w.id}", json={"date": "2026-07-14"})
    s.expire_all()
    w = s.query(Workout).one()
    act = s.get(Activity, w.activity_id)
    assert act.date == "2026-07-14" and act.activity == "strength"


def test_put_without_reclassifying_change_keeps_activity(client):
    c, s = client
    c.post("/api/workouts", json=BENCH)
    w = s.query(Workout).one()
    before = w.activity_id
    c.put(f"/api/workouts/{w.id}", json={"weight_lbs": "145"})
    s.expire_all()
    assert s.query(Workout).one().activity_id == before


def test_delete_prunes_emptied_activity(client):
    c, s = client
    c.post("/api/workouts", json=BENCH)
    w = s.query(Workout).one()
    c.delete(f"/api/workouts/{w.id}")
    s.expire_all()
    assert s.query(Activity).count() == 0


def test_post_cardio_row_is_absorbed(client):
    c, s = client
    r = c.post("/api/workouts", json=SWIM)
    assert r.status_code == 200
    assert r.json()["exercise"] == "Pool Swim"          # snapshot response survives the absorb
    s.expire_all()
    assert s.query(Workout).count() == 0                # row-less cardio invariant
    act = s.query(Activity).one()
    assert act.activity == "swim" and act.laps == 30
    assert act.finalized and act.label == "Pool Swim"


# ------------------------------------------ explicit activity_id (edit flow)
def test_post_with_activity_id_attaches_explicitly(client):
    c, s = client
    c.post("/api/workouts", json=BENCH)                      # creates the strength activity
    strength_act = s.query(Activity).one()
    # A row named like cardio, aimed at the strength activity: explicit wins over heuristic.
    row = dict(BENCH, exercise="Sled Push Intervals", activity_id=strength_act.id)
    r = c.post("/api/workouts", json=row)
    assert r.status_code == 200
    w = s.query(Workout).filter(Workout.exercise == "Sled Push Intervals").one()
    assert w.activity_id == strength_act.id
    assert s.query(Activity).count() == 1                    # no heuristic second activity


def test_post_with_cardio_activity_id_absorbs(client):
    c, s = client
    c.post("/api/workouts", json=SWIM)                       # swim activity via absorb
    swim_act = s.query(Activity).one()
    row = dict(SWIM, exercise="Extra Laps", reps_sets="10 laps", activity_id=swim_act.id)
    r = c.post("/api/workouts", json=row)
    assert r.status_code == 200
    s.expire_all()
    assert s.query(Workout).count() == 0                     # absorbed, no row persisted
    assert s.get(Activity, swim_act.id).laps == 40           # 30 + 10


def test_post_with_unknown_activity_id_404s(client):
    c, s = client
    r = c.post("/api/workouts", json=dict(BENCH, activity_id=999))
    assert r.status_code == 404
    assert s.query(Workout).count() == 0


def test_post_with_date_mismatch_400s(client):
    c, s = client
    c.post("/api/workouts", json=SWIM)
    swim_act = s.query(Activity).one()
    r = c.post("/api/workouts", json=dict(BENCH, date="2026-07-14", activity_id=swim_act.id))
    assert r.status_code == 400
    assert s.query(Workout).count() == 0                     # swim was absorbed; bad row rejected


def test_bulk_honors_activity_id(client):
    c, s = client
    c.post("/api/workouts", json=BENCH)
    strength_act = s.query(Activity).one()
    rows = [dict(BENCH, exercise="Incline Press", activity_id=strength_act.id),
            dict(SWIM)]                                      # no target -> heuristic swim
    r = c.post("/api/workouts/bulk", json=rows)
    assert r.status_code == 200
    incline = s.query(Workout).filter(Workout.exercise == "Incline Press").one()
    assert incline.activity_id == strength_act.id
    assert {a.activity for a in s.query(Activity).all()} == {"strength", "swim"}


# ------------------------------------------ activity-level edit endpoints
def test_put_activity_updates_columns(client):
    c, s = client
    c.post("/api/workouts", json=SWIM)
    act = s.query(Activity).one()
    r = c.put(f"/api/workouts/activities/{act.id}",
              json={"laps": 42, "distance_m": 1250.0, "duration_min": 40, "notes": "felt smooth"})
    assert r.status_code == 200
    s.expire_all()
    act = s.query(Activity).one()
    assert (act.laps, act.distance_m, act.duration_min, act.notes) == (42, 1250.0, 40.0, "felt smooth")
    day = r.json()
    swim = day["sessions"][0]
    assert swim["laps"] == 42 and swim["notes"] == "felt smooth"


def test_put_activity_can_clear_values(client):
    c, s = client
    c.post("/api/workouts", json=SWIM)
    act = s.query(Activity).one()
    r = c.put(f"/api/workouts/activities/{act.id}", json={"laps": None})
    assert r.status_code == 200
    s.expire_all()
    assert s.query(Activity).one().laps is None


def test_put_activity_404(client):
    c, _ = client
    assert c.put("/api/workouts/activities/999", json={"laps": 1}).status_code == 404


def test_delete_activity_manual_cardio(client):
    c, s = client
    c.post("/api/workouts", json=SWIM)
    act = s.query(Activity).one()
    r = c.delete(f"/api/workouts/activities/{act.id}")
    assert r.status_code == 200
    s.expire_all()
    assert s.query(Activity).count() == 0


def test_delete_activity_strength_409(client):
    c, s = client
    c.post("/api/workouts", json=BENCH)
    act = s.query(Activity).one()
    assert c.delete(f"/api/workouts/activities/{act.id}").status_code == 409
