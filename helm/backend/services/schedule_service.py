"""
Schedule service — auto-completion logic and review stats.
Reads from existing tables (workouts, meals, leetcode, tasks) to enrich
time block status without persisting changes.
"""

from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..models import TimeBlock, TemplateBlock, Workout, Meal, LeetcodeProblem, Task


def get_week_dates(week_start: str) -> list[str]:
    """Return list of 7 date strings starting from week_start (Monday)."""
    start = datetime.strptime(week_start, "%Y-%m-%d")
    return [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]


def apply_template(db: Session, week_start: str) -> list[TimeBlock]:
    """Generate TimeBlock instances from all TemplateBlocks for a given week.
    Skips if a block with the same template_block_id + date already exists."""
    dates = get_week_dates(week_start)
    templates = db.query(TemplateBlock).all()
    created = []

    for tmpl in templates:
        target_date = dates[tmpl.day_of_week]
        # Check for existing block from this template on this date
        exists = db.query(TimeBlock).filter(
            TimeBlock.template_block_id == tmpl.id,
            TimeBlock.date == target_date,
        ).first()
        if exists:
            continue

        # Skip if any existing block overlaps this time slot (preserves ad-hoc blocks)
        overlap = db.query(TimeBlock).filter(
            TimeBlock.date == target_date,
            TimeBlock.start_time < tmpl.end_time,
            TimeBlock.end_time > tmpl.start_time,
        ).first()
        if overlap:
            continue

        block = TimeBlock(
            date=target_date,
            name=tmpl.name,
            start_time=tmpl.start_time,
            end_time=tmpl.end_time,
            category=tmpl.category,
            color=tmpl.color,
            status="planned",
            template_block_id=tmpl.id,
        )
        db.add(block)
        created.append(block)

    db.commit()
    for b in created:
        db.refresh(b)
    return created


def enrich_blocks(db: Session, blocks: list[TimeBlock]) -> list[dict]:
    """Enrich blocks with auto-completion status and task info.
    Returns list of dicts ready for API response."""
    if not blocks:
        return []

    dates = list(set(b.date for b in blocks))

    # Batch-load related data for all dates in this week
    workout_dates = set(
        r[0] for r in db.query(Workout.date).filter(Workout.date.in_(dates)).distinct().all()
    )
    meal_data = {}
    for date, cal_sum in (
        db.query(Meal.date, func.sum(Meal.calories))
        .filter(Meal.date.in_(dates))
        .group_by(Meal.date)
        .all()
    ):
        meal_data[date] = cal_sum

    # solved_at is DateTime, so extract date portion for comparison
    leetcode_dates = set(
        r[0] for r in db.query(func.date(LeetcodeProblem.solved_at))
        .filter(func.date(LeetcodeProblem.solved_at).in_(dates))
        .distinct()
        .all()
    ) if dates else set()

    # Load tasks referenced by any block
    task_ids = [b.task_id for b in blocks if b.task_id]
    tasks_by_id = {}
    if task_ids:
        for t in db.query(Task).filter(Task.id.in_(task_ids)).all():
            tasks_by_id[t.id] = t

    # Load workout counts per date for detail text
    workout_counts = {}
    for date, count in (
        db.query(Workout.date, func.count(Workout.id))
        .filter(Workout.date.in_(dates))
        .group_by(Workout.date)
        .all()
    ):
        workout_counts[date] = count

    result = []
    for block in blocks:
        d = {
            "id": block.id,
            "date": block.date,
            "name": block.name,
            "start_time": block.start_time,
            "end_time": block.end_time,
            "category": block.category,
            "color": block.color,
            "status": block.status,
            "task_id": block.task_id,
            "template_block_id": block.template_block_id,
            "notes": block.notes,
            "created_at": block.created_at,
            "updated_at": block.updated_at,
            "auto_status": None,
            "auto_detail": None,
            "task_title": None,
            "task_status": None,
        }

        # Auto-completion: only for "planned" blocks (manual status wins)
        if block.status == "planned":
            if block.category == "workout" and block.date in workout_dates:
                count = workout_counts.get(block.date, 0)
                d["auto_status"] = "done"
                d["auto_detail"] = f"{count} exercise{'s' if count != 1 else ''} logged"
            elif block.category == "meals" and block.date in meal_data:
                cal = meal_data[block.date]
                d["auto_status"] = "done"
                d["auto_detail"] = f"{int(cal)} cal logged"
            elif block.category == "leetcode" and block.date in leetcode_dates:
                d["auto_status"] = "done"
                d["auto_detail"] = "problems solved"
            elif block.task_id and block.task_id in tasks_by_id:
                task = tasks_by_id[block.task_id]
                if task.status == "done":
                    d["auto_status"] = "done"
                    d["auto_detail"] = "task completed"

        # Task info enrichment
        if block.task_id and block.task_id in tasks_by_id:
            task = tasks_by_id[block.task_id]
            d["task_title"] = task.title
            d["task_status"] = task.status

        result.append(d)

    return result


def _block_hours(block) -> float:
    """Calculate duration of a block in hours."""
    start_h, start_m = map(int, block["start_time"].split(":"))
    end_h, end_m = map(int, block["end_time"].split(":"))
    return (end_h * 60 + end_m - start_h * 60 - start_m) / 60


def compute_review(db: Session, week_start: str) -> dict:
    """Compute weekly review stats for a given week."""
    dates = get_week_dates(week_start)
    blocks = db.query(TimeBlock).filter(TimeBlock.date.in_(dates)).order_by(TimeBlock.date).all()
    enriched = enrich_blocks(db, blocks)

    # Effective status: auto_status overrides "planned" status
    def effective_status(b):
        if b["auto_status"]:
            return b["auto_status"]
        return b["status"]

    total = len(enriched)
    done = sum(1 for b in enriched if effective_status(b) == "done")
    skipped = sum(1 for b in enriched if effective_status(b) == "skipped")
    adherence = (done / total * 100) if total > 0 else 0

    planned_hours = sum(_block_hours(b) for b in enriched)
    completed_hours = sum(_block_hours(b) for b in enriched if effective_status(b) == "done")

    # By category
    by_category = {}
    for b in enriched:
        cat = b["category"]
        if cat not in by_category:
            by_category[cat] = {"done": 0, "total": 0}
        by_category[cat]["total"] += 1
        if effective_status(b) == "done":
            by_category[cat]["done"] += 1

    # Skipped list
    skipped_list = []
    for b in enriched:
        if effective_status(b) == "skipped":
            skipped_list.append({
                "date": b["date"],
                "name": b["name"],
                "duration_hrs": round(_block_hours(b), 1),
            })

    # Trend: last 6 weeks including current
    trend = []
    current_start = datetime.strptime(week_start, "%Y-%m-%d")
    for i in range(5, -1, -1):
        ws = (current_start - timedelta(weeks=i)).strftime("%Y-%m-%d")
        w_dates = get_week_dates(ws)
        w_blocks = db.query(TimeBlock).filter(TimeBlock.date.in_(w_dates)).all()
        w_enriched = enrich_blocks(db, w_blocks)
        w_total = len(w_enriched)
        w_done = sum(1 for b in w_enriched if (b["auto_status"] or b["status"]) == "done")
        w_pct = (w_done / w_total * 100) if w_total > 0 else 0
        week_num = (current_start - timedelta(weeks=i)).isocalendar()[1]
        trend.append({
            "week": f"W{week_num}",
            "week_start": ws,
            "adherence_pct": round(w_pct, 1),
        })

    return {
        "adherence_pct": round(adherence, 1),
        "total_blocks": total,
        "done_blocks": done,
        "skipped_blocks": skipped,
        "planned_hours": round(planned_hours, 1),
        "completed_hours": round(completed_hours, 1),
        "by_category": by_category,
        "skipped_list": skipped_list,
        "trend": trend,
    }
