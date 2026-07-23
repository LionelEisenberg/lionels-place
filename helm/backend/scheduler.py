"""In-process hourly Google Health sync via APScheduler.

Single uvicorn worker => exactly one scheduler instance. Under --reload the worker
restarts cleanly; a skipped hourly tick is harmless."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from .database import SessionLocal
from .services import google_health_service as ghs

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _run_sync_job() -> None:
    db = SessionLocal()
    try:
        result = ghs.run_sync(db)
        logger.info("Google Health sync tick: %s", result.get("status"))
    except Exception as e:  # never let a job exception kill the scheduler thread
        logger.warning("Google Health sync job error: %s", e)
    finally:
        db.close()


def start_scheduler() -> BackgroundScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    sched = BackgroundScheduler(timezone="UTC")
    sched.add_job(
        _run_sync_job,
        IntervalTrigger(hours=1),
        id="google_health_sync",
        coalesce=True,
        max_instances=1,
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=60),
    )
    sched.start()
    _scheduler = sched
    logger.info("Started Google Health sync scheduler (hourly)")
    return sched


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
