"""Tests for POST /api/subscribe.

Uses a locally-constructed FastAPI app so this test doesn't depend on
backend.app (built in the next task).
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.database import SessionLocal
from backend.models import Subscriber
from backend.routes import router


@pytest.fixture
def subscribe_client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_new_email_returns_ok(subscribe_client):
    res = subscribe_client.post("/api/subscribe",
                                json={"email": "alice@example.com", "hp": ""})
    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_new_email_persists_row(subscribe_client):
    subscribe_client.post("/api/subscribe",
                          json={"email": "bob@example.com", "hp": ""})
    with SessionLocal() as db:
        rows = db.query(Subscriber).filter(Subscriber.email == "bob@example.com").all()
        assert len(rows) == 1
        assert rows[0].unsubscribe_token
        assert rows[0].unsubscribed_at is None


def test_email_is_lowercased_and_trimmed(subscribe_client):
    subscribe_client.post("/api/subscribe",
                          json={"email": "  Carol@Example.COM  ", "hp": ""})
    with SessionLocal() as db:
        sub = db.query(Subscriber).filter(Subscriber.email == "carol@example.com").first()
        assert sub is not None


def test_duplicate_active_email_returns_ok_without_second_row(subscribe_client):
    subscribe_client.post("/api/subscribe",
                          json={"email": "dan@example.com", "hp": ""})
    res = subscribe_client.post("/api/subscribe",
                                json={"email": "dan@example.com", "hp": ""})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    with SessionLocal() as db:
        rows = db.query(Subscriber).filter(Subscriber.email == "dan@example.com").all()
        assert len(rows) == 1


def test_resubscribe_clears_unsubscribed_at_and_rotates_token(subscribe_client):
    # initial subscribe
    subscribe_client.post("/api/subscribe",
                          json={"email": "eve@example.com", "hp": ""})
    with SessionLocal() as db:
        sub = db.query(Subscriber).filter(Subscriber.email == "eve@example.com").first()
        original_token = sub.unsubscribe_token
        sub.unsubscribed_at = "2025-01-01T00:00:00+00:00"
        db.commit()

    # re-subscribe
    res = subscribe_client.post("/api/subscribe",
                                json={"email": "eve@example.com", "hp": ""})
    assert res.status_code == 200

    with SessionLocal() as db:
        sub = db.query(Subscriber).filter(Subscriber.email == "eve@example.com").first()
        assert sub.unsubscribed_at is None
        assert sub.unsubscribe_token != original_token


def test_invalid_email_returns_400(subscribe_client):
    res = subscribe_client.post("/api/subscribe",
                                json={"email": "not-an-email", "hp": ""})
    assert res.status_code == 400
    assert res.json() == {"error": "invalid_email"}


def test_too_long_email_returns_400(subscribe_client):
    long_email = ("a" * 250) + "@b.cd"  # 256 chars total
    res = subscribe_client.post("/api/subscribe",
                                json={"email": long_email, "hp": ""})
    assert res.status_code == 400


def test_honeypot_filled_returns_ok_without_row(subscribe_client):
    res = subscribe_client.post("/api/subscribe",
                                json={"email": "fred@example.com", "hp": "i-am-a-bot"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    with SessionLocal() as db:
        rows = db.query(Subscriber).filter(Subscriber.email == "fred@example.com").all()
        assert len(rows) == 0


def test_rate_limit_silently_succeeds_after_threshold(subscribe_client):
    # Default limiter is 5/min — exhaust it with valid signups
    for i in range(5):
        res = subscribe_client.post("/api/subscribe",
                                    json={"email": f"u{i}@example.com", "hp": ""})
        assert res.status_code == 200

    # 6th from same IP → silent success, no row
    res = subscribe_client.post("/api/subscribe",
                                json={"email": "blocked@example.com", "hp": ""})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    with SessionLocal() as db:
        rows = db.query(Subscriber).filter(Subscriber.email == "blocked@example.com").all()
        assert len(rows) == 0


def test_x_forwarded_for_first_value_is_used(subscribe_client):
    # Two distinct first-XFF values should each have a fresh quota
    for _ in range(5):
        subscribe_client.post("/api/subscribe",
                              json={"email": "x@example.com", "hp": ""},
                              headers={"X-Forwarded-For": "10.0.0.1, 10.0.0.99"})
    # 6th from same first-XFF → blocked
    subscribe_client.post("/api/subscribe",
                          json={"email": "x2@example.com", "hp": ""},
                          headers={"X-Forwarded-For": "10.0.0.1, 10.0.0.99"})
    with SessionLocal() as db:
        # 5 first batch + 0 blocked + 0 second (only x@example.com, dedup'd to 1 row)
        active = db.query(Subscriber).filter(Subscriber.email == "x@example.com").count()
        blocked = db.query(Subscriber).filter(Subscriber.email == "x2@example.com").count()
        assert active == 1
        assert blocked == 0

    # Different first-XFF → fresh quota
    res = subscribe_client.post("/api/subscribe",
                                json={"email": "y@example.com", "hp": ""},
                                headers={"X-Forwarded-For": "10.0.0.2"})
    assert res.status_code == 200
    with SessionLocal() as db:
        assert db.query(Subscriber).filter(Subscriber.email == "y@example.com").count() == 1


def test_concurrent_insert_race_returns_silent_success(subscribe_client, monkeypatch):
    """Verify the IntegrityError race-loser path silently succeeds.

    Simulates the race by intercepting the SELECT to return None (signaling
    'new email') while pre-inserting the row in the DB so the INSERT trips
    the unique constraint.
    """
    from backend.database import SessionLocal
    from backend.models import Subscriber

    # Pre-populate the row that will trigger the IntegrityError on insert
    with SessionLocal() as db:
        db.add(Subscriber(email="racy@example.com"))
        db.commit()

    # Monkeypatch the query to return None (faking the race where our SELECT
    # ran before the other writer committed)
    import backend.routes as routes_mod
    original_filter = None  # placeholder for closure

    class _FakeQuery:
        def __init__(self, *args, **kwargs):
            pass
        def filter(self, *args, **kwargs):
            return self
        def first(self):
            return None

    # Patch only for this test
    real_query = None

    def fake_query(self, cls):
        if cls is Subscriber:
            return _FakeQuery()
        return real_query(self, cls)

    from sqlalchemy.orm import Session
    real_query = Session.query
    monkeypatch.setattr(Session, "query", fake_query)

    res = subscribe_client.post("/api/subscribe",
                                json={"email": "racy@example.com", "hp": ""})
    assert res.status_code == 200
    assert res.json() == {"ok": True}

    # Verify only one row exists (the pre-inserted one)
    monkeypatch.undo()
    with SessionLocal() as db:
        rows = db.query(Subscriber).filter(Subscriber.email == "racy@example.com").all()
        assert len(rows) == 1
