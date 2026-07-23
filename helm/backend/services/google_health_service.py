"""Google Health API OAuth 2.0 connection, token lifecycle, and heartbeat sync.

The ONLY module that talks to Google. Config comes from env (immutable secrets);
connection state lives in the oauth_credentials table.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
from collections import defaultdict
from datetime import datetime, timedelta, date
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet
from sqlalchemy.orm import Session

from ..models import (
    OAuthCredential, OAuthState, DailyHealth, IntradayHeartRate, DailySummary,
    WorkoutSession, RunDetail, Activity, Workout,
)
from . import tcx_parser
from . import activity_service
from .activity_taxonomy import RUN_TYPES, ACTIVITY_GOOGLE_TYPES, google_session_activity
from .burn import TRACKER_BURN_FACTOR, credited_burn   # re-exported for the read path / tests

logger = logging.getLogger(__name__)

PROVIDER = "google_health"

AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke"
HEALTH_API_BASE = "https://health.googleapis.com/v4"

# Read-only Google Health API scopes (confirmed against the GCP console scope picker).
# Least-privilege: only the reads for metrics we consume — location.readonly is included
# for per-exercise TCX (GPS route) export, but no write/nutrition/profile/settings/ecg
# scopes, and never cloud-platform.
SCOPES = [
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
    "https://www.googleapis.com/auth/googlehealth.irn.readonly",
    "https://www.googleapis.com/auth/googlehealth.location.readonly",  # per-exercise TCX (GPS route)
]

REQUIRED_ENV = (
    "GOOGLE_HEALTH_CLIENT_ID",
    "GOOGLE_HEALTH_CLIENT_SECRET",
    "GOOGLE_HEALTH_REDIRECT_URI",
    "OAUTH_ENCRYPTION_KEY",
)

ACCESS_TOKEN_REFRESH_MARGIN = timedelta(minutes=5)
STATE_TTL = timedelta(minutes=10)
HTTP_TIMEOUT = 15.0

DEFAULT_START_DATE = date(2026, 6, 2)   # owner began wearing the Fitbit


def _start_date() -> date:
    raw = os.getenv("GOOGLE_HEALTH_START_DATE", "")
    if raw:
        try:
            return date.fromisoformat(raw)
        except ValueError:
            logger.warning("Invalid GOOGLE_HEALTH_START_DATE=%r; using default", raw)
    return DEFAULT_START_DATE


def _helm_date(d: date) -> str:
    """Helm's canonical date string — YYYY-MM-DD, matching DailySummary.date."""
    return d.strftime("%Y-%m-%d")


def _sync_range(last_synced: date | None, today: date) -> tuple[date, date]:
    """Date range to fetch: from the day after last sync (minus 1 to catch late
    data), clamped to never precede the configured start date; through today."""
    start = _start_date()
    if last_synced is not None:
        start = max(start, last_synced - timedelta(days=1))
    if start > today:
        start = today
    return start, today


class ReconsentRequired(Exception):
    """Raised when the refresh token is no longer valid and the user must reconnect."""


# --------------------------------------------------------------------------- config
def _client_id() -> str:
    return os.getenv("GOOGLE_HEALTH_CLIENT_ID", "")


def _client_secret() -> str:
    return os.getenv("GOOGLE_HEALTH_CLIENT_SECRET", "")


def _redirect_uri() -> str:
    return os.getenv("GOOGLE_HEALTH_REDIRECT_URI", "")


def is_configured() -> bool:
    """True when all required OAuth env vars are present."""
    return all(os.getenv(k) for k in REQUIRED_ENV)


# --------------------------------------------------------------------------- crypto
def _get_fernet() -> Fernet:
    key = os.getenv("OAUTH_ENCRYPTION_KEY", "")
    if not key:
        raise RuntimeError("OAUTH_ENCRYPTION_KEY is not set")
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt(plaintext: str) -> str:
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    return _get_fernet().decrypt(ciphertext.encode()).decode()


# ----------------------------------------------------------------------------- PKCE
def _generate_pkce() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) using S256."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def _purge_expired_states(db: Session) -> None:
    db.query(OAuthState).filter(OAuthState.expires_at < datetime.utcnow()).delete()
    db.commit()


def create_oauth_state(db: Session, user_id: int | None) -> tuple[str, str]:
    """Persist a one-time state + PKCE verifier. Returns (state, code_challenge)."""
    _purge_expired_states(db)
    state = secrets.token_urlsafe(32)
    verifier, challenge = _generate_pkce()
    db.add(OAuthState(
        state=state,
        code_verifier=verifier,
        user_id=user_id,
        expires_at=datetime.utcnow() + STATE_TTL,
    ))
    db.commit()
    return state, challenge


def consume_oauth_state(db: Session, state: str) -> tuple[str, int | None]:
    """Look up + delete a state row. Returns (code_verifier, user_id).
    Raises ValueError if the state is unknown or expired."""
    row = db.query(OAuthState).filter(OAuthState.state == state).first()
    if row is None:
        raise ValueError("Unknown OAuth state")
    code_verifier = row.code_verifier
    user_id = row.user_id
    expires_at = row.expires_at
    db.delete(row)
    db.commit()
    if expires_at < datetime.utcnow():
        raise ValueError("Expired OAuth state")
    return code_verifier, user_id


# ------------------------------------------------------------------------ authorize
def build_authorize_url(state: str, code_challenge: str) -> str:
    params = {
        "client_id": _client_id(),
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        # Avoid include_granted_scopes=true / legacy fitness.* scopes (Google Health guidance).
        "include_granted_scopes": "false",
    }
    return f"{AUTHORIZE_ENDPOINT}?{urlencode(params)}"


# --------------------------------------------------------------------------- tokens
def _upsert_credential(db: Session, *, user_id: int | None, refresh_token: str,
                       access_token: str | None, expires_in, scopes: str | None) -> OAuthCredential:
    cred = db.query(OAuthCredential).filter(OAuthCredential.provider == PROVIDER).first()
    if cred is None:
        cred = OAuthCredential(provider=PROVIDER, refresh_token_enc=encrypt(refresh_token))
        db.add(cred)
    else:
        cred.refresh_token_enc = encrypt(refresh_token)
    cred.user_id = user_id
    if access_token:
        cred.access_token_enc = encrypt(access_token)
        cred.access_token_expires_at = datetime.utcnow() + timedelta(seconds=int(expires_in or 3600))
    if scopes:
        cred.scopes = scopes
    cred.status = "connected"
    cred.last_error = None
    db.commit()
    db.refresh(cred)
    return cred


def exchange_code(db: Session, code: str, code_verifier: str, user_id: int | None) -> OAuthCredential:
    resp = httpx.post(TOKEN_ENDPOINT, data={
        "code": code,
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "redirect_uri": _redirect_uri(),
        "code_verifier": code_verifier,
        "grant_type": "authorization_code",
    }, timeout=HTTP_TIMEOUT)
    if resp.status_code != 200:
        logger.error("Google token exchange failed: %s %s", resp.status_code, resp.text)
        raise ValueError("Token exchange failed")
    data = resp.json()
    return _upsert_credential(
        db,
        user_id=user_id,
        refresh_token=data["refresh_token"],
        access_token=data.get("access_token"),
        expires_in=data.get("expires_in"),
        scopes=data.get("scope"),
    )


def refresh_access_token(db: Session, cred: OAuthCredential) -> str:
    refresh_token = decrypt(cred.refresh_token_enc)
    resp = httpx.post(TOKEN_ENDPOINT, data={
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }, timeout=HTTP_TIMEOUT)
    if resp.status_code == 400 and "invalid_grant" in resp.text:
        cred.status = "needs_reconsent"
        cred.last_error = "Refresh token rejected (invalid_grant) — reconnect required"
        db.commit()
        raise ReconsentRequired("Google refresh token rejected; reconnect required")
    if resp.status_code != 200:
        logger.error("Google token refresh failed: %s %s", resp.status_code, resp.text)
        raise RuntimeError("Token refresh failed")
    data = resp.json()
    access_token = data["access_token"]
    cred.access_token_enc = encrypt(access_token)
    cred.access_token_expires_at = datetime.utcnow() + timedelta(seconds=int(data.get("expires_in", 3600)))
    if data.get("refresh_token"):
        cred.refresh_token_enc = encrypt(data["refresh_token"])  # rotated
    cred.status = "connected"
    db.commit()
    return access_token


def get_valid_access_token(db: Session) -> str:
    """Single chokepoint for a usable bearer token. Refreshes if stale.
    Raises ValueError if not connected, ReconsentRequired if the refresh token died."""
    cred = (
        db.query(OAuthCredential)
        .filter(OAuthCredential.provider == PROVIDER, OAuthCredential.status == "connected")
        .first()
    )
    if cred is None:
        raise ValueError("Not connected")
    fresh = (
        cred.access_token_enc
        and cred.access_token_expires_at
        and (cred.access_token_expires_at - datetime.utcnow()) > ACCESS_TOKEN_REFRESH_MARGIN
    )
    if fresh:
        return decrypt(cred.access_token_enc)
    return refresh_access_token(db, cred)


# ------------------------------------------------------------------------- heartbeat
def _fetch_steps_today(access_token: str) -> int | None:
    """Heartbeat: fetch the most recent daily step rollup to confirm an
    authenticated Google Health API read works end-to-end. Full metric ingestion
    (all data types -> Helm tables) is a separate spec.

    API: POST /v4/users/me/dataTypes/steps/dataPoints:dailyRollUp with a civil-time
    range; response is {"rollupDataPoints": [{"civilEndTime": {...}, "steps": {"count_sum": N}}]}.
    """
    today = datetime.utcnow().date()
    start = today - timedelta(days=2)
    end = today + timedelta(days=1)
    body = {
        "range": {
            "start": {"date": {"year": start.year, "month": start.month, "day": start.day}},
            "end": {"date": {"year": end.year, "month": end.month, "day": end.day}},
        },
        "windowSizeDays": 1,
    }
    resp = httpx.post(
        f"{HEALTH_API_BASE}/users/me/dataTypes/steps/dataPoints:dailyRollUp",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        json=body,
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    latest_count = None
    latest_key = None
    for point in data.get("rollupDataPoints", []):
        count = (point.get("steps") or {}).get("countSum")  # int64 -> JSON string
        if count is None:
            continue
        ce = (point.get("civilEndTime") or point.get("civilStartTime") or {}).get("date") or {}
        key = (ce.get("year", 0), ce.get("month", 0), ce.get("day", 0))
        if latest_key is None or key > latest_key:
            latest_key, latest_count = key, count
    return int(latest_count) if latest_count is not None else None


# data_type -> (response object key, numeric field). Pinned against the live API.
_DAILY_POINT_TYPES = {
    "daily-resting-heart-rate": ("dailyRestingHeartRate", "beatsPerMinute"),
    "daily-heart-rate-variability": ("dailyHeartRateVariability", "averageHeartRateVariabilityMilliseconds"),
    "daily-respiratory-rate": ("dailyRespiratoryRate", "breathsPerMinute"),
}


def _civil_body(start: date, end: date, window_days: int | None = None) -> dict:
    body = {"range": {
        "start": {"date": {"year": start.year, "month": start.month, "day": start.day}},
        "end": {"date": {"year": end.year, "month": end.month, "day": end.day}},
    }}
    if window_days:
        body["windowSizeDays"] = window_days
    return body


def _post(access_token: str, path: str, body: dict) -> dict:
    resp = httpx.post(
        f"{HEALTH_API_BASE}/users/me/dataTypes/{path}",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        json=body, timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def _get(access_token: str, path: str, params: dict | None = None) -> dict:
    resp = httpx.get(
        f"{HEALTH_API_BASE}/users/me/dataTypes/{path}",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        params=params, timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def _ymd_to_helm(d: dict) -> str:
    return _helm_date(date(d["year"], d["month"], d["day"]))


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _local_dt(iso: str, utc_offset: str | None) -> datetime:
    """UTC ISO + a '<seconds>s' offset → naive local datetime."""
    secs = int((utc_offset or "0s").rstrip("s"))
    return (_parse_iso(iso) + timedelta(seconds=secs)).replace(tzinfo=None)


def _fetch_step_rollup(access_token: str, start: date, end: date) -> dict[str, int]:
    data = _post(access_token, "steps/dataPoints:dailyRollUp",
                 _civil_body(start, end + timedelta(days=1), window_days=1))
    out: dict[str, int] = {}
    for p in data.get("rollupDataPoints", []):
        # A 1-day rollup window is dated by its START day; civilEndTime is the
        # exclusive next-day boundary, so using it would shift every day's steps +1.
        cs = (p.get("civilStartTime") or {}).get("date") or {}
        count = (p.get("steps") or {}).get("countSum")
        if cs.get("year") and cs.get("month") and cs.get("day") and count is not None:
            out[_helm_date(date(cs["year"], cs["month"], cs["day"]))] = int(count)
    return out


def _fetch_daily_points(access_token: str, data_type: str, start: date, end: date) -> dict[str, float]:
    if data_type not in _DAILY_POINT_TYPES:
        raise ValueError(f"Unknown data_type: {data_type!r}")
    obj_key, val_key = _DAILY_POINT_TYPES[data_type]
    data = _get(access_token, f"{data_type}/dataPoints")
    out: dict[str, float] = {}
    for p in data.get("dataPoints", []):
        obj = p.get(obj_key) or {}
        d = obj.get("date")
        v = obj.get(val_key)
        if not d or v is None:
            continue
        if start <= date(d["year"], d["month"], d["day"]) <= end:
            out[_ymd_to_helm(d)] = float(v)
    return out


def _fetch_intraday_hr(access_token: str, day: date) -> dict | None:
    """Page through heart-rate samples (reverse-chron, no server-side filter) and
    collect the target day's samples as {t:'HH:MM', bpm:int} points."""
    points: list[dict] = []
    page_token = None
    for _ in range(40):  # safety cap
        params = {"pageSize": "1000"}
        if page_token:
            params["pageToken"] = page_token
        data = _get(access_token, "heart-rate/dataPoints", params)
        batch = data.get("dataPoints", [])
        passed_day = False
        for p in batch:
            hr = p.get("heartRate") or {}
            bpm = hr.get("beatsPerMinute")
            ct = (hr.get("sampleTime") or {}).get("civilTime") or {}
            cd = ct.get("date") or {}
            if bpm is None or not cd:
                continue
            pd = date(cd["year"], cd["month"], cd["day"])
            if pd == day:
                tm = ct.get("time") or {}
                points.append({"t": f"{int(tm.get('hours', 0)):02d}:{int(tm.get('minutes', 0)):02d}",
                               "bpm": int(round(float(bpm)))})
            elif pd < day:
                passed_day = True  # reverse-chron: we've gone past the target day
        page_token = data.get("nextPageToken")
        if passed_day or not page_token or not batch:
            break
    if not points:
        return None
    bpms = [p["bpm"] for p in points]  # true extremes from all raw samples
    # Fitbit samples sub-minute (~29k/day); downsample to one averaged point per minute.
    by_min: dict[str, list[int]] = {}
    for p in points:
        by_min.setdefault(p["t"], []).append(p["bpm"])
    dpoints = [{"t": t, "bpm": int(round(sum(v) / len(v)))} for t, v in sorted(by_min.items())]
    return {"points": dpoints, "min_bpm": min(bpms), "max_bpm": max(bpms),
            "avg_bpm": int(round(sum(bpms) / len(bpms)))}


def _fetch_sleep(access_token: str, start: date, end: date) -> dict[str, dict]:
    data = _get(access_token, "sleep/dataPoints")
    out: dict[str, dict] = {}
    for p in data.get("dataPoints", []):
        s = p.get("sleep") or {}
        iv = s.get("interval") or {}
        if not (iv.get("startTime") and iv.get("endTime")):
            continue
        bed = _local_dt(iv["startTime"], iv.get("startUtcOffset"))
        wake = _local_dt(iv["endTime"], iv.get("endUtcOffset"))
        day = wake.date()
        if not (start <= day <= end):
            continue
        mins = {"DEEP": 0.0, "LIGHT": 0.0, "REM": 0.0, "AWAKE": 0.0}
        for st in s.get("stages", []):
            t = (st.get("type") or "").upper()
            if t in mins and st.get("startTime") and st.get("endTime"):
                mins[t] += (_parse_iso(st["endTime"]) - _parse_iso(st["startTime"])).total_seconds() / 60
        asleep = mins["DEEP"] + mins["LIGHT"] + mins["REM"]
        out[_helm_date(day)] = {
            "hours": round(asleep / 60, 2),
            "bedtime": bed.strftime("%H:%M"), "waketime": wake.strftime("%H:%M"),
            "deep_min": int(round(mins["DEEP"])), "light_min": int(round(mins["LIGHT"])),
            "rem_min": int(round(mins["REM"])), "awake_min": int(round(mins["AWAKE"])),
            "efficiency": None,
        }
    return out


# ----------------------------------------------------------------- workout sessions
# Google `exercise` data-type ingestion. Each activity is its own data point with a
# type, time interval, and a metricsSummary. Shapes pinned against the live Fitbit
# data (read-only discovery dump): times mirror the sleep interval shape; numeric
# fields (HR, distance) live under metricsSummary; `name` is the stable datapoint id.

_EBIKE_TYPES = {"ELECTRIC_BIKE"}   # owner excludes e-bike "workouts"
_SWIM_TYPES = ACTIVITY_GOOGLE_TYPES["swim"]

LOCATION_SCOPE = "https://www.googleapis.com/auth/googlehealth.location.readonly"


def has_location_scope(cred) -> bool:
    """Whether the stored grant includes the route (location) scope."""
    return bool(cred is not None and cred.scopes and LOCATION_SCOPE in (cred.scopes or "").split())

# raw exerciseType -> coarse category. Unknown types fall back to "other".
_EXERCISE_CATEGORY = {
    "STRENGTH_TRAINING": "strength", "WEIGHTLIFTING": "strength", "WORKOUT": "strength",
    "SWIMMING_POOL": "cardio", "SWIMMING": "cardio", "OPEN_WATER_SWIM": "cardio",
    "RUNNING": "cardio", "TREADMILL_RUNNING": "cardio", "WALKING": "cardio",
    "HIKING": "cardio", "BIKING": "cardio", "MOUNTAIN_BIKING": "cardio",
    "ROAD_BIKING": "cardio", "SPINNING": "cardio", "ELLIPTICAL": "cardio",
    "ROWING": "cardio", "CARDIO_WORKOUT": "cardio", "STAIR_CLIMBING": "cardio",
}


def _parse_seconds(raw: str | None) -> float | None:
    """Google durations look like '4174.615s'. Return the float seconds, or None."""
    if not raw:
        return None
    try:
        return float(str(raw).rstrip("s"))
    except ValueError:
        return None


def _to_float(raw) -> float | None:
    """Numeric metricsSummary field (number OR quoted int64 string) -> float, else None."""
    if raw is None:
        return None
    try:
        return float(raw)
    except (ValueError, TypeError):
        return None


def _parse_exercise_session(point: dict) -> dict | None:
    """Normalize one `exercise` data point into a workout_session row dict.

    Returns None for e-bike sessions (filtered out) or points missing a time interval.
    """
    ex = point.get("exercise") or {}
    raw = ex.get("exerciseType") or ""
    if raw in _EBIKE_TYPES:
        return None
    iv = ex.get("interval") or {}
    if not (iv.get("startTime") and iv.get("endTime")):
        return None
    start = _local_dt(iv["startTime"], iv.get("startUtcOffset")).replace(microsecond=0)
    end = _local_dt(iv["endTime"], iv.get("endUtcOffset")).replace(microsecond=0)

    category = _EXERCISE_CATEGORY.get(raw, "other")
    ms = ex.get("metricsSummary") or {}

    avg_hr = None
    raw_hr = ms.get("averageHeartRateBeatsPerMinute")
    if raw_hr is not None:
        try:
            avg_hr = int(round(float(raw_hr)))
        except (ValueError, TypeError):
            avg_hr = None

    calories = _to_float(ms.get("caloriesKcal"))
    elev_mm = _to_float(ms.get("elevationGainMillimeters"))
    pace_s_per_m = _to_float(ms.get("averagePaceSecondsPerMeter"))
    cadence = _to_float((ms.get("mobilityMetrics") or {}).get("avgCadenceStepsPerMinute"))

    # Distance only for land cardio (run/walk/bike). Swim distance is unreliable on
    # Fitbit (needs pool length); strength/other activities carry none.
    distance_m = None
    mm = ms.get("distanceMillimeters")
    if category == "cardio" and raw not in _SWIM_TYPES and mm is not None:
        try:
            distance_m = round(float(mm) / 1000.0, 1)
        except (ValueError, TypeError):
            distance_m = None

    dur_s = _parse_seconds(ex.get("activeDuration"))
    if dur_s is None:
        dur_s = (end - start).total_seconds()
    duration_min = round(dur_s / 60.0, 2)

    label = ex.get("displayName") or raw.replace("_", " ").title()

    return {
        "google_id": point.get("name"),
        "date": _helm_date(start.date()),
        "exercise_type": label,
        "exercise_type_raw": raw,
        "category": category,
        "start_time": start.isoformat(),
        "end_time": end.isoformat(),
        "duration_min": duration_min,
        "distance_m": distance_m,
        "avg_hr": avg_hr,
        "max_hr": None,
        "calories_kcal": calories,
        "elevation_gain_m": round(elev_mm / 1000.0, 1) if elev_mm is not None else None,
        "avg_cadence_spm": int(round(cadence)) if cadence is not None else None,
        "avg_pace_s_per_km": round(pace_s_per_m * 1000.0, 1) if pace_s_per_m is not None else None,
        "start_utc": iv.get("startTime"),
        "end_utc": iv.get("endTime"),
        "platform": (point.get("dataSource") or {}).get("platform"),   # FITBIT | HEALTH_CONNECT | …
    }


def _session_local_date(point: dict) -> date | None:
    """Local start date of a raw exercise point (used for paging stop decisions,
    independent of the e-bike filter so an all-e-bike page can't halt paging early)."""
    iv = ((point.get("exercise") or {}).get("interval")) or {}
    if not iv.get("startTime"):
        return None
    try:
        return _local_dt(iv["startTime"], iv.get("startUtcOffset")).date()
    except Exception:
        return None


def _fetch_exercise_sessions(access_token: str, start: date, end: date) -> list[dict]:
    """Page through `exercise` data points (reverse-chron), parse each, and keep
    those whose LOCAL start date falls in [start, end]. E-bike sessions are dropped
    by the parser. Stops early once a page's oldest point predates `start`."""
    out: list[dict] = []
    page_token = None
    for _ in range(40):  # safety cap
        params = {"pageSize": "100"}
        if page_token:
            params["pageToken"] = page_token
        data = _get(access_token, "exercise/dataPoints", params)
        batch = data.get("dataPoints", [])
        for pt in batch:
            parsed = _parse_exercise_session(pt)
            if parsed is None:
                continue
            d = date.fromisoformat(parsed["date"])
            if start <= d <= end:
                out.append(parsed)
        oldest = _session_local_date(batch[-1]) if batch else None
        page_token = data.get("nextPageToken")
        if not page_token or not batch or (oldest is not None and oldest < start):
            break
    return out


def _upsert_workout_session(db: Session, parsed: dict) -> WorkoutSession:
    """Idempotent upsert of one parsed session. Keyed by the stable Google datapoint
    id when present, else by the natural (date, type, start_time) tuple."""
    row = None
    gid = parsed.get("google_id")
    if gid:
        row = db.query(WorkoutSession).filter(WorkoutSession.google_id == gid).first()
    else:
        row = db.query(WorkoutSession).filter(
            WorkoutSession.date == parsed["date"],
            WorkoutSession.exercise_type_raw == parsed["exercise_type_raw"],
            WorkoutSession.start_time == parsed["start_time"],
        ).first()
    if row is None:
        row = WorkoutSession()
        db.add(row)
    for k, v in parsed.items():
        setattr(row, k, v)
    row.synced_at = datetime.utcnow()
    db.flush()          # callers link by row.id
    return row


def slice_hr_window(points: list[dict], start: str, end: str) -> dict | None:
    """Slice a day's intraday HR points (each {t:'HH:MM', bpm}) to [start, end]
    inclusive. Returns {points, min_bpm, avg_bpm, max_bpm}, or None if the window
    contains no samples. Powers the per-session in-window HR curve."""
    sel = [p for p in points if start <= p["t"] <= end]
    if not sel:
        return None
    bpms = [p["bpm"] for p in sel]
    return {
        "points": sel,
        "min_bpm": min(bpms),
        "max_bpm": max(bpms),
        "avg_bpm": int(round(sum(bpms) / len(bpms))),
    }


def fetch_session_hr_window(access_token: str, start_utc: str, end_utc: str) -> dict | None:
    """Native-resolution HR for [start_utc, end_utc) fetched directly from Google via a
    physical-time filter — bypasses the downsampled/often-incomplete daily curve, so it
    works for any past session. Fitbit records ~1 sample / 2s during a workout, and we
    keep every one at HH:MM:SS resolution (no downsampling) so the panel curve is as fine
    as the source. Returns {points, min_bpm, avg_bpm, max_bpm, per_minute} or None."""
    flt = (f'heart_rate.sample_time.physical_time >= "{start_utc}" '
           f'AND heart_rate.sample_time.physical_time < "{end_utc}"')
    triples: list = []  # (physicalTime, "HH:MM:SS", bpm)
    page_token = None
    for _ in range(20):  # ~1k samples/page; 20 pages covers multi-hour sessions at 1-2s cadence
        params = {"pageSize": "1000", "filter": flt}
        if page_token:
            params["pageToken"] = page_token
        data = _get(access_token, "heart-rate/dataPoints", params)
        for p in data.get("dataPoints", []):
            hr = p.get("heartRate") or {}
            bpm = hr.get("beatsPerMinute")
            if bpm is None:
                continue
            st = hr.get("sampleTime") or {}
            tm = ((st.get("civilTime") or {}).get("time")) or {}
            label = (f"{int(tm.get('hours', 0)):02d}:{int(tm.get('minutes', 0)):02d}:"
                     f"{int(tm.get('seconds', 0)):02d}")
            triples.append((st.get("physicalTime") or label, label, int(round(float(bpm)))))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    if not triples:
        return None
    triples.sort(key=lambda x: x[0])
    bpms = [b for _, _, b in triples]
    per_minute: dict = {}
    for _, label, b in triples:
        per_minute.setdefault(label[:5], []).append(b)  # minute bucket (for zone joins)
    return {
        "points": [{"t": t, "bpm": b} for _, t, b in triples],  # native — every raw sample
        "min_bpm": min(bpms),
        "max_bpm": max(bpms),
        "avg_bpm": int(round(sum(bpms) / len(bpms))),
        "per_minute": {k: sum(v) / len(v) for k, v in per_minute.items()},
    }


_ZONE_KEYMAP = {"FAT_BURN": "fat_burn", "CARDIO": "cardio", "PEAK": "peak"}


def derive_zones(azm: dict, per_minute: dict) -> dict | None:
    """Recover personalized HR-zone floors (bpm) by joining Google's per-minute zone
    labels (active-zone-minutes) with that minute's HR. A zone's floor = the lowest HR
    Google still counted in it ≈ the zone threshold. Returns {fat_burn?, cardio?, peak?}
    for zones present, else None."""
    by_zone: dict = {}
    for label, zone in azm.items():
        if label in per_minute:
            by_zone.setdefault(zone, []).append(per_minute[label])
    out = {key: int(round(min(by_zone[gz]))) for gz, key in _ZONE_KEYMAP.items() if by_zone.get(gz)}
    return out or None


def fetch_session_zones(access_token: str, start_utc: str, end_utc: str, per_minute: dict) -> dict | None:
    """Fetch the window's active-zone-minutes (Google's per-minute zone labels) and
    derive the user's actual zone floors by joining with `per_minute` HR."""
    flt = (f'active_zone_minutes.interval.start_time >= "{start_utc}" '
           f'AND active_zone_minutes.interval.start_time < "{end_utc}"')
    azm: dict = {}
    page_token = None
    for _ in range(5):
        params = {"pageSize": "1000", "filter": flt}
        if page_token:
            params["pageToken"] = page_token
        data = _get(access_token, "active-zone-minutes/dataPoints", params)
        for p in data.get("dataPoints", []):
            a = p.get("activeZoneMinutes") or {}
            zone = a.get("heartRateZone")
            t = ((a.get("interval") or {}).get("civilStartTime") or {}).get("time") or {}
            if zone:
                azm[f"{int(t.get('hours', 0)):02d}:{int(t.get('minutes', 0)):02d}"] = zone
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return derive_zones(azm, per_minute)


# --------------------------------------------------------------------- run details
def _fetch_exercise_tcx(access_token: str, google_id: str) -> str:
    """Raw TCX for one exercise datapoint. google_id may be a bare datapoint id or a
    full resource name — only the last path segment is used. partialData=true keeps
    distance/HR trackpoints even without GPS (treadmill)."""
    ex_id = google_id.split("/")[-1]
    resp = httpx.get(
        f"{HEALTH_API_BASE}/users/me/dataTypes/exercise/dataPoints/{ex_id}:exportExerciseTcx",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"alt": "media", "partialData": "true"},
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.text


def _ingest_run_details(db: Session, access_token: str, start: date, end: date,
                        cap: int | None = 10) -> None:
    """Fetch + persist TCX-derived route/splits for run sessions in [start, end] that
    lack a terminal run_details row (ok/none). error rows are retried. `cap` bounds
    fetches per call (hourly sync); None (backfill) processes everything. Per-session
    failures are isolated — this pass can never wedge the broader sync."""
    rows = (
        db.query(WorkoutSession)
        .outerjoin(RunDetail, RunDetail.workout_session_id == WorkoutSession.id)
        .filter(
            WorkoutSession.date >= _helm_date(start),
            WorkoutSession.date <= _helm_date(end),
            WorkoutSession.exercise_type_raw.in_(RUN_TYPES),
            WorkoutSession.google_id.isnot(None),
            (RunDetail.id.is_(None)) | (RunDetail.route_status == "error"),
        )
        .order_by(WorkoutSession.date, WorkoutSession.id)
        .all()
    )
    if cap is not None:
        rows = rows[:cap]
    for s in rows:
        detail = db.query(RunDetail).filter(RunDetail.workout_session_id == s.id).first()
        if detail is None:
            detail = RunDetail(workout_session_id=s.id, route_status="error")
            db.add(detail)
        try:
            points = tcx_parser.parse_tcx(_fetch_exercise_tcx(access_token, s.google_id))
            route = tcx_parser.derive_route(points)
            splits = tcx_parser.derive_splits(points)
            detail.route = json.dumps(route) if route else None
            detail.splits = json.dumps(splits) if splits else None
            detail.route_status = "ok" if route else "none"
        except Exception as e:
            detail.route_status = "error"
            logger.warning("run TCX ingest failed (session %s): %s", s.id, e)
        detail.fetched_at = datetime.utcnow()
        db.commit()


# Consumer wearables track heart rate reasonably but overestimate active-calorie
# burn — validation studies (e.g. Stanford 2017) put the energy-expenditure error
# commonly around 20–30%+, skewed high. We credit a flat 70% of the watch's kcal to
# est_active_burn. Blunt heuristic, not per-activity; tune here.
def _session_key(s: WorkoutSession) -> tuple:
    """The real-workout identity. Google stores one workout as several sessions — the
    same activity under two type enums (WORKOUT + WEIGHTLIFTING), or phone + watch both
    recording — but they share date + canonical activity + start-minute. Two genuinely
    different same-type workouts can't start in the same minute, so this never merges
    distinct workouts."""
    return (s.date, google_session_activity(s.exercise_type_raw, s.exercise_type),
            s.start_time[11:16] if s.start_time else "")


def dedupe_sessions(db: Session, start: str | None = None, end: str | None = None) -> int:
    """Flag duplicate Google sessions and prune the orphan activities they created.

    Exactly one canonical session per real workout (see _session_key). Priority: the
    copy the user logged into wins (its activity has manual rows or is finalized) —
    never orphan logged data — then the FITBIT copy (the actual watch; HEALTH_CONNECT
    duplicates are hollow mirrors, usually missing kcal), then the richest watch data
    (has kcal → has GPS route → longest duration → lowest id). Duplicates keep their
    raw row for audit (is_duplicate=True)
    but get no Activity (link skips them) — so they never become a locked-in workout,
    and thus never contribute to the derived est_active_burn.
    Idempotent — safe to run every sync and as a one-time historical cleanup. Returns
    the number of session flags changed."""
    q = db.query(WorkoutSession)
    if start is not None:
        q = q.filter(WorkoutSession.date >= start, WorkoutSession.date <= end)
    sessions = q.all()
    if not sessions:
        return 0
    sids = [s.id for s in sessions]
    acts_by_gsid = {a.google_session_id: a for a in
                    db.query(Activity).filter(Activity.google_session_id.in_(sids)).all()}
    act_ids = [a.id for a in acts_by_gsid.values()] or [0]
    rows = {aid for (aid,) in db.query(Workout.activity_id)
            .filter(Workout.activity_id.in_(act_ids)).distinct().all()}
    route_sids = {sid for (sid,) in db.query(RunDetail.workout_session_id)
                  .filter(RunDetail.workout_session_id.in_(sids), RunDetail.route.isnot(None)).all()}

    def rank(s: WorkoutSession) -> tuple:
        act = acts_by_gsid.get(s.id)
        logged = bool(act and (act.id in rows or act.finalized))
        is_fitbit = (s.platform or "").upper() == "FITBIT"
        return (logged, is_fitbit, s.calories_kcal is not None, s.id in route_sids,
                s.duration_min or 0, -s.id)

    groups: dict[tuple, list] = defaultdict(list)
    for s in sessions:
        groups[_session_key(s)].append(s)

    changed = 0
    for members in groups.values():
        canonical = max(members, key=rank) if len(members) > 1 else members[0]
        for s in members:
            dup = len(members) > 1 and s.id != canonical.id
            if bool(s.is_duplicate) != dup:
                s.is_duplicate = dup
                changed += 1
            if dup:
                act = acts_by_gsid.get(s.id)
                if act is not None and act.id not in rows and not act.finalized:
                    db.delete(act)          # prune the orphan duplicate activity
    if changed:
        db.commit()
    return changed


def _upsert_daily_health(db: Session, day: str, **fields) -> None:
    row = db.query(DailyHealth).filter(DailyHealth.date == day).first()
    if row is None:
        row = DailyHealth(date=day)
        db.add(row)
    for k, v in fields.items():
        if v is not None:
            setattr(row, k, v)
    row.synced_at = datetime.utcnow()
    db.commit()


def _upsert_intraday_hr(db: Session, day: str, parsed: dict) -> None:
    row = db.query(IntradayHeartRate).filter(IntradayHeartRate.date == day).first()
    if row is None:
        row = IntradayHeartRate(date=day)
        db.add(row)
    row.samples = json.dumps({"points": parsed["points"]})
    row.min_bpm = parsed.get("min_bpm")
    row.avg_bpm = parsed.get("avg_bpm")
    row.max_bpm = parsed.get("max_bpm")
    row.synced_at = datetime.utcnow()
    db.commit()


def _gapfill_sleep(db: Session, day: str, hours: float | None,
                   bedtime: str | None, waketime: str | None) -> None:
    """Manual wins: write only when the day's sleep is blank or previously Google-filled."""
    row = db.query(DailySummary).filter(DailySummary.date == day).first()
    if row is None:
        row = DailySummary(date=day)
        db.add(row)
    # Manual/existing entries win: fill only blank days, or refresh a prior Google fill.
    if row.sleep_hours is not None and row.sleep_source != "google":
        return
    if hours is not None:
        row.sleep_hours = hours
    if bedtime is not None:
        row.sleep_bedtime = bedtime
    if waketime is not None:
        row.sleep_waketime = waketime
    row.sleep_source = "google"
    db.commit()


def _ingest_range(db: Session, access_token: str, start: date, end: date, *,
                  fetch_routes: bool = False, tcx_cap: int | None = 10) -> None:
    """Fetch + persist all kept metrics over [start, end]. Per-metric failures are isolated."""
    try:
        for day, steps in _fetch_step_rollup(access_token, start, end).items():
            _upsert_daily_health(db, day, steps=steps)
    except Exception as e:
        logger.warning("steps fetch failed: %s", e)

    for dtype, field in (("daily-resting-heart-rate", "resting_hr"),
                         ("daily-heart-rate-variability", "hrv_ms"),
                         ("daily-respiratory-rate", "respiratory_rate")):
        try:
            for day, val in _fetch_daily_points(access_token, dtype, start, end).items():
                _upsert_daily_health(db, day, **{field: (int(round(val)) if field == "resting_hr" else val)})
        except Exception as e:
            logger.warning("%s fetch failed: %s", dtype, e)

    try:
        sleep = _fetch_sleep(access_token, start, end)
        for day, s in sleep.items():
            _upsert_daily_health(db, day, sleep_deep_min=s["deep_min"], sleep_light_min=s["light_min"],
                                 sleep_rem_min=s["rem_min"], sleep_awake_min=s["awake_min"],
                                 sleep_efficiency_pct=s.get("efficiency"))
            _gapfill_sleep(db, day, s.get("hours"), s.get("bedtime"), s.get("waketime"))
    except Exception as e:
        logger.warning("sleep fetch failed: %s", e)

    cur = start
    while cur <= end:
        try:
            parsed = _fetch_intraday_hr(access_token, cur)
            if parsed:
                _upsert_intraday_hr(db, _helm_date(cur), parsed)
        except Exception as e:
            logger.warning("intraday HR fetch failed for %s: %s", cur, e)
        cur += timedelta(days=1)

    sessions_ok = False
    try:
        rows = [_upsert_workout_session(db, parsed)
                for parsed in _fetch_exercise_sessions(access_token, start, end)]
        # Flag duplicate copies of the same real workout BEFORE linking, so only the
        # canonical session gets an activity (and only it contributes burn below).
        dedupe_sessions(db, _helm_date(start), _helm_date(end))
        # Link AFTER all upserts so longest-first sees every same-date rival,
        # regardless of fetch order (matters on multi-day backfill batches).
        for row in sorted(rows, key=lambda r: r.duration_min or 0, reverse=True):
            activity_service.link_google_session(db, row)
        db.commit()
        sessions_ok = True
    except Exception as e:
        db.rollback()
        logger.warning("exercise sessions ingest/link failed: %s", e)

    # est_active_burn is DERIVED (daily_calculator.recompute_active_burn): the sum of
    # each day's in-log workouts' matched Google kcal (× 0.7). Re-derive every synced
    # day here — the sync is what LINKS the Google kcal onto manually-logged workouts,
    # so a day's burn only becomes correct once its sessions are linked. The old
    # incremental apply-once run-burn pass is gone (it couldn't drift or double-count).
    if sessions_ok:
        from .daily_calculator import recompute_active_burn
        cur = start
        while cur <= end:
            try:
                recompute_active_burn(_helm_date(cur), db)
            except Exception as e:
                logger.warning("active-burn recompute failed for %s: %s", cur, e)
            cur += timedelta(days=1)

    # Pre-cache each session's HR curve so the panel opens instantly (no live call on expand).
    # Only sessions still missing a cached curve are fetched — idempotent + bounded.
    try:
        rows = db.query(WorkoutSession).filter(
            WorkoutSession.date >= _helm_date(start),
            WorkoutSession.date <= _helm_date(end),
            WorkoutSession.hr_curve.is_(None),
            WorkoutSession.start_utc.isnot(None),
        ).all()
        for s in rows:
            try:
                curve = fetch_session_hr_window(access_token, s.start_utc, s.end_utc)
                if curve:
                    s.hr_curve = json.dumps({k: curve[k] for k in ("points", "min_bpm", "avg_bpm", "max_bpm")})
                    db.commit()
            except Exception as e:
                logger.warning("hr_curve cache failed (session %s): %s", s.id, e)
    except Exception as e:
        logger.warning("hr_curve cache pass failed: %s", e)

    if fetch_routes:
        try:
            _ingest_run_details(db, access_token, start, end, cap=tcx_cap)
        except Exception as e:
            logger.warning("run details pass failed: %s", e)


def run_sync(db: Session) -> dict:
    """Hourly + manual sync. Never raises; returns a status dict."""
    cred = db.query(OAuthCredential).filter(OAuthCredential.provider == PROVIDER).first()
    if cred is None or cred.status != "connected":
        return {"status": cred.status if cred else "not_connected", "last_sync_at": None}
    try:
        access_token = get_valid_access_token(db)
    except ReconsentRequired:
        return {"status": "needs_reconsent", "last_sync_at": cred.last_sync_at}
    except Exception as e:
        cred.last_error = str(e)[:500]
        db.commit()
        logger.warning("Google Health token refresh failed: %s", e)
        return {"status": "connected", "last_sync_at": cred.last_sync_at, "error": str(e)}
    today = datetime.utcnow().date()
    last_synced = cred.last_sync_at.date() if cred.last_sync_at else None
    start, end = _sync_range(last_synced, today)
    try:
        _ingest_range(db, access_token, start, end, fetch_routes=has_location_scope(cred))
        cred.last_sync_at = datetime.utcnow()
        cred.last_error = None
        db.commit()
        steps_today = None
        dh = db.query(DailyHealth).filter(DailyHealth.date == _helm_date(today)).first()
        if dh:
            steps_today = dh.steps
        return {"status": "connected", "last_sync_at": cred.last_sync_at, "steps_today": steps_today}
    except Exception as e:
        cred.last_error = str(e)[:500]
        db.commit()
        logger.warning("Google Health sync failed: %s", e)
        return {"status": "connected", "last_sync_at": cred.last_sync_at, "error": str(e)}


def backfill(db: Session) -> dict:
    """One-shot import from the configured start date through today. Safe to re-run.
    Never raises — returns a status dict so a background-thread caller can't die silently."""
    cred = db.query(OAuthCredential).filter(OAuthCredential.provider == PROVIDER).first()
    if cred is None or cred.status != "connected":
        return {"status": "not_connected"}
    try:
        access_token = get_valid_access_token(db)
    except ReconsentRequired:
        return {"status": "needs_reconsent"}
    try:
        _ingest_range(db, access_token, _start_date(), datetime.utcnow().date(),
                      fetch_routes=has_location_scope(cred), tcx_cap=None)
        cred.last_sync_at = datetime.utcnow()
        cred.last_error = None
        db.commit()
        return {"status": "ok", "start_date": _helm_date(_start_date())}
    except Exception as e:
        cred.last_error = str(e)[:500]
        db.commit()
        logger.warning("Google Health backfill failed: %s", e)
        return {"status": "error", "start_date": _helm_date(_start_date())}


def revoke_and_delete(db: Session, cred: OAuthCredential) -> None:
    try:
        httpx.post(REVOKE_ENDPOINT, params={"token": decrypt(cred.refresh_token_enc)}, timeout=HTTP_TIMEOUT)
    except Exception as e:
        logger.warning("Google token revoke failed (deleting anyway): %s", e)
    db.delete(cred)
    db.commit()
