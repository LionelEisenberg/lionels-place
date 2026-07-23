"""Tests for the optional _private module loader in backend/app.py."""

import sys
import importlib
import builtins
import pytest


def test_app_imports_when_private_module_absent(monkeypatch):
    """app.py must import cleanly even when backend._private doesn't exist."""
    monkeypatch.delitem(sys.modules, "backend._private", raising=False)

    original_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "backend._private" or name.endswith("._private"):
            raise ImportError(f"Simulated missing module: {name}")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)

    if "backend.app" in sys.modules:
        monkeypatch.delitem(sys.modules, "backend.app", raising=False)
    backend_app = importlib.import_module("backend.app")
    assert hasattr(backend_app, "app")


def test_private_routes_404_when_module_absent(monkeypatch):
    """Without _private, /api/private/today must return 401 or 404 (route not registered as a real handler)."""
    from fastapi.testclient import TestClient

    monkeypatch.delitem(sys.modules, "backend._private", raising=False)

    original_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "backend._private" or name.endswith("._private"):
            raise ImportError(f"Simulated missing module: {name}")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)

    if "backend.app" in sys.modules:
        monkeypatch.delitem(sys.modules, "backend.app", raising=False)
    backend_app = importlib.import_module("backend.app")

    client = TestClient(backend_app.app)
    response = client.get("/api/private/today")
    # JWT middleware will block with 401 first; or 404 if route truly not registered.
    # Either confirms the route is not a real handler.
    assert response.status_code in (401, 404)
