"""
Runtime settings service — reads/writes HelmSetting table with in-memory cache.
Falls back to env vars for defaults.
"""

import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# In-memory cache — populated on first read, invalidated on write
_cache: dict[str, str] = {}
_loaded = False

# Settings schema: key → (env_var_name, default_value)
SETTINGS_SCHEMA = {
    "llm_provider": ("LLM_PROVIDER", "claude"),
    "llm_model": ("LLM_MODEL", "claude-opus-4-6"),
    "llm_effort": ("LLM_EFFORT", "high"),
    "llm_fallback": ("LLM_FALLBACK", ""),
    "extras_enabled": ("HELM_EXTRAS_ENABLED", "false"),
}


def _load_cache():
    """Load all settings from DB into cache."""
    global _cache, _loaded
    from ..database import SessionLocal
    from ..models import HelmSetting
    db = SessionLocal()
    try:
        rows = db.query(HelmSetting).all()
        _cache = {r.key: r.value for r in rows}
        _loaded = True
    finally:
        db.close()


def get_setting(key: str, default: Optional[str] = None) -> str:
    """Get a setting value. Priority: DB cache → env var → schema default → passed default."""
    global _loaded
    if not _loaded:
        try:
            _load_cache()
        except Exception:
            _loaded = True  # don't retry on DB errors

    # DB value
    if key in _cache:
        return _cache[key]

    # Env var fallback
    schema = SETTINGS_SCHEMA.get(key)
    if schema:
        env_val = os.getenv(schema[0])
        if env_val:
            return env_val
        return schema[1]  # schema default

    # Passed default
    return default or ""


def set_setting(key: str, value: str):
    """Write a setting to DB and update cache."""
    from ..database import SessionLocal
    from ..models import HelmSetting
    db = SessionLocal()
    try:
        existing = db.query(HelmSetting).filter_by(key=key).first()
        if existing:
            existing.value = value
        else:
            db.add(HelmSetting(key=key, value=value))
        db.commit()
        _cache[key] = value
        logger.info("Setting updated: %s = %s", key, value)
    finally:
        db.close()


def get_all_settings() -> dict[str, str]:
    """Return all settings with current values."""
    result = {}
    for key in SETTINGS_SCHEMA:
        result[key] = get_setting(key)
    return result
