from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from backend.database import Base, get_db
from backend.routers import health_data
from backend.models import DailyHealth, IntradayHeartRate, DailySummary, WorkoutSession
import backend.routers.health_data as health_data_module


@pytest.fixture
def client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    event.listen(engine, "connect", lambda c, r: c.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()

    app = FastAPI()

    @app.middleware("http")
    async def _inject_admin(request: Request, call_next):
        request.state.user = {"jellyfin_id": "x", "role": "admin"}
        return await call_next(request)

    app.include_router(health_data.router)
    app.dependency_overrides[get_db] = lambda: SessionLocal()
    try:
        yield TestClient(app), session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


def test_daily_endpoint(client):
    c, session = client
    session.add(DailyHealth(date="2026-06-02", steps=9240, resting_hr=52))
    session.commit()
    r = c.get("/api/health/daily?start=2026-06-01&end=2026-06-03")
    assert r.status_code == 200
    assert r.json()[0]["steps"] == 9240


def test_intraday_endpoint(client):
    c, session = client
    session.add(IntradayHeartRate(
        date="2026-06-02",
        samples='{"points":[{"t":"00:00","bpm":60},{"t":"00:01","bpm":62}]}',
        min_bpm=60, avg_bpm=61, max_bpm=62,
    ))
    session.commit()
    r = c.get("/api/health/intraday/heart-rate?date=2026-06-02")
    assert r.status_code == 200 and r.json()["points"][0]["bpm"] == 60


def test_sync_internal_forbidden_without_secret(client, monkeypatch):
    c, _ = client
    # HEALTH_SYNC_SECRET unset → always 403 (fail-closed)
    monkeypatch.delenv("HEALTH_SYNC_SECRET", raising=False)
    r = c.post("/api/health/sync-internal")
    assert r.status_code == 403

    # Secret set but header missing → 403
    monkeypatch.setenv("HEALTH_SYNC_SECRET", "s3cret")
    r = c.post("/api/health/sync-internal")
    assert r.status_code == 403

    # Secret set but wrong header value → 403
    r = c.post("/api/health/sync-internal", headers={"X-Sync-Secret": "wrong"})
    assert r.status_code == 403


def test_sync_internal_runs_sync(client, monkeypatch):
    c, _ = client
    monkeypatch.setenv("HEALTH_SYNC_SECRET", "s3cret")
    monkeypatch.setattr(
        health_data_module.ghs,
        "run_sync",
        lambda db: {"status": "connected", "last_sync_at": None},
    )
    r = c.post("/api/health/sync-internal", headers={"X-Sync-Secret": "s3cret"})
    assert r.status_code == 200
    assert r.json()["status"] == "connected"


def _session(**over):
    base = dict(date="2026-06-17", exercise_type="Weightlifting", exercise_type_raw="WORKOUT",
                category="strength", start_time="2026-06-17T14:48:44",
                end_time="2026-06-17T15:58:19", duration_min=69.58, avg_hr=119, source="google")
    base.update(over)
    return WorkoutSession(**base)


def test_sessions_endpoint_lists_in_range_ordered(client):
    c, session = client
    session.add(_session(google_id="g1"))
    session.add(_session(google_id="g2", exercise_type="Pool swim", exercise_type_raw="SWIMMING_POOL",
                         category="cardio", start_time="2026-06-17T16:00:00",
                         end_time="2026-06-17T16:21:00", duration_min=21.0, avg_hr=133))
    session.commit()
    r = c.get("/api/health/sessions?start=2026-06-01&end=2026-06-30")
    assert r.status_code == 200
    data = r.json()
    assert [s["exercise_type"] for s in data] == ["Weightlifting", "Pool swim"]  # by start_time
    assert data[0]["category"] == "strength" and data[1]["distance_m"] is None


def test_session_heart_rate_endpoint_slices_window(client):
    c, session = client
    session.add(_session(google_id="g1", start_time="2026-06-17T14:48:00",
                         end_time="2026-06-17T15:00:00"))
    session.add(IntradayHeartRate(
        date="2026-06-17",
        samples='{"points":[{"t":"14:30","bpm":80},{"t":"14:48","bpm":120},'
                '{"t":"15:00","bpm":130},{"t":"15:30","bpm":70}]}',
        min_bpm=70, avg_bpm=100, max_bpm=130,
    ))
    session.commit()
    sid = session.query(WorkoutSession).one().id
    r = c.get(f"/api/health/sessions/{sid}/heart-rate")
    assert r.status_code == 200
    d = r.json()
    assert [p["t"] for p in d["points"]] == ["14:48", "15:00"]  # inclusive window
    assert d["min_bpm"] == 120 and d["max_bpm"] == 130


def test_session_heart_rate_404_for_unknown(client):
    c, _ = client
    assert c.get("/api/health/sessions/999/heart-rate").status_code == 404


def test_session_heart_rate_window_fetch(client, monkeypatch):
    c, session = client
    session.add(_session(google_id="gw", start_utc="2026-06-17T21:48:00Z",
                         end_utc="2026-06-17T22:58:00Z"))
    session.commit()
    sid = session.query(WorkoutSession).one().id
    monkeypatch.setattr(health_data_module.ghs, "get_valid_access_token", lambda db: "tok")
    monkeypatch.setattr(health_data_module.ghs, "fetch_session_hr_window",
                        lambda tok, su, eu: {"points": [{"t": "14:50", "bpm": 120}, {"t": "14:51", "bpm": 160}],
                                             "min_bpm": 110, "avg_bpm": 130, "max_bpm": 160})
    r = c.get(f"/api/health/sessions/{sid}/heart-rate")
    assert r.status_code == 200
    d = r.json()
    assert d["max_bpm"] == 160 and [p["bpm"] for p in d["points"]] == [120, 160]


def test_session_heart_rate_uses_cache(client):
    # A cached curve is served straight from the DB — no token, no Google call.
    c, session = client
    session.add(_session(google_id="gc",
        hr_curve='{"points":[{"t":"14:50","bpm":120},{"t":"14:51","bpm":150}],"min_bpm":118,"avg_bpm":135,"max_bpm":150}'))
    session.commit()
    sid = session.query(WorkoutSession).one().id
    r = c.get(f"/api/health/sessions/{sid}/heart-rate")
    assert r.status_code == 200
    d = r.json()
    assert d["max_bpm"] == 150 and d["avg_bpm"] == 135 and [p["bpm"] for p in d["points"]] == [120, 150]


def test_sessions_requires_admin():
    # Non-admin (friend) is rejected by _require_admin.
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    app = FastAPI()

    @app.middleware("http")
    async def _inject_friend(request: Request, call_next):
        request.state.user = {"jellyfin_id": "f", "role": "friend"}
        return await call_next(request)

    app.include_router(health_data.router)
    app.dependency_overrides[get_db] = lambda: SessionLocal()
    assert TestClient(app).get("/api/health/sessions").status_code == 403
