"""Tests for Jellyfin-backed auth service — JWT, role logic, and Jellyfin API."""

import os
from unittest.mock import patch, MagicMock

import pytest

# Set JWT_SECRET before importing auth_service
os.environ["JWT_SECRET"] = "test-secret-key-for-unit-tests"

from backend.services.auth_service import (
    create_jwt,
    verify_jwt,
    determine_role,
    authenticate_with_jellyfin,
)


class TestCreateAndVerifyJWT:
    def test_roundtrip(self):
        """Sign a JWT and verify it returns the same payload."""
        data = {"jellyfin_id": "abc123", "username": "lionel", "role": "admin"}
        token = create_jwt(data)
        payload = verify_jwt(token)
        assert payload["jellyfin_id"] == "abc123"
        assert payload["username"] == "lionel"
        assert payload["role"] == "admin"

    def test_contains_exp_claim(self):
        """JWT must contain an expiration claim."""
        token = create_jwt({"jellyfin_id": "x", "username": "u", "role": "friend"})
        payload = verify_jwt(token)
        assert "exp" in payload

    def test_invalid_token_raises(self):
        """Garbage token should raise ValueError."""
        with pytest.raises(ValueError):
            verify_jwt("not.a.valid.token")

    def test_wrong_secret_raises(self):
        """Token signed with one secret should fail verification with another."""
        token = create_jwt({"jellyfin_id": "x", "username": "u", "role": "friend"})
        with patch("backend.services.auth_service._jwt_secret", "different-secret"):
            with pytest.raises(ValueError):
                verify_jwt(token)


class TestDetermineRole:
    def test_jellyfin_admin_is_admin(self):
        assert determine_role(is_jellyfin_admin=True, username="someone") == "admin"

    def test_allowlist_user_is_admin(self):
        with patch.dict(os.environ, {"HELM_ADMIN_USERS": "alice,bob"}):
            assert determine_role(is_jellyfin_admin=False, username="alice") == "admin"
            assert determine_role(is_jellyfin_admin=False, username="bob") == "admin"

    def test_allowlist_case_insensitive(self):
        with patch.dict(os.environ, {"HELM_ADMIN_USERS": "Lionel"}):
            assert determine_role(is_jellyfin_admin=False, username="lionel") == "admin"
            assert determine_role(is_jellyfin_admin=False, username="LIONEL") == "admin"

    def test_non_admin_is_friend(self):
        with patch.dict(os.environ, {"HELM_ADMIN_USERS": ""}):
            assert determine_role(is_jellyfin_admin=False, username="rando") == "friend"

    def test_no_allowlist_env_var(self):
        with patch.dict(os.environ, {"HELM_ADMIN_USERS": ""}, clear=False):
            assert determine_role(is_jellyfin_admin=False, username="rando") == "friend"


class TestAuthenticateWithJellyfin:
    def _mock_response(self, status_code, json_data=None, text=""):
        resp = MagicMock()
        resp.status_code = status_code
        resp.json.return_value = json_data or {}
        resp.text = text
        return resp

    @patch("backend.services.auth_service.httpx.post")
    def test_successful_auth(self, mock_post):
        mock_post.return_value = self._mock_response(200, {
            "User": {
                "Id": "jf-123",
                "Name": "lionel",
                "Policy": {"IsAdministrator": True},
            },
            "AccessToken": "tok",
        })
        result = authenticate_with_jellyfin("lionel", "pass123")
        assert result["jellyfin_id"] == "jf-123"
        assert result["username"] == "lionel"
        assert result["is_admin"] is True

    @patch("backend.services.auth_service.httpx.post")
    def test_bad_credentials_raises_value_error(self, mock_post):
        mock_post.return_value = self._mock_response(401)
        with pytest.raises(ValueError, match="Invalid username or password"):
            authenticate_with_jellyfin("bad", "creds")

    @patch("backend.services.auth_service.httpx.post")
    def test_server_error_raises_connection_error(self, mock_post):
        mock_post.return_value = self._mock_response(500)
        with pytest.raises(ConnectionError):
            authenticate_with_jellyfin("user", "pass")

    @patch("backend.services.auth_service.httpx.post")
    def test_server_error_message_includes_status(self, mock_post):
        """Upstream 5xx should surface a clear message naming the status code,
        not a bare/opaque error."""
        mock_post.return_value = self._mock_response(500, text="DbUpdateConcurrencyException")
        with pytest.raises(ConnectionError, match="500"):
            authenticate_with_jellyfin("user", "pass")

    @patch("backend.services.auth_service.httpx.post")
    def test_network_error_raises_connection_error(self, mock_post):
        import httpx
        mock_post.side_effect = httpx.ConnectError("Connection refused")
        with pytest.raises(ConnectionError, match="Authentication service unavailable"):
            authenticate_with_jellyfin("user", "pass")
