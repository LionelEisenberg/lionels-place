"""Tests for /api/phases router endpoints."""

import asyncio
from datetime import date

import pytest
from fastapi import HTTPException

from backend.models import Phase, Refeed
from backend.routers.phases import (
    list_phases,
    get_current_phase,
    create_phase,
    update_phase,
    delete_phase,
    create_refeed,
    update_refeed,
    delete_refeed,
    get_weight_projection,
)
from backend.schemas import (
    PhaseCreate, PhaseUpdate, RefeedCreate, RefeedUpdate,
)


def _phase_payload(**overrides):
    base = dict(
        phase_type="cut",
        start_date="2026-04-01",
        end_date=None,
        target_calories=1850,
        target_protein_g=180,
        target_carbs_g=180,
        target_fat_g=60,
        target_fiber_g=30,
        target_weight_lbs=165,
        notes=None,
    )
    base.update(overrides)
    return PhaseCreate(**base)


def _refeed_payload(**overrides):
    base = dict(
        start_date="2026-04-26",
        end_date="2026-05-09",
        target_calories=2350,
        target_protein_g=180,
        target_carbs_g=280,
        target_fat_g=60,
        target_fiber_g=30,
        notes=None,
    )
    base.update(overrides)
    return RefeedCreate(**base)


def test_create_phase_persists_row(db):
    result = asyncio.run(create_phase(_phase_payload(), db=db))

    assert result.id is not None
    assert result.phase_type == "cut"
    assert result.target_calories == 1850
    assert result.refeeds == []


def test_create_phase_auto_closes_prior_open_phase(db):
    asyncio.run(create_phase(_phase_payload(start_date="2026-01-01"), db=db))
    asyncio.run(create_phase(
        _phase_payload(phase_type="maintenance", start_date="2026-04-15", target_calories=2200),
        db=db,
    ))

    phases = db.query(Phase).order_by(Phase.start_date).all()
    assert len(phases) == 2
    assert phases[0].end_date == "2026-04-14"        # auto-closed
    assert phases[1].end_date is None                # the new open phase


def test_create_phase_rejects_overlap_with_closed_phase(db):
    asyncio.run(create_phase(
        _phase_payload(start_date="2026-01-01", end_date="2026-03-31"),
        db=db,
    ))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_phase(
            _phase_payload(phase_type="bulk", start_date="2026-02-15", end_date="2026-04-30"),
            db=db,
        ))
    assert exc.value.status_code == 400


def test_get_current_phase_returns_active_phase(db):
    today_iso = date.today().isoformat()
    asyncio.run(create_phase(_phase_payload(start_date="2026-01-01"), db=db))

    result = asyncio.run(get_current_phase(db=db))

    assert result.phase is not None
    assert result.phase.phase_type == "cut"
    assert result.day_of_phase >= 1
    assert result.active_refeed is None


def test_get_current_phase_returns_null_when_none_active(db):
    result = asyncio.run(get_current_phase(db=db))
    assert result.phase is None
    assert result.day_of_phase is None


def test_create_refeed_attaches_to_cut_phase(db):
    phase_resp = asyncio.run(create_phase(_phase_payload(start_date="2026-01-01"), db=db))

    refeed = asyncio.run(create_refeed(phase_resp.id, _refeed_payload(), db=db))

    assert refeed.id is not None
    assert refeed.phase_id == phase_resp.id
    assert refeed.target_calories == 2350


def test_create_refeed_rejects_non_cut_parent(db):
    phase_resp = asyncio.run(create_phase(
        _phase_payload(phase_type="maintenance", start_date="2026-01-01", target_calories=2200),
        db=db,
    ))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_refeed(phase_resp.id, _refeed_payload(), db=db))
    assert exc.value.status_code == 400


def test_create_refeed_rejects_outside_parent_window(db):
    phase_resp = asyncio.run(create_phase(
        _phase_payload(start_date="2026-02-01", end_date="2026-04-30"),
        db=db,
    ))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_refeed(
            phase_resp.id,
            _refeed_payload(start_date="2026-05-01", end_date="2026-05-07"),
            db=db,
        ))
    assert exc.value.status_code == 400


def test_delete_phase_cascades_to_refeeds(db):
    phase_resp = asyncio.run(create_phase(_phase_payload(start_date="2026-01-01"), db=db))
    asyncio.run(create_refeed(phase_resp.id, _refeed_payload(), db=db))

    asyncio.run(delete_phase(phase_resp.id, db=db))

    assert db.query(Refeed).count() == 0
    assert db.query(Phase).count() == 0


def test_update_phase_rejects_overlap_with_other_phase(db):
    asyncio.run(create_phase(
        _phase_payload(start_date="2026-01-01", end_date="2026-01-31"),
        db=db,
    ))
    p2 = asyncio.run(create_phase(
        _phase_payload(start_date="2026-02-01", end_date="2026-02-28"),
        db=db,
    ))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(update_phase(
            p2.id, PhaseUpdate(start_date="2026-01-15"), db=db,
        ))
    assert exc.value.status_code == 400


def test_get_weight_projection_returns_404_when_phase_missing(db):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(get_weight_projection(999, db=db))
    assert exc.value.status_code == 404


def test_get_weight_projection_returns_400_when_no_target_weight(db):
    p = asyncio.run(create_phase(
        _phase_payload(target_weight_lbs=None), db=db,
    ))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(get_weight_projection(p.id, db=db))
    assert exc.value.status_code == 400


def test_get_weight_projection_returns_target_when_no_data(db):
    p = asyncio.run(create_phase(_phase_payload(target_weight_lbs=165), db=db))
    result = asyncio.run(get_weight_projection(p.id, db=db))
    assert result.target_value == 165
    assert result.current_value is None             # no DailySummary rows seeded
    assert result.projected_date is None
