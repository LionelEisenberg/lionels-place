"""Tests for the unsubscribe stub route — returns 501 until send flow lands."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.routes import router


@pytest.fixture
def unsub_client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_unsubscribe_returns_501(unsub_client):
    res = unsub_client.get("/api/unsubscribe?token=abc123")
    assert res.status_code == 501


def test_unsubscribe_without_token_still_501(unsub_client):
    res = unsub_client.get("/api/unsubscribe")
    # Token is required by the signature; FastAPI returns 422 for missing query.
    # When implemented, missing token should return 400. For now we accept either
    # 501 (stub doesn't care about token) or 422 (FastAPI auto-validation).
    assert res.status_code in (422, 501)
