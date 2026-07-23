"""Tests for phase_service — the single source of truth for daily target resolution."""

import os
from backend.models import Phase, Refeed
from backend.services.phase_service import resolve_targets


def test_no_phase_returns_env_defaults(db, monkeypatch):
    monkeypatch.setenv("DAILY_CALORIE_TARGET", "1850")
    monkeypatch.setenv("DAILY_PROTEIN_TARGET", "125")
    monkeypatch.setenv("DAILY_CARBS_TARGET", "250")
    monkeypatch.setenv("DAILY_FAT_TARGET", "50")
    monkeypatch.setenv("DAILY_FIBER_TARGET", "30")

    result = resolve_targets("2026-05-10", db)

    assert result.calories == 1850
    assert result.protein_g == 125
    assert result.carbs_g == 250
    assert result.fat_g == 50
    assert result.fiber_g == 30
    assert result.source == "defaults"
    assert result.phase_type is None
    assert result.phase_id is None
    assert result.refeed_id is None
    assert result.day_of_phase is None
    assert result.total_phase_days is None


def test_open_ended_phase_returns_phase_targets(db):
    phase = Phase(
        phase_type="cut", start_date="2026-04-26", end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(phase)
    db.commit()

    result = resolve_targets("2026-05-10", db)

    assert result.source == "phase"
    assert result.calories == 1850
    assert result.phase_type == "cut"
    assert result.phase_id == phase.id
    assert result.day_of_phase == 15            # Apr 26 → May 10 inclusive
    assert result.total_phase_days is None      # open-ended


def test_bounded_phase_returns_total_days(db):
    db.add(Phase(
        phase_type="bulk", start_date="2026-01-01", end_date="2026-03-31",
        target_calories=2800, target_protein_g=180, target_carbs_g=400,
        target_fat_g=80, target_fiber_g=35,
    ))
    db.commit()

    result = resolve_targets("2026-02-15", db)

    assert result.source == "phase"
    assert result.calories == 2800
    assert result.day_of_phase == 46
    assert result.total_phase_days == 90


def test_date_past_end_date_returns_defaults(db):
    db.add(Phase(
        phase_type="cut", start_date="2026-01-01", end_date="2026-01-31",
        target_calories=1700, target_protein_g=180, target_carbs_g=160,
        target_fat_g=55, target_fiber_g=30,
    ))
    db.commit()

    result = resolve_targets("2026-02-15", db)

    assert result.source == "defaults"
    assert result.phase_id is None


def test_refeed_window_overrides_cut_targets(db):
    phase = Phase(
        phase_type="cut", start_date="2026-04-01", end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(phase)
    db.commit()
    refeed = Refeed(
        phase_id=phase.id, start_date="2026-04-26", end_date="2026-05-09",
        target_calories=2350, target_protein_g=180, target_carbs_g=280,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(refeed)
    db.commit()

    result = resolve_targets("2026-05-08", db)

    assert result.source == "refeed"
    assert result.calories == 2350
    assert result.phase_type == "cut"
    assert result.phase_id == phase.id
    assert result.refeed_id == refeed.id
    assert result.day_of_phase == 38            # Apr 1 → May 8 inclusive
    assert result.refeed_day == 13              # Apr 26 → May 8 inclusive
    assert result.refeed_total_days == 14


def test_date_outside_refeed_window_uses_phase(db):
    phase = Phase(
        phase_type="cut", start_date="2026-04-01", end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(phase)
    db.commit()
    db.add(Refeed(
        phase_id=phase.id, start_date="2026-04-26", end_date="2026-05-09",
        target_calories=2350, target_protein_g=180, target_carbs_g=280,
        target_fat_g=60, target_fiber_g=30,
    ))
    db.commit()

    result = resolve_targets("2026-04-20", db)        # before refeed window

    assert result.source == "phase"
    assert result.calories == 1850
    assert result.refeed_id is None


def test_refeed_attached_to_non_cut_is_ignored_defensively(db):
    """Refeeds shouldn't attach to maintenance/bulk (router rejects), but if
    one exists, the resolver returns phase targets — never refeed."""
    phase = Phase(
        phase_type="maintenance", start_date="2026-04-01", end_date=None,
        target_calories=2200, target_protein_g=160, target_carbs_g=240,
        target_fat_g=70, target_fiber_g=30,
    )
    db.add(phase)
    db.commit()
    db.add(Refeed(
        phase_id=phase.id, start_date="2026-04-15", end_date="2026-04-20",
        target_calories=3000, target_protein_g=180, target_carbs_g=400,
        target_fat_g=70, target_fiber_g=30,
    ))
    db.commit()

    result = resolve_targets("2026-04-17", db)

    assert result.source == "phase"
    assert result.calories == 2200


def test_phase_context_line_no_phase(db):
    from backend.services.phase_service import build_phase_context_line

    line = build_phase_context_line("2026-05-10", db)

    assert "no active phase" in line.lower()
    assert "default" in line.lower()


def test_phase_context_line_active_cut_no_refeed(db):
    from backend.services.phase_service import build_phase_context_line

    db.add(Phase(
        phase_type="cut", start_date="2026-04-26", end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    ))
    db.commit()

    line = build_phase_context_line("2026-05-10", db)

    assert "Cut" in line
    assert "day 15" in line
    assert "1850" in line
    assert "180g P" in line


def test_phase_context_line_active_refeed(db):
    from backend.services.phase_service import build_phase_context_line

    phase = Phase(
        phase_type="cut", start_date="2026-04-01", end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(phase); db.commit()
    db.add(Refeed(
        phase_id=phase.id, start_date="2026-04-26", end_date="2026-05-09",
        target_calories=2350, target_protein_g=180, target_carbs_g=280,
        target_fat_g=60, target_fiber_g=30,
    ))
    db.commit()

    line = build_phase_context_line("2026-05-08", db)

    assert "Cut" in line
    assert "day 38" in line                 # day-of-phase
    assert "Refeed window" in line
    assert "day 13 of 14" in line
    assert "2350" in line
