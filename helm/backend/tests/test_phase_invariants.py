"""Tests for phase_service validation helpers."""

import pytest
from fastapi import HTTPException

from backend.models import Phase, Refeed
from backend.services import phase_service


def test_validate_no_phase_overlap_passes_when_clear(db):
    db.add(Phase(
        phase_type="cut", start_date="2026-01-01", end_date="2026-01-31",
        target_calories=1700, target_protein_g=180, target_carbs_g=160,
        target_fat_g=55, target_fiber_g=30,
    ))
    db.commit()

    # Adding a maintenance phase starting Feb 1 — no overlap, no error
    phase_service.validate_no_phase_overlap(
        db, start_date="2026-02-01", end_date=None, exclude_phase_id=None,
    )


def test_validate_no_phase_overlap_rejects_overlap(db):
    db.add(Phase(
        phase_type="cut", start_date="2026-01-01", end_date="2026-03-31",
        target_calories=1700, target_protein_g=180, target_carbs_g=160,
        target_fat_g=55, target_fiber_g=30,
    ))
    db.commit()

    with pytest.raises(HTTPException) as exc:
        phase_service.validate_no_phase_overlap(
            db, start_date="2026-02-15", end_date="2026-04-30", exclude_phase_id=None,
        )
    assert exc.value.status_code == 400
    assert "overlap" in exc.value.detail.lower()


def test_validate_no_phase_overlap_excludes_self_on_update(db):
    """When updating a phase, its own row must not count as an overlap."""
    p = Phase(
        phase_type="cut", start_date="2026-01-01", end_date="2026-03-31",
        target_calories=1700, target_protein_g=180, target_carbs_g=160,
        target_fat_g=55, target_fiber_g=30,
    )
    db.add(p); db.commit()

    # Updating the same phase (extending its end_date) — no overlap with self
    phase_service.validate_no_phase_overlap(
        db, start_date="2026-01-01", end_date="2026-04-30", exclude_phase_id=p.id,
    )


def test_validate_date_order_rejects_inverted(db):
    with pytest.raises(HTTPException) as exc:
        phase_service.validate_date_order("2026-05-10", "2026-05-01")
    assert exc.value.status_code == 400


def test_validate_date_order_accepts_open_ended(db):
    phase_service.validate_date_order("2026-05-10", None)        # no error


def test_auto_close_prior_open_phase(db):
    prior = Phase(
        phase_type="cut", start_date="2026-01-01", end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(prior); db.commit()

    closed = phase_service.auto_close_prior_open_phase(db, "2026-04-15")
    db.commit()

    assert closed.id == prior.id
    assert prior.end_date == "2026-04-14"


def test_auto_close_excludes_self_on_update(db):
    p = Phase(
        phase_type="cut", start_date="2026-01-01", end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(p); db.commit()

    closed = phase_service.auto_close_prior_open_phase(
        db, "2026-04-15", exclude_phase_id=p.id,
    )
    assert closed is None                       # didn't close itself


def test_validate_refeed_rejects_non_cut_parent(db):
    parent = Phase(
        phase_type="maintenance", start_date="2026-01-01", end_date=None,
        target_calories=2200, target_protein_g=160, target_carbs_g=240,
        target_fat_g=70, target_fiber_g=30,
    )
    db.add(parent); db.commit()

    with pytest.raises(HTTPException) as exc:
        phase_service.validate_refeed(
            db, parent, "2026-02-01", "2026-02-05", exclude_refeed_id=None,
        )
    assert exc.value.status_code == 400
    assert "cut" in exc.value.detail.lower()


def test_validate_refeed_rejects_outside_parent_window(db):
    parent = Phase(
        phase_type="cut", start_date="2026-02-01", end_date="2026-04-30",
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(parent); db.commit()

    # Before parent start
    with pytest.raises(HTTPException):
        phase_service.validate_refeed(
            db, parent, "2026-01-15", "2026-01-20", exclude_refeed_id=None,
        )
    # After parent end
    with pytest.raises(HTTPException):
        phase_service.validate_refeed(
            db, parent, "2026-04-25", "2026-05-10", exclude_refeed_id=None,
        )


def test_validate_refeed_rejects_sibling_overlap(db):
    parent = Phase(
        phase_type="cut", start_date="2026-01-01", end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(parent); db.commit()
    db.add(Refeed(
        phase_id=parent.id, start_date="2026-02-01", end_date="2026-02-07",
        target_calories=2350, target_protein_g=180, target_carbs_g=280,
        target_fat_g=60, target_fiber_g=30,
    )); db.commit()

    with pytest.raises(HTTPException):
        phase_service.validate_refeed(
            db, parent, "2026-02-05", "2026-02-10", exclude_refeed_id=None,
        )
