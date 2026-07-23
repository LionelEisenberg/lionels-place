"""Pytest setup — must set env BEFORE backend imports."""
import os
from pathlib import Path

os.environ.setdefault("READ_DATABASE_URL", "sqlite:///:memory:")
_fixture_dist = Path(__file__).parent / "fixtures" / "dist"
os.environ.setdefault("READ_DIST_DIR", str(_fixture_dist))
# backend/app.py mkdir's READ_DATA_DIR on import (defaults to /app/data inside
# the container). Point it at a writable tmp path so tests can run on a host.
os.environ.setdefault("READ_DATA_DIR", str(Path(__file__).parent / "_tmp_data"))

import pytest


@pytest.fixture(autouse=True)
def _reset_state():
    """Reset DB schema (and rate limiter once routes module exists)."""
    from backend.database import engine
    from backend.models import Base

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    try:
        from backend import routes
        routes._rate_limiter.reset()
    except ImportError:
        pass

    yield


@pytest.fixture
def client():
    """Used by Task 6+ tests (test_static.py). Imports backend.app on demand."""
    from fastapi.testclient import TestClient
    from backend.app import app
    return TestClient(app)
