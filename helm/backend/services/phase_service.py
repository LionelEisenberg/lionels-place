"""
Phase service — single source of truth for daily target resolution.

Resolves "what's my target on date D?" by walking the active phase and any
nested refeed window inside it. Falls back to env defaults when no phase
covers the date (back-compat for the pre-phase era and for brand-new
installs).
"""

import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models import Phase, Refeed


_SourceLiteral = Literal["phase", "refeed", "defaults"]


@dataclass
class ResolvedTargets:
    """The resolved daily target for a single date."""
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    source: _SourceLiteral
    phase_type: Optional[str]
    phase_id: Optional[int]
    refeed_id: Optional[int]
    day_of_phase: Optional[int]            # 1-based; None when source='defaults'
    total_phase_days: Optional[int]        # None when phase.end_date is null
    refeed_day: Optional[int] = None       # 1-based within active refeed
    refeed_total_days: Optional[int] = None


def _env_float(name: str, default: str) -> float:
    return float(os.getenv(name, default))


def _from_env_defaults() -> ResolvedTargets:
    return ResolvedTargets(
        calories=_env_float("DAILY_CALORIE_TARGET", "1850"),
        protein_g=_env_float("DAILY_PROTEIN_TARGET", "125"),
        carbs_g=_env_float("DAILY_CARBS_TARGET", "250"),
        fat_g=_env_float("DAILY_FAT_TARGET", "50"),
        fiber_g=_env_float("DAILY_FIBER_TARGET", "30"),
        source="defaults",
        phase_type=None,
        phase_id=None,
        refeed_id=None,
        day_of_phase=None,
        total_phase_days=None,
    )


def _days_between(start_iso: str, end_iso: str) -> int:
    """Inclusive day count between two YYYY-MM-DD dates."""
    start = datetime.strptime(start_iso, "%Y-%m-%d").date()
    end = datetime.strptime(end_iso, "%Y-%m-%d").date()
    return (end - start).days + 1


def _from_phase(phase: Phase, date: str) -> ResolvedTargets:
    day_of_phase = _days_between(phase.start_date, date)
    total = _days_between(phase.start_date, phase.end_date) if phase.end_date else None
    return ResolvedTargets(
        calories=phase.target_calories,
        protein_g=phase.target_protein_g,
        carbs_g=phase.target_carbs_g,
        fat_g=phase.target_fat_g,
        fiber_g=phase.target_fiber_g,
        source="phase",
        phase_type=phase.phase_type,
        phase_id=phase.id,
        refeed_id=None,
        day_of_phase=day_of_phase,
        total_phase_days=total,
    )


def _from_refeed(phase: Phase, refeed: Refeed, date: str) -> ResolvedTargets:
    day_of_phase = _days_between(phase.start_date, date)
    total = _days_between(phase.start_date, phase.end_date) if phase.end_date else None
    return ResolvedTargets(
        calories=refeed.target_calories,
        protein_g=refeed.target_protein_g,
        carbs_g=refeed.target_carbs_g,
        fat_g=refeed.target_fat_g,
        fiber_g=refeed.target_fiber_g,
        source="refeed",
        phase_type=phase.phase_type,
        phase_id=phase.id,
        refeed_id=refeed.id,
        day_of_phase=day_of_phase,
        total_phase_days=total,
        refeed_day=_days_between(refeed.start_date, date),
        refeed_total_days=_days_between(refeed.start_date, refeed.end_date),
    )


def resolve_targets(date: str, db: Session) -> ResolvedTargets:
    """Resolve the macro target for `date` (YYYY-MM-DD)."""
    phase = (
        db.query(Phase)
        .filter(Phase.start_date <= date)
        .filter(or_(Phase.end_date >= date, Phase.end_date.is_(None)))
        .first()
    )
    if phase is None:
        return _from_env_defaults()

    if phase.phase_type == "cut":
        refeed = (
            db.query(Refeed)
            .filter(Refeed.phase_id == phase.id)
            .filter(Refeed.start_date <= date)
            .filter(Refeed.end_date >= date)
            .first()
        )
        if refeed is not None:
            return _from_refeed(phase, refeed, date)

    return _from_phase(phase, date)


def build_phase_context_line(date: str, db: Session) -> str:
    """One-line phase summary for inclusion in the AI advisor's daily context."""
    resolved = resolve_targets(date, db)

    if resolved.source == "defaults":
        return "No active phase. Targets fall back to env defaults."

    phase = db.query(Phase).filter(Phase.id == resolved.phase_id).first()
    type_label = phase.phase_type.capitalize()
    total_str = f" of {resolved.total_phase_days}" if resolved.total_phase_days else ""
    parts = [
        f"Current phase: {type_label}, day {resolved.day_of_phase}{total_str}, "
        f"target {int(phase.target_calories)} cal / {int(phase.target_protein_g)}g P / "
        f"{int(phase.target_carbs_g)}g C / {int(phase.target_fat_g)}g F."
    ]

    if resolved.source == "refeed":
        refeed = db.query(Refeed).filter(Refeed.id == resolved.refeed_id).first()
        parts.append(
            f"Refeed window: {refeed.start_date} → {refeed.end_date} "
            f"(today is day {resolved.refeed_day} of {resolved.refeed_total_days}, "
            f"target {int(refeed.target_calories)} cal / {int(refeed.target_protein_g)}g P / "
            f"{int(refeed.target_carbs_g)}g C / {int(refeed.target_fat_g)}g F)."
        )

    return " ".join(parts)


from fastapi import HTTPException


def validate_date_order(start_date: str, end_date: Optional[str]) -> None:
    """end_date must be >= start_date when set."""
    if end_date is not None and end_date < start_date:
        raise HTTPException(
            status_code=400,
            detail=f"end_date ({end_date}) must be on or after start_date ({start_date})",
        )


def validate_no_phase_overlap(
    db: Session,
    start_date: str,
    end_date: Optional[str],
    exclude_phase_id: Optional[int],
) -> None:
    """No phase may overlap with the proposed [start_date, end_date] window.

    end_date=None means open-ended; the proposed phase covers everything
    from start_date onward, so any phase that ends after start_date overlaps.
    """
    q = db.query(Phase)
    if exclude_phase_id is not None:
        q = q.filter(Phase.id != exclude_phase_id)

    for other in q.all():
        # Two windows overlap iff each starts before the other ends.
        # Treat null end_date as "infinity" using a sentinel string after any real date.
        other_end = other.end_date or "9999-12-31"
        prop_end = end_date or "9999-12-31"
        if other.start_date <= prop_end and start_date <= other_end:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Phase overlap: proposed window "
                    f"[{start_date} → {end_date or 'open'}] overlaps with existing "
                    f"phase {other.id} [{other.start_date} → {other.end_date or 'open'}]"
                ),
            )


def get_current_open_phase(db: Session) -> Optional[Phase]:
    """Return the (at most one) phase with end_date IS NULL."""
    return db.query(Phase).filter(Phase.end_date.is_(None)).first()


def auto_close_prior_open_phase(
    db: Session, new_start_date: str, exclude_phase_id: Optional[int] = None,
) -> Optional[Phase]:
    """If an open phase exists (and is not the one we're updating), set its
    end_date to (new_start_date - 1 day). Returns the closed phase, if any."""
    q = db.query(Phase).filter(Phase.end_date.is_(None))
    if exclude_phase_id is not None:
        q = q.filter(Phase.id != exclude_phase_id)
    prior = q.first()
    if prior is None:
        return None
    new_start = datetime.strptime(new_start_date, "%Y-%m-%d").date()
    prior.end_date = (new_start - timedelta(days=1)).strftime("%Y-%m-%d")
    return prior


def validate_refeed(
    db: Session,
    phase: Phase,
    start_date: str,
    end_date: str,
    exclude_refeed_id: Optional[int],
) -> None:
    """Refeed parent must be cut; dates inside parent window; no sibling overlap."""
    if phase.phase_type != "cut":
        raise HTTPException(
            status_code=400,
            detail=f"Refeeds attach only to cut phases (parent is {phase.phase_type})",
        )
    if end_date < start_date:
        raise HTTPException(
            status_code=400,
            detail=f"end_date ({end_date}) must be on or after start_date ({start_date})",
        )
    if start_date < phase.start_date:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Refeed start ({start_date}) is before parent phase start "
                f"({phase.start_date})"
            ),
        )
    if phase.end_date is not None and end_date > phase.end_date:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Refeed end ({end_date}) is after parent phase end "
                f"({phase.end_date})"
            ),
        )

    siblings_q = db.query(Refeed).filter(Refeed.phase_id == phase.id)
    if exclude_refeed_id is not None:
        siblings_q = siblings_q.filter(Refeed.id != exclude_refeed_id)
    for sib in siblings_q.all():
        if sib.start_date <= end_date and start_date <= sib.end_date:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Refeed overlaps sibling refeed {sib.id} "
                    f"[{sib.start_date} → {sib.end_date}]"
                ),
            )
