from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.database import Base, get_db
from backend.routers import daily as daily_router
from backend.models import DailyHealth


def _make_client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    event.listen(engine, "connect", lambda c, r: c.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)

    app = FastAPI()
    app.include_router(daily_router.router)
    app.dependency_overrides[get_db] = lambda: SessionLocal()
    return TestClient(app), SessionLocal


def _client(db):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    event.listen(engine, "connect", lambda c, r: c.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)

    app = FastAPI()
    app.include_router(daily_router.router)
    app.dependency_overrides[get_db] = lambda: SessionLocal()

    # Rebind so the passed-in db session is used by the override
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def test_dashboard_stats_includes_vitals(db=None):
    # db fixture: create a fresh session for this test
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    event.listen(engine, "connect", lambda c, r: c.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()

    from datetime import date, timedelta

    def _hd(days_ago, rhr, hrv):
        d = (date.today() - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        db.add(DailyHealth(date=d, resting_hr=rhr, hrv_ms=hrv))

    # Older baseline days inside the 7-day window (feed the 7d average)
    for i in (2, 3, 4):
        _hd(i, 54, 55.0)
    # Latest value on both today and yesterday (robust to LA-vs-UTC 1-day skew)
    _hd(1, 52, 61.0)
    _hd(0, 52, 61.0)
    db.commit()

    r = _client(db).get("/api/daily/dashboard-stats").json()
    assert r["resting_hr"] == 52
    assert r["hrv_ms"] == 61.0
    assert r["resting_hr_avg_7d"] is not None
    assert isinstance(r["rhr_sparkline"], list) and isinstance(r["hrv_sparkline"], list)
