"""
Schedule router — template blocks and time blocks for the week-view calendar.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import TemplateBlock, TimeBlock
from ..schemas import (
    TemplateBlockCreate, TemplateBlockUpdate, TemplateBlockResponse,
    TimeBlockCreate, TimeBlockUpdate, TimeBlockResponse,
    TemplateApplyRequest, WeeklyReviewResponse,
)
from ..services.schedule_service import apply_template, enrich_blocks, compute_review

router = APIRouter(prefix="/api/schedule", tags=["schedule"])


# ==========================================
# Template Block CRUD
# ==========================================

@router.get("/templates", response_model=list[TemplateBlockResponse])
async def list_templates(db: Session = Depends(get_db)):
    """List all template blocks."""
    return db.query(TemplateBlock).order_by(TemplateBlock.day_of_week, TemplateBlock.start_time).all()


@router.post("/templates", response_model=TemplateBlockResponse)
async def create_template(data: TemplateBlockCreate, db: Session = Depends(get_db)):
    """Create a new template block."""
    block = TemplateBlock(**data.model_dump())
    db.add(block)
    db.commit()
    db.refresh(block)
    return block


@router.put("/templates/{block_id}", response_model=TemplateBlockResponse)
async def update_template(block_id: int, data: TemplateBlockUpdate, db: Session = Depends(get_db)):
    """Update a template block."""
    block = db.query(TemplateBlock).filter(TemplateBlock.id == block_id).first()
    if not block:
        raise HTTPException(status_code=404, detail="Template block not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(block, field, value)
    db.commit()
    db.refresh(block)
    return block


@router.delete("/templates/{block_id}")
async def delete_template(block_id: int, db: Session = Depends(get_db)):
    """Delete a template block."""
    block = db.query(TemplateBlock).filter(TemplateBlock.id == block_id).first()
    if not block:
        raise HTTPException(status_code=404, detail="Template block not found")
    db.delete(block)
    db.commit()
    return {"ok": True}


@router.post("/templates/apply", response_model=list[TimeBlockResponse])
async def apply_template_to_week(data: TemplateApplyRequest, db: Session = Depends(get_db)):
    """Apply all template blocks to a specific week. Skips duplicates."""
    created = apply_template(db, data.week_start_date)
    enriched = enrich_blocks(db, created)
    return enriched


# ==========================================
# Time Block CRUD
# ==========================================

@router.get("/blocks", response_model=list[TimeBlockResponse])
async def list_blocks(
    week_start: str = Query(..., description="Monday date YYYY-MM-DD"),
    db: Session = Depends(get_db),
):
    """List all time blocks for a given week, enriched with auto-completion."""
    from ..services.schedule_service import get_week_dates
    dates = get_week_dates(week_start)
    blocks = (
        db.query(TimeBlock)
        .filter(TimeBlock.date.in_(dates))
        .order_by(TimeBlock.date, TimeBlock.start_time)
        .all()
    )
    enriched = enrich_blocks(db, blocks)
    return enriched


@router.post("/blocks", response_model=TimeBlockResponse)
async def create_block(data: TimeBlockCreate, db: Session = Depends(get_db)):
    """Create an ad-hoc time block."""
    block = TimeBlock(**data.model_dump())
    db.add(block)
    db.commit()
    db.refresh(block)
    enriched = enrich_blocks(db, [block])
    return enriched[0]


@router.put("/blocks/{block_id}", response_model=TimeBlockResponse)
async def update_block(block_id: int, data: TimeBlockUpdate, db: Session = Depends(get_db)):
    """Update a time block."""
    block = db.query(TimeBlock).filter(TimeBlock.id == block_id).first()
    if not block:
        raise HTTPException(status_code=404, detail="Time block not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(block, field, value)
    block.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(block)
    enriched = enrich_blocks(db, [block])
    return enriched[0]


@router.delete("/blocks/week")
async def clear_week(
    week_start: str = Query(..., description="Monday date YYYY-MM-DD"),
    db: Session = Depends(get_db),
):
    """Delete all time blocks for a given week."""
    from ..services.schedule_service import get_week_dates
    dates = get_week_dates(week_start)
    count = db.query(TimeBlock).filter(TimeBlock.date.in_(dates)).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "deleted": count}


@router.delete("/blocks/{block_id}")
async def delete_block(block_id: int, db: Session = Depends(get_db)):
    """Delete a time block."""
    block = db.query(TimeBlock).filter(TimeBlock.id == block_id).first()
    if not block:
        raise HTTPException(status_code=404, detail="Time block not found")
    db.delete(block)
    db.commit()
    return {"ok": True}


# ==========================================
# Weekly Review
# ==========================================

@router.get("/blocks/review", response_model=WeeklyReviewResponse)
async def get_review(
    week_start: str = Query(..., description="Monday date YYYY-MM-DD"),
    db: Session = Depends(get_db),
):
    """Get weekly review stats: adherence, category breakdown, trend."""
    return compute_review(db, week_start)
