"""Tests for the Subscriber model."""
from backend.database import SessionLocal
from backend.models import Subscriber, utc_now_iso, new_token


def test_utc_now_iso_returns_iso_with_offset():
    s = utc_now_iso()
    # Format: 2026-05-13T08:56:00.123456+00:00
    assert "T" in s
    assert s.endswith("+00:00")


def test_new_token_is_32_hex_chars():
    t = new_token()
    assert len(t) == 32
    int(t, 16)  # raises if not valid hex


def test_new_token_is_unique_each_call():
    assert new_token() != new_token()


def test_subscriber_defaults_applied_on_insert():
    with SessionLocal() as db:
        sub = Subscriber(email="alice@example.com")
        db.add(sub)
        db.commit()
        db.refresh(sub)

        assert sub.id is not None
        assert sub.email == "alice@example.com"
        assert sub.subscribed_at is not None
        assert sub.unsubscribe_token
        assert sub.unsubscribed_at is None


def test_subscriber_email_unique_constraint():
    import pytest
    from sqlalchemy.exc import IntegrityError

    with SessionLocal() as db:
        db.add(Subscriber(email="bob@example.com"))
        db.commit()
        db.add(Subscriber(email="bob@example.com"))
        with pytest.raises(IntegrityError):
            db.commit()
