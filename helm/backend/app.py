"""
Main FastAPI application entry point.
Mounts all routers, auth middleware, and serves the React SPA.
"""

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session

from .auth import JWTAuthMiddleware
from .database import get_db, init_db
from .models import User
from .routers import parse, meals, workouts, daily, advisor, export, photos, tasks as tasks_router, companies as companies_router, applications as applications_router, leetcode as leetcode_router, schedule as schedule_router, recipes as recipes_router, shopping_list as shopping_list_router, gemini_dashboard, settings as settings_router, async_jobs as async_jobs_router, phases as phases_router, health_oauth as health_oauth_router, health_data as health_data_router, important_dates as important_dates_router, llm_jobs as llm_jobs_router
from .schemas import LoginRequest, LoginResponse, MeResponse, UserResponse
from .services.auth_service import (
    authenticate_with_jellyfin, create_jwt, verify_jwt,
    determine_role, should_refresh,
)
from .services.import_service import run_import

logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST_DIR = os.path.join(BASE_DIR, "dist")
IMPORT_DIR = os.path.join(BASE_DIR, "import")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: init DB + start the Google Health scheduler (if configured)."""
    init_db()
    from .services import google_health_service as ghs
    from .scheduler import start_scheduler, shutdown_scheduler
    if ghs.is_configured():
        try:
            start_scheduler()
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning("Google Health scheduler failed to start: %s", e)
    else:
        import logging
        logging.getLogger(__name__).info("Google Health not configured; sync scheduler dormant")
    yield
    try:
        shutdown_scheduler()
    except Exception:
        pass


app = FastAPI(
    title="Helm",
    description="Self-hosted daily tracking with AI advisor",
    lifespan=lifespan,
)

# ==========================================
# Middleware
# ==========================================
app.add_middleware(JWTAuthMiddleware)


# ==========================================
# API Routers
# ==========================================
app.include_router(parse.router)
app.include_router(meals.router)
app.include_router(workouts.router)
app.include_router(daily.router)
app.include_router(advisor.router)
app.include_router(export.router)
app.include_router(photos.router)
app.include_router(tasks_router.router)
app.include_router(companies_router.router)
app.include_router(applications_router.router)
app.include_router(leetcode_router.router)
app.include_router(schedule_router.router)
app.include_router(recipes_router.router)
app.include_router(shopping_list_router.router)
app.include_router(gemini_dashboard.router)
app.include_router(settings_router.router)
app.include_router(async_jobs_router.router)
app.include_router(llm_jobs_router.router)
app.include_router(llm_jobs_router.internal_router)
app.include_router(phases_router.router)
app.include_router(health_oauth_router.router)
app.include_router(health_data_router.router)
app.include_router(important_dates_router.router)

# Optional local-only experimental routers (gitignored module).
# See docs/superpowers/specs/2026-05-23-private-widget-design.md.
try:
    from . import _private as _private_module
    app.include_router(_private_module.router.router)
except ImportError:
    pass

@app.post("/api/auth/login", response_model=LoginResponse)
async def login(req: LoginRequest, db: Session = Depends(get_db)):
    """Authenticate via Jellyfin and return a JWT."""
    try:
        jf_user = authenticate_with_jellyfin(req.username, req.password)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except ConnectionError as e:
        # Upstream (Jellyfin) is down or returned an unexpected status. The
        # service layer has already logged the specifics; surface a clear,
        # actionable message rather than a bare 503.
        logger.warning("Login for %r failed — upstream auth error: %s", req.username, e)
        raise HTTPException(status_code=503, detail=str(e))

    role = determine_role(jf_user["is_admin"], jf_user["username"])

    # Upsert user record
    user = db.query(User).filter(User.jellyfin_id == jf_user["jellyfin_id"]).first()
    if user:
        user.username = jf_user["username"]
        user.role = role
        user.last_login = datetime.utcnow()
    else:
        user = User(
            jellyfin_id=jf_user["jellyfin_id"],
            username=jf_user["username"],
            role=role,
        )
        db.add(user)
    db.commit()

    token = create_jwt({
        "jellyfin_id": jf_user["jellyfin_id"],
        "username": jf_user["username"],
        "role": role,
    })
    return LoginResponse(token=token, user=UserResponse(username=jf_user["username"], role=role))


@app.get("/api/auth/me", response_model=MeResponse)
async def get_me(request: Request):
    """Return current user info. Re-issues token if near expiry."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")

    try:
        payload = verify_jwt(auth_header[len("Bearer "):])
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid session, please log in again")

    new_token = None
    if should_refresh(payload):
        new_token = create_jwt({
            "jellyfin_id": payload["jellyfin_id"],
            "username": payload["username"],
            "role": payload["role"],
        })

    return MeResponse(
        username=payload["username"],
        role=payload["role"],
        token=new_token,
    )

# ==========================================
# Feedback / Issue Submission
# ==========================================
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GITHUB_REPO = os.getenv("GITHUB_REPO", "LionelEisenberg/Pirateship")


@app.post("/api/feedback")
async def submit_feedback(request: Request):
    """Create a GitHub issue from user feedback."""
    if not GITHUB_TOKEN:
        raise HTTPException(status_code=503, detail="Feedback submission not configured")

    user_info = getattr(request.state, "user", None)
    username = user_info["username"] if user_info else "Anonymous"

    body = await request.json()
    title = body.get("title", "").strip()
    description = body.get("description", "").strip()
    issue_type = body.get("type", "feature")  # "feature" or "bug"

    if not title:
        raise HTTPException(status_code=400, detail="Title is required")

    label = "enhancement" if issue_type == "feature" else "bug"
    issue_body = f"**Submitted by:** {username}\n\n{description}" if description else f"**Submitted by:** {username}"

    import httpx
    resp = httpx.post(
        f"https://api.github.com/repos/{GITHUB_REPO}/issues",
        json={"title": title, "body": issue_body, "labels": [label]},
        headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github.v3+json",
        },
        timeout=10.0,
    )
    if resp.status_code != 201:
        raise HTTPException(status_code=502, detail="Failed to create issue on GitHub")

    return {"ok": True, "issue_url": resp.json().get("html_url")}


# ==========================================
# Serve React SPA (static files)
# ==========================================
if os.path.exists(DIST_DIR):
    assets_dir = os.path.join(DIST_DIR, "assets")
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/")
    async def root():
        return FileResponse(os.path.join(DIST_DIR, "index.html"))

    @app.get("/sw.js")
    async def service_worker():
        """Serve the service worker with no caching. A CDN/browser that pins an old
        sw.js gates every client update (Cloudflare was edge-caching it for 4h), which
        stranded clients on a stale bundle. Must be declared before the SPA catch-all."""
        return FileResponse(
            os.path.join(DIST_DIR, "sw.js"),
            media_type="application/javascript",
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve the React SPA for all non-API routes."""
        file_path = os.path.join(DIST_DIR, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(DIST_DIR, "index.html"))
else:
    @app.get("/")
    async def no_frontend():
        return {"message": "Helm API is running. Frontend not built yet."}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app:app", host="0.0.0.0", port=8001, reload=True)
