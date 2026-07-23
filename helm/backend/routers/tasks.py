"""
Tasks router — Kanban board CRUD + AI advisor chat.
"""

import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc, func

from ..database import get_db
from ..models import Task
from ..schemas import (
    TaskCreate, TaskUpdate, TaskMoveRequest, TaskResponse,
    OverdueTaskResponse,
)

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def _next_position(db: Session, status: str) -> float:
    """Return a position value that places a new task at the bottom of a column."""
    max_pos = db.query(func.max(Task.position)).filter(Task.status == status).scalar()
    return (max_pos or 0) + 1000.0


def _normalize_positions(db: Session, status: str):
    """Re-space positions in a column if gaps get too small."""
    tasks = db.query(Task).filter(Task.status == status).order_by(Task.position).all()
    if len(tasks) < 2:
        return
    for i in range(1, len(tasks)):
        if abs(tasks[i].position - tasks[i - 1].position) < 0.001:
            for j, t in enumerate(tasks):
                t.position = (j + 1) * 1000.0
            db.flush()
            return


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    status: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """List tasks with optional filters. Normalizes positions if needed."""
    q = db.query(Task)
    if status:
        q = q.filter(Task.status == status)
    if category:
        q = q.filter(Task.category == category)
    tasks = q.order_by(Task.position).all()
    return tasks


@router.post("", response_model=TaskResponse)
async def create_task(data: TaskCreate, db: Session = Depends(get_db)):
    """Create a new task, placed at the bottom of its column."""
    task = Task(
        title=data.title,
        category=data.category,
        status=data.status,
        priority=data.priority,
        due_date=data.due_date,
        notes=data.notes,
        position=_next_position(db, data.status),
    )
    if data.status == "done":
        task.completed_at = datetime.utcnow()
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.get("/overdue", response_model=list[OverdueTaskResponse])
def get_overdue_tasks(db: Session = Depends(get_db)):
    """Return tasks that are past their due date and not done."""
    from zoneinfo import ZoneInfo
    today_str = datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")
    overdue = db.query(Task).filter(
        Task.due_date.isnot(None),
        Task.due_date < today_str,
        Task.status != "done",
    ).order_by(Task.due_date.asc()).limit(10).all()

    result = []
    for t in overdue:
        days = (datetime.strptime(today_str, "%Y-%m-%d") - datetime.strptime(t.due_date, "%Y-%m-%d")).days
        result.append(OverdueTaskResponse(
            id=t.id, title=t.title, category=t.category,
            due_date=t.due_date, days_overdue=days,
            priority=getattr(t, 'priority', None),
        ))
    return result


@router.put("/{task_id}", response_model=TaskResponse)
async def update_task(task_id: int, data: TaskUpdate, db: Session = Depends(get_db)):
    """Update task fields (not status/position — use /move for that)."""
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(task, field, value)
    db.commit()
    db.refresh(task)
    return task


@router.delete("/{task_id}")
async def delete_task(task_id: int, db: Session = Depends(get_db)):
    """Hard delete a task."""
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()
    return {"ok": True}


@router.put("/{task_id}/move", response_model=TaskResponse)
async def move_task(task_id: int, data: TaskMoveRequest, db: Session = Depends(get_db)):
    """Move a task to a new column/position (drag-and-drop)."""
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    old_status = task.status
    task.status = data.status
    task.position = data.position

    # Auto-manage completed_at
    if data.status == "done" and old_status != "done":
        task.completed_at = datetime.utcnow()
    elif data.status != "done" and old_status == "done":
        task.completed_at = None

    db.commit()

    # Normalize if positions got too tight
    _normalize_positions(db, data.status)
    db.commit()

    db.refresh(task)
    return task


@router.get("/categories", response_model=list[str])
async def list_categories(db: Session = Depends(get_db)):
    """Return distinct task categories in use."""
    rows = db.query(Task.category).distinct().order_by(Task.category).all()
    return [r[0] for r in rows]


def _build_task_context(db: Session) -> tuple[str, str]:
    """Build the task-list context string + today's date for the advisor chat."""
    active_tasks = db.query(Task).filter(Task.status != "done").order_by(Task.position).all()
    done_tasks = db.query(Task).filter(Task.status == "done").order_by(desc(Task.completed_at)).limit(10).all()
    all_tasks = active_tasks + done_tasks

    today = datetime.utcnow().date().isoformat()
    context_lines = [f"Current Tasks (today: {today}):"]
    for t in all_tasks:
        overdue = ""
        if t.due_date and t.due_date < today and t.status != "done":
            overdue = " [OVERDUE]"
        line = f"  [{t.status.upper()}] {t.title} (Category: {t.category}"
        if t.priority:
            line += f", Priority: {t.priority}"
        if t.due_date:
            line += f", Due: {t.due_date}{overdue}"
        line += ")"
        if t.status == "done" and t.completed_at:
            line += f" — completed {t.completed_at.strftime('%Y-%m-%d')}"
        context_lines.append(line)
    return "\n".join(context_lines), today


def apply_task_actions(db: Session, response_text: str) -> str:
    """Parse [CREATE_TASK: ...] markers from an advisor response, create the
    corresponding Task rows, commit, and return the markers-stripped text."""
    created_tasks: list[Task] = []
    marker_pattern = r'\[CREATE_TASK:\s*([^\]]+)\]'
    kv_pattern = r'(\w+)="([^"]*)"'

    for match in re.finditer(marker_pattern, response_text):
        kv_str = match.group(1)
        kvs = dict(re.findall(kv_pattern, kv_str))
        if "title" not in kvs:
            continue
        task = Task(
            title=kvs["title"],
            category=kvs.get("category", "Personal"),
            status="todo",
            priority=kvs.get("priority") if kvs.get("priority") in ("high", "medium", "low") else None,
            due_date=kvs.get("due_date") if kvs.get("due_date", "none") != "none" else None,
            position=_next_position(db, "todo"),
        )
        db.add(task)
        db.flush()
        db.refresh(task)
        created_tasks.append(task)

    if created_tasks:
        db.commit()

    # Strip markers from the displayed response
    return re.sub(marker_pattern, '', response_text).strip()


