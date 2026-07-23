"""Tests for the Claude Code bridge — strip_code_fences and endpoint logic."""

import pytest
from app import strip_code_fences


# --- strip_code_fences ---

def test_strip_no_fences():
    assert strip_code_fences('{"key": "value"}') == '{"key": "value"}'


def test_strip_json_fences():
    text = '```json\n{"key": "value"}\n```'
    assert strip_code_fences(text) == '{"key": "value"}'


def test_strip_plain_fences():
    text = '```\n{"key": "value"}\n```'
    assert strip_code_fences(text) == '{"key": "value"}'


def test_strip_fences_with_leading_whitespace():
    text = '  ```json\n{"key": "value"}\n```  '
    assert strip_code_fences(text) == '{"key": "value"}'


def test_strip_fences_no_newline():
    text = '```json{"key": "value"}```'
    assert strip_code_fences(text) == '{"key": "value"}'


# --- Health endpoint ---

@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from app import app
    return TestClient(app)


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
