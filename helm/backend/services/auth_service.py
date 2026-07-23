"""
Jellyfin-backed authentication service.
Handles Jellyfin API auth, JWT signing/verification, and role determination.
"""

import logging
import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt
import httpx

logger = logging.getLogger(__name__)

# JWT config
_jwt_secret = os.getenv("JWT_SECRET", "")
if not _jwt_secret:
    _jwt_secret = secrets.token_hex(32)
    print("[AUTH] WARNING: JWT_SECRET not set. Generated ephemeral secret. "
          "Sessions will not survive restarts. Set JWT_SECRET in .env for production.", flush=True)

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 30
JWT_REFRESH_THRESHOLD_DAYS = 7

# Jellyfin config
JELLYFIN_URL = os.getenv("JELLYFIN_URL", "http://jellyfin:8096")
EMBY_AUTH_HEADER = 'MediaBrowser Client="Helm", Device="Helm Server", DeviceId="helm-backend", Version="1.0"'


def authenticate_with_jellyfin(username: str, password: str) -> dict:
    """Authenticate against Jellyfin. Returns user info dict.
    Raises ValueError for bad credentials, ConnectionError for Jellyfin down
    or returning an unexpected (non-200/401) status."""
    try:
        resp = httpx.post(
            f"{JELLYFIN_URL}/Users/AuthenticateByName",
            json={"Username": username, "Pw": password},
            headers={"X-Emby-Authorization": EMBY_AUTH_HEADER},
            timeout=10.0,
        )
    except httpx.ConnectError as e:
        logger.error("Jellyfin unreachable at %s during auth: %s", JELLYFIN_URL, e)
        raise ConnectionError("Authentication service unavailable")

    if resp.status_code == 401:
        raise ValueError("Invalid username or password")
    if resp.status_code != 200:
        # Don't swallow upstream failures silently — log exactly what Jellyfin
        # returned so a 500 here is diagnosable instead of a mystery 503.
        try:
            body = resp.text[:500]
        except Exception:
            body = "<unreadable response body>"
        logger.error(
            "Jellyfin auth returned unexpected status %s for user %r. Body: %s",
            resp.status_code, username, body,
        )
        raise ConnectionError(
            f"Login server returned an unexpected error (Jellyfin {resp.status_code}). "
            "Please try again in a moment, or contact the admin if it persists."
        )

    data = resp.json()
    user = data.get("User", {})
    return {
        "jellyfin_id": user.get("Id", ""),
        "username": user.get("Name", username),
        "is_admin": user.get("Policy", {}).get("IsAdministrator", False),
    }


def determine_role(is_jellyfin_admin: bool, username: str) -> str:
    """Determine Helm role from Jellyfin admin status and HELM_ADMIN_USERS."""
    if is_jellyfin_admin:
        return "admin"
    admin_users = os.getenv("HELM_ADMIN_USERS", "")
    if admin_users:
        allowlist = {u.strip().lower() for u in admin_users.split(",") if u.strip()}
        if username.lower() in allowlist:
            return "admin"
    return "friend"


def create_jwt(user_data: dict) -> str:
    """Sign a JWT with user data. Adds exp claim (30 days)."""
    payload = {
        **user_data,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRY_DAYS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, _jwt_secret, algorithm=JWT_ALGORITHM)


def verify_jwt(token: str) -> dict:
    """Verify and decode a JWT. Raises ValueError on invalid/expired."""
    try:
        return jwt.decode(token, _jwt_secret, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise ValueError("Token expired")
    except jwt.InvalidTokenError:
        raise ValueError("Invalid token")


def should_refresh(payload: dict) -> bool:
    """Check if the token should be refreshed (< 7 days remaining)."""
    exp = payload.get("exp", 0)
    remaining = exp - datetime.now(timezone.utc).timestamp()
    return remaining < (JWT_REFRESH_THRESHOLD_DAYS * 86400)
