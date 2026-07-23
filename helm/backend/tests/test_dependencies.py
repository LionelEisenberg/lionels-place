"""Tests for shared FastAPI dependencies."""

import os
os.environ["JWT_SECRET"] = "test-secret-key-for-unit-tests"

import pytest
from backend.dependencies import resolve_current_user
from backend.models import User


class TestResolveCurrentUser:
    def test_returns_user_when_found(self, db):
        user = User(jellyfin_id="jf-123", username="lionel", role="admin")
        db.add(user)
        db.commit()
        result = resolve_current_user("jf-123", db)
        assert result.username == "lionel"
        assert result.jellyfin_id == "jf-123"

    def test_returns_none_when_not_found(self, db):
        result = resolve_current_user("nonexistent", db)
        assert result is None

    def test_returns_correct_user_among_many(self, db):
        db.add(User(jellyfin_id="jf-1", username="alice", role="friend"))
        db.add(User(jellyfin_id="jf-2", username="bob", role="friend"))
        db.commit()
        result = resolve_current_user("jf-2", db)
        assert result.username == "bob"
