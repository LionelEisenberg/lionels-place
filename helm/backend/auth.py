"""
JWT authentication middleware — validates tokens from auth_service,
enforces role-based access, and maintains the public route allowlist.
"""

import os
import re

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .services.auth_service import verify_jwt

# Public GET routes — no auth required
PUBLIC_GET_PATTERNS = [
    re.compile(r"^/api/recipes$"),
    re.compile(r"^/api/recipes/tags$"),
    re.compile(r"^/api/recipes/\d+$"),
    re.compile(r"^/api/recipes/\d+/photo$"),
    re.compile(r"^/api/recipes/\d+/scale$"),
    re.compile(r"^/api/recipes/cook-photos/.+$"),
    re.compile(r"^/api/llm-dash$"),
    re.compile(r"^/api/health/oauth/callback$"),
]

# Routes that must be accessible without a token
PUBLIC_AUTH_ROUTES = {
    ("POST", "/api/auth/login"),
    ("POST", "/api/health/sync-internal"),
}


def is_public_route(path: str, method: str) -> bool:
    """Check if a route is publicly accessible."""
    method = method.upper()

    if method == "OPTIONS":
        return True

    if not path.startswith("/api/"):
        return True

    if (method, path) in PUBLIC_AUTH_ROUTES:
        return True

    if method == "GET":
        for pattern in PUBLIC_GET_PATTERNS:
            if pattern.match(path):
                return True

    return False


# Routes accessible to authenticated friends (method-agnostic prefix matching)
FRIEND_ALLOWED_PREFIXES = ["/api/recipes", "/api/shopping-list"]
FRIEND_ALLOWED_EXACT = ["/api/auth/me", "/api/feedback"]


def is_friend_allowed_route(path: str) -> bool:
    """Check if a route is accessible to the 'friend' role."""
    for prefix in FRIEND_ALLOWED_PREFIXES:
        if path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "?"):
            return True
    return path in FRIEND_ALLOWED_EXACT


def check_admin_override(jwt_role: str, username: str) -> str:
    """Re-check HELM_ADMIN_USERS at request time for role upgrades."""
    if jwt_role == "admin":
        return "admin"
    admin_users = os.getenv("HELM_ADMIN_USERS", "")
    if admin_users:
        allowlist = {u.strip().lower() for u in admin_users.split(",") if u.strip()}
        if username.lower() in allowlist:
            return "admin"
    return jwt_role


class JWTAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method

        # Public routes skip auth entirely
        if is_public_route(path, method):
            return await call_next(request)

        # Extract bearer token
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse(
                status_code=401,
                content={"detail": "Authentication required"},
            )

        token = auth_header[len("Bearer "):]
        try:
            payload = verify_jwt(token)
        except ValueError:
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid session, please log in again"},
            )

        # Re-check admin override at request time
        username = payload.get("username", "")
        role = check_admin_override(payload.get("role", "friend"), username)

        # Inject user into request state BEFORE role enforcement
        request.state.user = {
            "username": username,
            "jellyfin_id": payload.get("jellyfin_id", ""),
            "role": role,
        }

        # Role-based route enforcement
        if path.startswith("/api/"):
            if role == "admin":
                pass  # admin can access everything
            elif is_friend_allowed_route(path):
                pass  # friend can access cooking routes
            else:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Admin access required"},
                )

        return await call_next(request)
