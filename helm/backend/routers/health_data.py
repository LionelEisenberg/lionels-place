"""Google Health data reads + backfill trigger (admin-only)."""
from __future__ import annotations

import json
import logging
import os
import secrets as _secrets
import threading

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..database import get_db, SessionLocal
from ..models import DailyHealth, IntradayHeartRate, WorkoutSession
from ..schemas import (
    DailyHealthResponse, IntradayHeartRateResponse, BackfillResult,
    WorkoutSessionResponse, SessionHeartRateResponse,
)
from ..services import google_health_service as ghs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/health", tags=["health-data"])


def _require_admin(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user


@router.get("/daily", response_model=list[DailyHealthResponse])
def daily(request: Request, start: str = "", end: str = "", db: Session = Depends(get_db)):
    _require_admin(request)
    q = db.query(DailyHealth)
    if start:
        q = q.filter(DailyHealth.date >= start)
    if end:
        q = q.filter(DailyHealth.date <= end)
    return q.order_by(DailyHealth.date).all()


@router.get("/intraday/heart-rate", response_model=IntradayHeartRateResponse)
def intraday_hr(request: Request, date: str, db: Session = Depends(get_db)):
    _require_admin(request)
    row = db.query(IntradayHeartRate).filter(IntradayHeartRate.date == date).first()
    if row is None:
        raise HTTPException(status_code=404, detail="No intraday HR for that date")
    s = json.loads(row.samples)
    return IntradayHeartRateResponse(date=row.date, points=s.get("points", []),
        min_bpm=row.min_bpm, avg_bpm=row.avg_bpm, max_bpm=row.max_bpm)


@router.post("/sync-internal")
def sync_internal(request: Request, db: Session = Depends(get_db)):
    """Out-of-process sync trigger for the helm-health-sync sidecar. JWT-exempt but
    gated by a shared secret (X-Sync-Secret == HEALTH_SYNC_SECRET). Fail-closed."""
    expected = os.getenv("HEALTH_SYNC_SECRET", "")
    provided = request.headers.get("X-Sync-Secret", "")
    if not expected or not _secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=403, detail="Forbidden")
    return ghs.run_sync(db)


@router.post("/backfill", response_model=BackfillResult)
def backfill(request: Request, db: Session = Depends(get_db)):
    _require_admin(request)
    def _job():
        d = SessionLocal()
        try:
            ghs.backfill(d)
        finally:
            d.close()
    threading.Thread(target=_job, daemon=True).start()
    return BackfillResult(status="started", start_date=ghs._helm_date(ghs._start_date()))


@router.get("/sessions", response_model=list[WorkoutSessionResponse])
def sessions(request: Request, start: str = "", end: str = "", db: Session = Depends(get_db)):
    """Google exercise sessions in a date range, ordered chronologically within each day."""
    _require_admin(request)
    q = db.query(WorkoutSession)
    if start:
        q = q.filter(WorkoutSession.date >= start)
    if end:
        q = q.filter(WorkoutSession.date <= end)
    return q.order_by(WorkoutSession.date, WorkoutSession.start_time).all()


@router.get("/sessions/{session_id}/heart-rate", response_model=SessionHeartRateResponse)
def session_heart_rate(request: Request, session_id: int, db: Session = Depends(get_db)):
    """In-session HR curve. Preferred: native-resolution window fetched directly from
    Google (complete + sub-minute). Fallback: slice the stored daily intraday curve."""
    _require_admin(request)
    sess = db.query(WorkoutSession).filter(WorkoutSession.id == session_id).first()
    if sess is None:
        raise HTTPException(status_code=404, detail="Session not found")

    # Cached curve → instant, no live Google call (a past session's HR never changes).
    if sess.hr_curve:
        c = json.loads(sess.hr_curve)
        return SessionHeartRateResponse(
            session_id=sess.id, date=sess.date, points=c.get("points", []),
            min_bpm=c.get("min_bpm"), avg_bpm=c.get("avg_bpm"), max_bpm=c.get("max_bpm"),
        )
    if sess.start_utc and sess.end_utc:
        try:
            token = ghs.get_valid_access_token(db)
            parsed = ghs.fetch_session_hr_window(token, sess.start_utc, sess.end_utc)
            if parsed:
                sess.hr_curve = json.dumps({k: parsed[k] for k in ("points", "min_bpm", "avg_bpm", "max_bpm")})
                db.commit()
                return SessionHeartRateResponse(
                    session_id=sess.id, date=sess.date, points=parsed["points"],
                    min_bpm=parsed["min_bpm"], avg_bpm=parsed["avg_bpm"], max_bpm=parsed["max_bpm"],
                )
        except Exception as e:
            logger.warning("session HR window fetch failed (id=%s); falling back: %s", sess.id, e)

    row = db.query(IntradayHeartRate).filter(IntradayHeartRate.date == sess.date).first()
    points = json.loads(row.samples).get("points", []) if row else []
    sliced = ghs.slice_hr_window(points, sess.start_time[11:16], sess.end_time[11:16]) if points else None
    if sliced is None:
        return SessionHeartRateResponse(session_id=sess.id, date=sess.date, points=[])
    return SessionHeartRateResponse(
        session_id=sess.id, date=sess.date, points=sliced["points"],
        min_bpm=sliced["min_bpm"], avg_bpm=sliced["avg_bpm"], max_bpm=sliced["max_bpm"],
    )
