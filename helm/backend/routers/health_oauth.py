"""Google Health OAuth connect / callback / status / sync / disconnect."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..dependencies import resolve_current_user
from ..models import OAuthCredential
from ..schemas import HealthConnectUrl, HealthConnectionStatus, HealthSyncResult
from ..services import google_health_service as ghs

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/health", tags=["health"])

FRONTEND_PAGE = "/helm/google-health"


def _require_admin(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user


@router.get("/connect", response_model=HealthConnectUrl)
def connect(request: Request, db: Session = Depends(get_db)):
    user = _require_admin(request)
    if not ghs.is_configured():
        raise HTTPException(status_code=503, detail="Google Health is not configured on the server")
    db_user = resolve_current_user(user["jellyfin_id"], db)
    state, challenge = ghs.create_oauth_state(db, db_user.id if db_user else None)
    return HealthConnectUrl(authorize_url=ghs.build_authorize_url(state, challenge))


@router.get("/oauth/callback")
def oauth_callback(state: str = "", code: str = "", error: str = "", db: Session = Depends(get_db)):
    # Authenticated by the one-time `state`, NOT a JWT (Google redirects here directly).
    if error or not code or not state:
        return RedirectResponse(url=f"{FRONTEND_PAGE}?health=error", status_code=302)
    try:
        code_verifier, user_id = ghs.consume_oauth_state(db, state)
    except ValueError:
        return RedirectResponse(url=f"{FRONTEND_PAGE}?health=error", status_code=302)
    try:
        ghs.exchange_code(db, code, code_verifier, user_id)
    except Exception as e:
        logger.error("Google Health code exchange failed: %s", e)
        return RedirectResponse(url=f"{FRONTEND_PAGE}?health=error", status_code=302)
    import threading
    from ..database import SessionLocal
    def _bf():
        d = SessionLocal()
        try:
            ghs.backfill(d)
        finally:
            d.close()
    threading.Thread(target=_bf, daemon=True).start()
    return RedirectResponse(url=f"{FRONTEND_PAGE}?health=connected", status_code=302)


@router.get("/status", response_model=HealthConnectionStatus)
def status(request: Request, db: Session = Depends(get_db)):
    _require_admin(request)
    cred = db.query(OAuthCredential).filter(OAuthCredential.provider == ghs.PROVIDER).first()
    if cred is None:
        return HealthConnectionStatus(status="disconnected")
    return HealthConnectionStatus(
        status=cred.status, last_sync_at=cred.last_sync_at,
        last_error=cred.last_error, scopes=cred.scopes,
    )


@router.post("/sync", response_model=HealthSyncResult)
def sync(request: Request, db: Session = Depends(get_db)):
    _require_admin(request)
    result = ghs.run_sync(db)
    if result["status"] in ("not_connected", "disconnected"):
        raise HTTPException(status_code=409, detail="Google Health not connected")
    if result["status"] == "needs_reconsent":
        raise HTTPException(status_code=409, detail="Reconnect required")
    return HealthSyncResult(
        status=result["status"], last_sync_at=result.get("last_sync_at"),
        steps_today=result.get("steps_today"),
    )


@router.post("/disconnect")
def disconnect(request: Request, db: Session = Depends(get_db)):
    _require_admin(request)
    cred = db.query(OAuthCredential).filter(OAuthCredential.provider == ghs.PROVIDER).first()
    if cred is not None:
        ghs.revoke_and_delete(db, cred)
    return {"status": "disconnected"}
