"""Tests for settings service and settings router."""

import pytest
from unittest.mock import patch
from backend.models import HelmSetting


# ==========================================
# Settings Service — cache + DB + env fallback
# ==========================================

def _reset_settings_cache():
    from backend.services import settings_service
    settings_service._cache.clear()
    settings_service._loaded = False
    return settings_service


def test_get_setting_returns_db_value(db):
    """DB value takes priority over env var and default."""
    svc = _reset_settings_cache()

    db.add(HelmSetting(key="llm_provider", value="claude"))
    db.commit()

    with patch('backend.database.SessionLocal', return_value=db):
        svc._load_cache()
    assert svc.get_setting("llm_provider") == "claude"


def test_get_setting_falls_back_to_env(db):
    """When no DB value, fall back to env var."""
    svc = _reset_settings_cache()

    with patch('backend.database.SessionLocal', return_value=db):
        svc._load_cache()
    with patch.dict('os.environ', {'LLM_PROVIDER': 'claude'}):
        assert svc.get_setting("llm_provider") == "claude"


def test_get_setting_falls_back_to_schema_default(db):
    """When no DB value and no env var, use schema default."""
    svc = _reset_settings_cache()

    with patch('backend.database.SessionLocal', return_value=db):
        svc._load_cache()
    with patch.dict('os.environ', {}, clear=True):
        assert svc.get_setting("llm_provider") == "claude"


def test_set_setting_updates_cache(db):
    """set_setting writes to DB and updates in-memory cache."""
    svc = _reset_settings_cache()
    svc._loaded = True

    with patch('backend.database.SessionLocal', return_value=db):
        svc.set_setting("llm_provider", "claude")

    assert svc._cache["llm_provider"] == "claude"
    row = db.query(HelmSetting).filter_by(key="llm_provider").first()
    assert row.value == "claude"


def test_set_setting_overwrites_existing(db):
    """set_setting updates existing row, doesn't create duplicate."""
    svc = _reset_settings_cache()
    svc._loaded = True

    db.add(HelmSetting(key="claude_effort", value="high"))
    db.commit()

    with patch('backend.database.SessionLocal', return_value=db):
        svc.set_setting("claude_effort", "low")

    assert svc._cache["claude_effort"] == "low"
    count = db.query(HelmSetting).filter_by(key="claude_effort").count()
    assert count == 1


def test_get_all_settings_returns_all_keys(db):
    """get_all_settings returns every key in SETTINGS_SCHEMA."""
    svc = _reset_settings_cache()

    with patch('backend.database.SessionLocal', return_value=db):
        svc._load_cache()
    result = svc.get_all_settings()

    assert "llm_provider" in result
    assert "llm_effort" in result


def test_settings_schema_includes_extras_enabled():
    """SETTINGS_SCHEMA must include extras_enabled with env var HELM_EXTRAS_ENABLED and default 'false'."""
    from backend.services.settings_service import SETTINGS_SCHEMA
    assert "extras_enabled" in SETTINGS_SCHEMA
    env_var, default = SETTINGS_SCHEMA["extras_enabled"]
    assert env_var == "HELM_EXTRAS_ENABLED"
    assert default == "false"


# ==========================================
# Settings Router — admin enforcement + validation
# ==========================================

def test_settings_requires_admin():
    """Non-admin users get 403."""
    from backend.routers.settings import _require_admin
    from fastapi import HTTPException
    from unittest.mock import MagicMock

    request = MagicMock()
    request.state.user = {"role": "friend", "username": "bob"}
    with pytest.raises(HTTPException) as exc_info:
        _require_admin(request)
    assert exc_info.value.status_code == 403


def test_settings_allows_admin():
    """Admin users pass the check."""
    from backend.routers.settings import _require_admin
    from unittest.mock import MagicMock

    request = MagicMock()
    request.state.user = {"role": "admin", "username": "lionel"}
    _require_admin(request)  # should not raise


def test_settings_rejects_no_user():
    """Unauthenticated requests get 403."""
    from backend.routers.settings import _require_admin
    from fastapi import HTTPException
    from unittest.mock import MagicMock

    request = MagicMock()
    request.state = MagicMock(spec=[])  # no .user attribute
    with pytest.raises(HTTPException) as exc_info:
        _require_admin(request)
    assert exc_info.value.status_code == 403


def test_settings_validates_llm_provider():
    """Invalid provider value is rejected."""
    from backend.routers.settings import VALID_VALUES
    assert "gemini" in VALID_VALUES["llm_provider"]
    assert "claude" in VALID_VALUES["llm_provider"]
    assert "openai" not in VALID_VALUES["llm_provider"]


def test_settings_validates_effort():
    """Invalid effort value is rejected."""
    from backend.routers.settings import VALID_VALUES
    assert "low" in VALID_VALUES["llm_effort"]
    assert "max" in VALID_VALUES["llm_effort"]
    assert "turbo" not in VALID_VALUES["llm_effort"]


def test_settings_update_accepts_extras_enabled():
    """SettingsUpdate model must accept extras_enabled as optional bool."""
    from backend.routers.settings import SettingsUpdate

    body_true = SettingsUpdate(extras_enabled=True)
    assert body_true.extras_enabled is True

    body_false = SettingsUpdate(extras_enabled=False)
    assert body_false.extras_enabled is False

    body_omitted = SettingsUpdate()
    assert body_omitted.extras_enabled is None


def test_settings_update_coerces_extras_enabled_to_string(db):
    """PUT /api/settings stores extras_enabled as the string 'true' or 'false'."""
    from unittest.mock import patch, MagicMock
    from backend.routers.settings import update_settings, SettingsUpdate
    from backend.services import settings_service

    settings_service._cache.clear()
    settings_service._loaded = True

    request = MagicMock()
    request.state.user = {"role": "admin", "username": "lionel"}

    with patch('backend.database.SessionLocal', return_value=db):
        result = update_settings(SettingsUpdate(extras_enabled=True), request)

    from backend.models import HelmSetting
    row = db.query(HelmSetting).filter_by(key="extras_enabled").first()
    assert row is not None
    assert row.value == "true"
    assert result["updated"]["extras_enabled"] == "true"


def test_settings_update_coerces_extras_enabled_false(db):
    """extras_enabled=False stores as 'false'."""
    from unittest.mock import patch, MagicMock
    from backend.routers.settings import update_settings, SettingsUpdate
    from backend.services import settings_service

    settings_service._cache.clear()
    settings_service._loaded = True

    request = MagicMock()
    request.state.user = {"role": "admin", "username": "lionel"}

    with patch('backend.database.SessionLocal', return_value=db):
        update_settings(SettingsUpdate(extras_enabled=False), request)

    from backend.models import HelmSetting
    row = db.query(HelmSetting).filter_by(key="extras_enabled").first()
    assert row.value == "false"


# ==========================================
# Task 7: Config generalization
# ==========================================

def test_settings_schema_generic_keys():
    from backend.services.settings_service import SETTINGS_SCHEMA
    assert SETTINGS_SCHEMA["llm_provider"][1] == "claude"   # default flipped
    assert "llm_model" in SETTINGS_SCHEMA
    assert "llm_effort" in SETTINGS_SCHEMA
    assert SETTINGS_SCHEMA["llm_fallback"][1] == ""          # off by default
    assert "claude_model" not in SETTINGS_SCHEMA
    assert "claude_effort" not in SETTINGS_SCHEMA


def test_helmsetting_key_migration(db, monkeypatch):
    """claude_model/claude_effort rows are renamed to llm_model/llm_effort."""
    from backend.models import HelmSetting
    from backend import database as dbmod
    db.add(HelmSetting(key="claude_model", value="claude-sonnet-4-6"))
    db.add(HelmSetting(key="claude_effort", value="max"))
    db.commit()

    dbmod.migrate_llm_setting_keys(db)

    keys = {r.key: r.value for r in db.query(HelmSetting).all()}
    assert keys.get("llm_model") == "claude-sonnet-4-6"
    assert keys.get("llm_effort") == "max"
    assert "claude_model" not in keys
    assert "claude_effort" not in keys
