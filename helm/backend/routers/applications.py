"""
Applications router — CRUD + stats + AI advisor chat for job applications.
"""

import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from ..database import get_db
from ..models import Application, ApplicationEvent, Company, ChatMessage
from ..schemas import (
    ApplicationCreate, ApplicationUpdate, ApplicationResponse,
    ApplicationEventResponse, ApplicationStatsResponse,
    CLOSED_STATUSES,
)

router = APIRouter(prefix="/api/applications", tags=["applications"])

# Pipeline order for sorting active applications
STATUS_ORDER = {
    "researching": 0, "applied": 1, "phone_screen": 2,
    "technical": 3, "final": 4,
    "offer": 5, "rejected": 6, "withdrawn": 7,
}


def _app_with_events(app: Application, db: Session) -> dict:
    """Build an ApplicationResponse dict with events populated."""
    events = (
        db.query(ApplicationEvent)
        .filter(ApplicationEvent.application_id == app.id)
        .order_by(desc(ApplicationEvent.created_at))
        .all()
    )
    d = {
        "id": app.id,
        "company_id": app.company_id,
        "company_name": app.company_name,
        "job_title": app.job_title,
        "status": app.status,
        "salary_range": app.salary_range,
        "recruiter_name": app.recruiter_name,
        "posting_url": app.posting_url,
        "notes": app.notes,
        "applied_date": app.applied_date,
        "created_at": app.created_at,
        "updated_at": app.updated_at,
        "events": [ApplicationEventResponse.model_validate(e) for e in events],
    }
    return d


def _sort_key(app: Application) -> tuple:
    """Sort: active apps first in pipeline order, then closed by updated_at desc."""
    is_closed = app.status in CLOSED_STATUSES
    order = STATUS_ORDER.get(app.status, 99)
    # For closed apps, sort by updated_at descending (negate timestamp)
    updated_ts = app.updated_at.timestamp() if app.updated_at else 0
    return (is_closed, order, -updated_ts)


# ==========================================
# Endpoints — define /stats and /chat BEFORE /{id}
# ==========================================

@router.get("/stats", response_model=ApplicationStatsResponse)
async def application_stats(db: Session = Depends(get_db)):
    """Summary statistics for applications."""
    apps = db.query(Application).all()
    total = len(apps)
    active = sum(1 for a in apps if a.status not in CLOSED_STATUSES)
    by_status: dict[str, int] = {}
    for a in apps:
        by_status[a.status] = by_status.get(a.status, 0) + 1

    # Response rate: apps that progressed past "applied" / total applied
    applied_or_beyond = sum(1 for a in apps if a.applied_date is not None)
    past_applied = sum(1 for a in apps if a.status in (
        "phone_screen", "technical", "final", "offer", "rejected", "withdrawn"
    ) and a.applied_date is not None)
    response_rate = (past_applied / applied_or_beyond * 100) if applied_or_beyond > 0 else 0.0

    return ApplicationStatsResponse(
        total=total,
        active=active,
        by_status=by_status,
        response_rate=round(response_rate, 1),
    )


@router.get("", response_model=list[ApplicationResponse])
async def list_applications(
    status: Optional[str] = Query(None),
    include_events: bool = Query(False),
    db: Session = Depends(get_db),
):
    """List all applications with optional status filter."""
    q = db.query(Application)
    if status:
        q = q.filter(Application.status == status)
    apps = q.all()
    apps.sort(key=_sort_key)

    if include_events:
        return [_app_with_events(a, db) for a in apps]

    results = []
    for a in apps:
        d = {
            "id": a.id, "company_id": a.company_id, "company_name": a.company_name,
            "job_title": a.job_title, "status": a.status, "salary_range": a.salary_range,
            "recruiter_name": a.recruiter_name, "posting_url": a.posting_url,
            "notes": a.notes, "applied_date": a.applied_date,
            "created_at": a.created_at, "updated_at": a.updated_at, "events": [],
        }
        results.append(d)
    return results


@router.get("/{app_id}", response_model=ApplicationResponse)
async def get_application(app_id: int, db: Session = Depends(get_db)):
    """Get a single application with events."""
    app = db.query(Application).filter(Application.id == app_id).first()
    if not app:
        raise HTTPException(status_code=404, detail="Application not found")
    return _app_with_events(app, db)


@router.post("", response_model=ApplicationResponse)
async def create_application(data: ApplicationCreate, db: Session = Depends(get_db)):
    """Create a new application with an initial event."""
    company_name = data.company_name
    # If company_id provided, look up and use the company's name
    if data.company_id:
        company = db.query(Company).filter(Company.id == data.company_id).first()
        if not company:
            raise HTTPException(status_code=400, detail="Company not found")
        company_name = company.name

    app = Application(
        company_id=data.company_id,
        company_name=company_name,
        job_title=data.job_title,
        status=data.status,
        salary_range=data.salary_range,
        recruiter_name=data.recruiter_name,
        posting_url=data.posting_url,
        notes=data.notes,
    )

    # Auto-set applied_date if starting at "applied" or beyond
    if data.status != "researching":
        app.applied_date = datetime.now().strftime("%Y-%m-%d")

    db.add(app)
    db.flush()

    # Create initial event
    event = ApplicationEvent(
        application_id=app.id,
        status=data.status,
        note=f"Application created",
    )
    db.add(event)
    db.commit()
    db.refresh(app)

    return _app_with_events(app, db)


@router.put("/{app_id}", response_model=ApplicationResponse)
async def update_application(app_id: int, data: ApplicationUpdate, db: Session = Depends(get_db)):
    """Update an application. If status changes, create an event."""
    app = db.query(Application).filter(Application.id == app_id).first()
    if not app:
        raise HTTPException(status_code=404, detail="Application not found")

    old_status = app.status

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(app, key, value)

    # If status changed, create event and handle applied_date
    if data.status and data.status != old_status:
        event = ApplicationEvent(
            application_id=app.id,
            status=data.status,
            note=data.notes,
        )
        db.add(event)

        if data.status == "applied" and not app.applied_date:
            app.applied_date = datetime.now().strftime("%Y-%m-%d")

    db.commit()
    db.refresh(app)
    return _app_with_events(app, db)


@router.delete("/{app_id}")
async def delete_application(app_id: int, db: Session = Depends(get_db)):
    """Delete an application and its events."""
    app = db.query(Application).filter(Application.id == app_id).first()
    if not app:
        raise HTTPException(status_code=404, detail="Application not found")
    # Delete events first (no FK cascade in SQLite)
    db.query(ApplicationEvent).filter(ApplicationEvent.application_id == app_id).delete()
    db.delete(app)
    db.commit()
    return {"ok": True}


# ==========================================
# Application Advisor Chat
# ==========================================

def _build_application_context(db: Session) -> str:
    """Build plain-text context of all applications for the advisor."""
    apps = db.query(Application).all()
    apps.sort(key=_sort_key)

    lines = [f"Applications ({len(apps)} total):"]
    for a in apps:
        parts = [f"  [id={a.id}] {a.company_name} — {a.job_title} (status: {a.status}"]
        if a.salary_range:
            parts.append(f", salary: {a.salary_range}")
        if a.recruiter_name:
            parts.append(f", recruiter: {a.recruiter_name}")
        if a.applied_date:
            parts.append(f", applied: {a.applied_date}")
        parts.append(")")
        if a.notes:
            parts.append(f" — {a.notes}")
        lines.append("".join(parts))
    return "\n".join(lines)


def _build_company_list_context(db: Session) -> str:
    """Build a compact company list for AI company_id resolution."""
    companies = db.query(Company).all()
    lines = ["Known companies:"]
    for c in companies:
        lines.append(f"  [id={c.id}] {c.name} (tier: {c.tier})")
    return "\n".join(lines)


def apply_application_actions(db: Session, response_text: str) -> tuple[str, list[Application], list[Application]]:
    """Parse [CREATE_APP]/[ADVANCE_APP]/[UPDATE_APP] markers from an advisor
    response, apply the corresponding Application mutations, commit, and
    return (markers-stripped text, created, updated)."""
    # Parse action markers
    created: list[Application] = []
    updated: list[Application] = []
    kv_pattern = r'(\w+)="([^"]*)"'

    # [CREATE_APP: company_name="...", ...]
    create_pattern = r'\[CREATE_APP:\s*([^\]]+)\]'
    for match in re.finditer(create_pattern, response_text):
        kv_str = match.group(1)
        kvs = dict(re.findall(kv_pattern, kv_str))
        if "company_name" not in kvs and "job_title" not in kvs:
            continue
        company_name = kvs.get("company_name", "Unknown")
        company_id = None
        id_match = re.search(r'company_id=(\d+)', kv_str)
        if id_match:
            cid = int(id_match.group(1))
            c = db.query(Company).filter(Company.id == cid).first()
            if c:
                company_id = cid
                company_name = c.name

        status = kvs.get("status", "researching")
        if status not in STATUS_ORDER:
            status = "researching"

        app = Application(
            company_id=company_id,
            company_name=company_name,
            job_title=kvs.get("job_title", "Software Engineer"),
            status=status,
            salary_range=kvs.get("salary_range"),
            posting_url=kvs.get("posting_url"),
            recruiter_name=kvs.get("recruiter_name"),
            notes=kvs.get("notes"),
        )
        if status != "researching":
            app.applied_date = datetime.now().strftime("%Y-%m-%d")
        db.add(app)
        db.flush()
        db.refresh(app)
        # Initial event
        db.add(ApplicationEvent(application_id=app.id, status=status, note="Created via chat"))
        created.append(app)

    # [ADVANCE_APP: id=12, status="phone_screen", note="..."]
    advance_pattern = r'\[ADVANCE_APP:\s*([^\]]+)\]'
    for match in re.finditer(advance_pattern, response_text):
        kv_str = match.group(1)
        kvs = dict(re.findall(kv_pattern, kv_str))
        id_match = re.search(r'id=(\d+)', kv_str)
        if not id_match:
            continue
        app = db.query(Application).filter(Application.id == int(id_match.group(1))).first()
        if not app:
            continue
        new_status = kvs.get("status")
        if new_status and new_status in STATUS_ORDER:
            old_status = app.status
            app.status = new_status
            if new_status == "applied" and not app.applied_date:
                app.applied_date = datetime.now().strftime("%Y-%m-%d")
            db.add(ApplicationEvent(
                application_id=app.id, status=new_status,
                note=kvs.get("note", f"Advanced from {old_status}"),
            ))
            db.flush()
            db.refresh(app)
            updated.append(app)

    # [UPDATE_APP: id=12, recruiter_name="Jane Smith", ...]
    update_pattern = r'\[UPDATE_APP:\s*([^\]]+)\]'
    for match in re.finditer(update_pattern, response_text):
        kv_str = match.group(1)
        kvs = dict(re.findall(kv_pattern, kv_str))
        id_match = re.search(r'id=(\d+)', kv_str)
        if not id_match:
            continue
        app = db.query(Application).filter(Application.id == int(id_match.group(1))).first()
        if not app:
            continue
        for field in ("recruiter_name", "salary_range", "posting_url", "notes", "job_title"):
            if field in kvs:
                setattr(app, field, kvs[field])
        db.flush()
        db.refresh(app)
        updated.append(app)

    if created or updated:
        db.commit()

    # Strip markers from displayed response
    clean = response_text
    for pat in [create_pattern, advance_pattern, update_pattern]:
        clean = re.sub(pat, '', clean)
    clean = clean.strip()
    return clean, created, updated


@router.get("/chat/history")
async def application_chat_history(
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Return recent application advisor chat messages."""
    msgs = (
        db.query(ChatMessage)
        .filter(ChatMessage.context == "applications")
        .order_by(desc(ChatMessage.id))
        .limit(limit)
        .all()
    )
    msgs.reverse()
    return [{"role": m.role, "content": m.content, "created_at": m.created_at} for m in msgs]
