"""Tests for the /api/health OAuth router + public-callback allowlist."""
import os
from unittest.mock import patch, MagicMock

from cryptography.fernet import Fernet

os.environ["OAUTH_ENCRYPTION_KEY"] = Fernet.generate_key().decode()
os.environ["GOOGLE_HEALTH_CLIENT_ID"] = "cid"
os.environ["GOOGLE_HEALTH_CLIENT_SECRET"] = "csec"
os.environ["GOOGLE_HEALTH_REDIRECT_URI"] = "https://helm.example/api/health/oauth/callback"

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.database import Base, get_db
from backend.routers import health_oauth
from backend.auth import is_public_route


@pytest.fixture
def client():
    # StaticPool keeps a single connection reused by all threads — required for
    # in-memory SQLite when FastAPI runs sync handlers in a thread pool.
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    event.listen(engine, "connect", lambda c, r: c.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    # Keep a direct session for seeding data in tests
    session = SessionLocal()

    app = FastAPI()

    # Simulate JWTAuthMiddleware injecting an admin user.
    @app.middleware("http")
    async def inject_user(request: Request, call_next):
        request.state.user = {"username": "lionel", "jellyfin_id": "jf-1", "role": "admin"}
        return await call_next(request)

    app.include_router(health_oauth.router)
    # Use the same SessionLocal so requests share the same in-memory DB
    app.dependency_overrides[get_db] = lambda: SessionLocal()
    try:
        yield TestClient(app, follow_redirects=False), session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


def test_callback_is_public_route():
    assert is_public_route("/api/health/oauth/callback", "GET") is True
    # other health routes are NOT public
    assert is_public_route("/api/health/status", "GET") is False
    assert is_public_route("/api/health/sync", "POST") is False


def test_status_disconnected_by_default(client):
    c, _ = client
    resp = c.get("/api/health/status")
    assert resp.status_code == 200
    assert resp.json()["status"] == "disconnected"


def test_sync_409_when_not_connected(client):
    c, _ = client
    resp = c.post("/api/health/sync")
    assert resp.status_code == 409


@patch("backend.services.google_health_service.httpx.post")
def test_callback_unknown_state_redirects_error(mock_post, client):
    c, _ = client
    resp = c.get("/api/health/oauth/callback", params={"state": "nope", "code": "x"})
    assert resp.status_code == 302
    assert "health=error" in resp.headers["location"]
    mock_post.assert_not_called()


@patch("backend.services.google_health_service.httpx.post")
def test_callback_happy_path_redirects_connected(mock_post, client):
    c, session = client
    from backend.models import User
    from backend.services import google_health_service as ghs
    # FK fix: create a real user so OAuthCredential.user_id FK is satisfied
    u = User(jellyfin_id="jf-cb", username="t", role="admin")
    session.add(u)
    session.commit()
    state, _ = ghs.create_oauth_state(session, user_id=u.id)
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"access_token": "a", "refresh_token": "r", "expires_in": 3600, "scope": "s"}
    mock_resp.text = "{}"
    mock_post.return_value = mock_resp
    resp = c.get("/api/health/oauth/callback", params={"state": state, "code": "auth"})
    assert resp.status_code == 302
    assert "health=connected" in resp.headers["location"]


def test_admin_required_for_status(client):
    # Build a client whose middleware injects a FRIEND, expect 403.
    c, session = client
    # Re-wire the app's user to friend by patching the route's admin check target.
    # Simpler: hit status with a fresh app where role=friend.
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient
    from backend.database import get_db
    from backend.routers import health_oauth
    app = FastAPI()

    @app.middleware("http")
    async def inject_friend(request: Request, call_next):
        request.state.user = {"username": "bob", "jellyfin_id": "jf-2", "role": "friend"}
        return await call_next(request)

    app.include_router(health_oauth.router)
    app.dependency_overrides[get_db] = lambda: session
    fc = TestClient(app, follow_redirects=False)
    assert fc.get("/api/health/status").status_code == 403
