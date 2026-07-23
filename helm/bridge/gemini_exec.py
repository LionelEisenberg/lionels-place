"""Gemini execution via google-genai, with the per-task waterfall + free-tier
quota/RPM ported from the Helm GeminiRouter (now backed by the worker-local store)."""

import base64
import json
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from google import genai
from google.genai.types import GenerateContentConfig, Part

import quota_store

_PRO = os.getenv("GEMINI_PRO_MODEL", "gemini-3.1-pro-preview")
_FLASH = os.getenv("GEMINI_FLASH_MODEL", "gemini-3.1-flash-preview")
_FLASH_3 = os.getenv("GEMINI_FLASH_3_MODEL", "gemini-3-flash-preview")
_FLASH_25 = os.getenv("GEMINI_FLASH_25_MODEL", "gemini-2.5-flash")
_FLASH_LITE = os.getenv("GEMINI_FLASH_LITE_MODEL", "gemini-3.1-flash-lite-preview")

WATERFALLS = {
    "parse_input": [("paid", _PRO), ("paid", _FLASH)],
    "plan_workout": [("free", _FLASH_3), ("free", _FLASH_25), ("free", _FLASH_LITE), ("paid", _FLASH)],
    "recipe_parse": [("free", _FLASH_3), ("free", _FLASH_25), ("paid", _FLASH), ("free", _FLASH_LITE)],
    "company_research": [("free", _FLASH_3), ("free", _FLASH_25), ("paid", _FLASH), ("free", _FLASH_LITE)],
    "chat": [("free", _FLASH_3), ("free", _FLASH_25), ("free", _FLASH_LITE), ("paid", _FLASH)],
    "ingredient_classify": [("free", _FLASH_LITE), ("free", _FLASH_3)],
    "leetcode_hint": [("free", _FLASH_LITE), ("free", _FLASH_3)],
}
_DEFAULT_WATERFALL = [("paid", _PRO), ("paid", _FLASH)]

MODEL_PRICING = {
    _PRO: (1.25, 10.0), _FLASH: (0.15, 0.60), _FLASH_3: (0.15, 0.60),
    _FLASH_25: (0.15, 0.60), _FLASH_LITE: (0.075, 0.30),
}
FREE_PROJECTS = ("free-tier-1", "free-tier-2")
_DAILY_LIMITS = {
    _FLASH_3: int(os.getenv("GEMINI_FREE_FLASH_3_LIMIT", "20")),
    _FLASH_25: int(os.getenv("GEMINI_FREE_FLASH_25_LIMIT", "20")),
    _FLASH_LITE: int(os.getenv("GEMINI_FREE_FLASH_LITE_LIMIT", "500")),
}
_RPM_DELAY = float(os.getenv("GEMINI_FREE_RPM_DELAY", "4"))

_clients: dict[str, object] = {}


def _client_for(project: str):
    """Lazily build/cache a genai client per project key."""
    if project not in _clients:
        key = {"paid": os.getenv("GEMINI_PAID_KEY", ""),
               "free-tier-1": os.getenv("GEMINI_FREE_KEY_1", ""),
               "free-tier-2": os.getenv("GEMINI_FREE_KEY_2", "")}.get(project, "")
        _clients[project] = genai.Client(api_key=key)
    return _clients[project]


def _has_client(project: str) -> bool:
    key = {"paid": "GEMINI_PAID_KEY", "free-tier-1": "GEMINI_FREE_KEY_1",
           "free-tier-2": "GEMINI_FREE_KEY_2"}.get(project)
    return bool(key and os.getenv(key))


def _today() -> str:
    return datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")


def _pick_free_project(date: str, model: str) -> str | None:
    limit = _DAILY_LIMITS.get(model)
    available = [p for p in FREE_PROJECTS if _has_client(p)
                 and (limit is None or quota_store.get_count(date, p, model) < limit)]
    if not available:
        return None
    available.sort(key=lambda p: quota_store.get_last_ts(p))
    picked = available[0]
    now = time.time()
    wait = _RPM_DELAY - (now - quota_store.get_last_ts(picked))
    if wait > 0:
        time.sleep(wait)
    return picked


def _is_retryable(e: Exception) -> bool:
    s = str(e).lower()
    return any(k in s for k in ("429", "resource_exhausted", "rate_limit", "quota", "503", "unavailable", "overloaded"))


def _build_contents(prompt: str, image_base64: str | None):
    if image_base64:
        return [prompt, Part.from_bytes(data=base64.b64decode(image_base64), mime_type="image/jpeg")]
    return prompt


def run_gemini(*, task_type: str, system_prompt: str, prompt: str, want_json: bool,
               image_base64: str | None, model: str | None) -> dict:
    """Route a Gemini call through the waterfall for task_type. Returns a normalized dict."""
    waterfall = WATERFALLS.get(task_type, _DEFAULT_WATERFALL)
    date = _today()
    contents = _build_contents(prompt, image_base64)
    config = GenerateContentConfig(
        system_instruction=system_prompt or None,
        response_mime_type="application/json" if want_json else None,
    )
    last_error = None
    for project_type, wf_model in waterfall:
        if project_type == "paid":
            if not _has_client("paid"):
                continue
            project = "paid"
        else:
            project = _pick_free_project(date, wf_model)
            if not project:
                continue
        try:
            start = time.time()
            resp = _client_for(project).models.generate_content(
                model=wf_model, contents=contents, config=config)
            latency_ms = int((time.time() - start) * 1000)
            usage = getattr(resp, "usage_metadata", None)
            pt = getattr(usage, "prompt_token_count", 0) or 0
            rt = getattr(usage, "candidates_token_count", 0) or 0
            tt = getattr(usage, "total_token_count", 0) or 0
            text = resp.text if hasattr(resp, "text") else ""
            json_valid = None
            if want_json and text:
                try:
                    json.loads(text); json_valid = True
                except (json.JSONDecodeError, ValueError):
                    json_valid = False
            pricing = MODEL_PRICING.get(wf_model, (0, 0))
            quota_store.increment(date, project, wf_model)
            if project in FREE_PROJECTS:
                quota_store.set_last_ts(project, time.time())
            return {
                "text": text or "", "model": wf_model,
                "prompt_tokens": pt, "response_tokens": rt, "total_tokens": tt,
                "latency_ms": latency_ms,
                "estimated_cost": (pt * pricing[0] + rt * pricing[1]) / 1_000_000,
                "json_valid": json_valid, "error": None,
            }
        except Exception as e:  # noqa: BLE001
            last_error = str(e)
            if _is_retryable(e):
                continue
            return {"text": "", "error": last_error}
    return {"text": "", "error": f"Gemini waterfall exhausted for {task_type}: {last_error}"}
