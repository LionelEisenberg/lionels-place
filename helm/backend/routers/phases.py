"""
Phases router — replaces the Goals router. CRUD for nutrition phases
(cut/maintenance/bulk) and their nested refeed sub-ranges.
"""

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Phase, Refeed
from ..schemas import (
    PhaseCreate, PhaseUpdate, PhaseResponse,
    RefeedCreate, RefeedUpdate, RefeedResponse,
    CurrentPhaseResponse,
    WeightProjectionResponse,
)
from ..services import phase_service
from ..services.projection import project_weight_to_target

router = APIRouter(prefix="/api/phases", tags=["phases"])


@router.get("", response_model=list[PhaseResponse])
async def list_phases(db: Session = Depends(get_db)):
    """List all phases, most recent first, with nested refeeds."""
    return (
        db.query(Phase)
        .order_by(Phase.start_date.desc())
        .all()
    )


@router.get("/current", response_model=CurrentPhaseResponse)
async def get_current_phase(db: Session = Depends(get_db)):
    """Return today's active phase + active refeed (or null)."""
    today = datetime.utcnow().date().strftime("%Y-%m-%d")
    resolved = phase_service.resolve_targets(today, db)

    if resolved.source == "defaults":
        return CurrentPhaseResponse(
            phase=None, active_refeed=None,
            day_of_phase=None, total_phase_days=None,
            refeed_day=None, refeed_total_days=None,
        )

    phase = db.query(Phase).filter(Phase.id == resolved.phase_id).first()
    refeed = (
        db.query(Refeed).filter(Refeed.id == resolved.refeed_id).first()
        if resolved.refeed_id else None
    )
    return CurrentPhaseResponse(
        phase=phase,
        active_refeed=refeed,
        day_of_phase=resolved.day_of_phase,
        total_phase_days=resolved.total_phase_days,
        refeed_day=resolved.refeed_day,
        refeed_total_days=resolved.refeed_total_days,
    )


@router.post("", response_model=PhaseResponse)
async def create_phase(data: PhaseCreate, db: Session = Depends(get_db)):
    """Create a new phase. Auto-closes the prior open phase if any."""
    phase_service.validate_date_order(data.start_date, data.end_date)
    phase_service.auto_close_prior_open_phase(db, data.start_date)
    phase_service.validate_no_phase_overlap(
        db, data.start_date, data.end_date, exclude_phase_id=None,
    )

    phase = Phase(**data.model_dump())
    db.add(phase)
    db.commit()
    db.refresh(phase)
    return phase


@router.put("/{phase_id}", response_model=PhaseResponse)
async def update_phase(phase_id: int, data: PhaseUpdate, db: Session = Depends(get_db)):
    phase = db.query(Phase).filter(Phase.id == phase_id).first()
    if phase is None:
        raise HTTPException(status_code=404, detail="Phase not found")

    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(phase, field, value)

    phase_service.validate_date_order(phase.start_date, phase.end_date)
    phase_service.validate_no_phase_overlap(
        db, phase.start_date, phase.end_date, exclude_phase_id=phase.id,
    )

    # Re-validate any existing refeeds against the (possibly new) phase window
    for refeed in phase.refeeds:
        phase_service.validate_refeed(
            db, phase, refeed.start_date, refeed.end_date,
            exclude_refeed_id=refeed.id,
        )

    db.commit()
    db.refresh(phase)
    return phase


@router.delete("/{phase_id}")
async def delete_phase(phase_id: int, db: Session = Depends(get_db)):
    phase = db.query(Phase).filter(Phase.id == phase_id).first()
    if phase is None:
        raise HTTPException(status_code=404, detail="Phase not found")
    db.delete(phase)         # cascade deletes refeeds via FK ON DELETE CASCADE
    db.commit()
    return {"ok": True}


@router.post("/{phase_id}/refeeds", response_model=RefeedResponse)
async def create_refeed(
    phase_id: int, data: RefeedCreate, db: Session = Depends(get_db),
):
    phase = db.query(Phase).filter(Phase.id == phase_id).first()
    if phase is None:
        raise HTTPException(status_code=404, detail="Phase not found")

    phase_service.validate_refeed(
        db, phase, data.start_date, data.end_date, exclude_refeed_id=None,
    )

    refeed = Refeed(phase_id=phase.id, **data.model_dump())
    db.add(refeed)
    db.commit()
    db.refresh(refeed)
    return refeed


@router.put("/refeeds/{refeed_id}", response_model=RefeedResponse)
async def update_refeed(
    refeed_id: int, data: RefeedUpdate, db: Session = Depends(get_db),
):
    refeed = db.query(Refeed).filter(Refeed.id == refeed_id).first()
    if refeed is None:
        raise HTTPException(status_code=404, detail="Refeed not found")

    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(refeed, field, value)

    phase_service.validate_refeed(
        db, refeed.phase, refeed.start_date, refeed.end_date,
        exclude_refeed_id=refeed.id,
    )
    db.commit()
    db.refresh(refeed)
    return refeed


@router.delete("/refeeds/{refeed_id}")
async def delete_refeed(refeed_id: int, db: Session = Depends(get_db)):
    refeed = db.query(Refeed).filter(Refeed.id == refeed_id).first()
    if refeed is None:
        raise HTTPException(status_code=404, detail="Refeed not found")
    db.delete(refeed)
    db.commit()
    return {"ok": True}


@router.get("/{phase_id}/weight-projection", response_model=WeightProjectionResponse)
async def get_weight_projection(
    phase_id: int,
    window_days: Annotated[int, Query(ge=0, le=365, description="Trailing window of weight data to regress on; 0 = all history")] = 60,
    db: Session = Depends(get_db),
):
    phase = db.query(Phase).filter(Phase.id == phase_id).first()
    if phase is None:
        raise HTTPException(status_code=404, detail="Phase not found")
    if phase.target_weight_lbs is None:
        raise HTTPException(
            status_code=400,
            detail="Phase has no target_weight_lbs — no projection available",
        )
    proj = project_weight_to_target(
        phase.target_weight_lbs,
        db,
        window_days=window_days or None,  # 0 → all history ("Overall" mode)
        phase_start_date=phase.start_date,
    )
    return WeightProjectionResponse(
        target_value=proj.target_value,
        current_value=proj.current_value,
        starting_value=proj.starting_value,
        projected_date=proj.projected_date,
        pace_per_week=proj.pace_per_week,
        days_remaining=proj.days_remaining,
    )
