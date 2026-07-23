"""Tests for JWT auth middleware — route protection and role enforcement."""

import os
from unittest.mock import patch

os.environ["JWT_SECRET"] = "test-secret-key-for-unit-tests"

import pytest
from backend.auth import is_public_route, check_admin_override


class TestPublicRouteDetection:
    def test_login_is_public(self):
        assert is_public_route("/api/auth/login", "POST") is True

    def test_recipe_list_is_public(self):
        assert is_public_route("/api/recipes", "GET") is True

    def test_recipe_detail_is_public(self):
        assert is_public_route("/api/recipes/42", "GET") is True

    def test_recipe_photo_is_public(self):
        assert is_public_route("/api/recipes/42/photo", "GET") is True

    def test_recipe_tags_is_public(self):
        assert is_public_route("/api/recipes/tags", "GET") is True

    def test_recipe_scale_is_public(self):
        assert is_public_route("/api/recipes/42/scale", "GET") is True

    def test_recipe_post_is_protected(self):
        assert is_public_route("/api/recipes", "POST") is False

    def test_meals_is_protected(self):
        assert is_public_route("/api/meals", "GET") is False

    def test_parse_is_protected(self):
        assert is_public_route("/api/parse", "POST") is False

    def test_static_files_are_public(self):
        assert is_public_route("/assets/index.js", "GET") is True

    def test_options_is_public(self):
        assert is_public_route("/api/meals", "OPTIONS") is True

    def test_auth_me_is_protected(self):
        assert is_public_route("/api/auth/me", "GET") is False


class TestAdminOverride:
    def test_friend_upgraded_if_in_allowlist(self):
        with patch.dict(os.environ, {"HELM_ADMIN_USERS": "bob"}):
            assert check_admin_override("friend", "bob") == "admin"

    def test_friend_stays_friend_if_not_in_allowlist(self):
        with patch.dict(os.environ, {"HELM_ADMIN_USERS": "alice"}):
            assert check_admin_override("friend", "bob") == "friend"

    def test_admin_stays_admin(self):
        with patch.dict(os.environ, {"HELM_ADMIN_USERS": ""}):
            assert check_admin_override("admin", "lionel") == "admin"


class TestFriendAllowedRoutes:
    """Friend role should access cooking routes but not admin routes."""

    def test_recipes_is_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/recipes") is True

    def test_recipes_subpath_is_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/recipes/42/cook") is True

    def test_recipes_parse_url_is_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/recipes/parse-url") is True

    def test_shopping_list_is_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/shopping-list") is True

    def test_shopping_classify_is_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/shopping-list/classify") is True

    def test_auth_me_is_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/auth/me") is True

    def test_meals_not_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/meals") is False

    def test_parse_not_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/parse") is False

    def test_workouts_not_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/workouts") is False

    def test_daily_not_friend_allowed(self):
        from backend.auth import is_friend_allowed_route
        assert is_friend_allowed_route("/api/daily/today") is False
