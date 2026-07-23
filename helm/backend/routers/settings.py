"""Admin-only settings API for runtime LLM configuration."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..services.settings_service import get_all_settings, set_setting, SETTINGS_SCHEMA

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_effort: str | None = None
    llm_fallback: str | None = None
    extras_enabled: bool | None = None


VALID_VALUES = {
    "llm_provider": ["claude", "gemini"],
    "llm_model": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
    "llm_effort": ["low", "medium", "high", "max"],
    "llm_fallback": ["", "gemini", "claude"],
}


def _require_admin(request: Request):
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")


@router.get("")
def get_settings(request: Request):
    _require_admin(request)
    settings = get_all_settings()
    return {
        "settings": settings,
        "options": VALID_VALUES,
    }


@router.put("")
def update_settings(body: SettingsUpdate, request: Request):
    _require_admin(request)
    updated = {}

    for key in SETTINGS_SCHEMA:
        value = getattr(body, key, None)
        if value is not None:
            valid = VALID_VALUES.get(key)
            if valid and value not in valid:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid value '{value}' for {key}. Valid: {valid}"
                )
            # Coerce booleans to the "true"/"false" string format used by HelmSetting storage
            if isinstance(value, bool):
                value = "true" if value else "false"
            set_setting(key, value)
            updated[key] = value

    return {"updated": updated, "settings": get_all_settings()}
