"""running_totals must use phase_service.resolve_targets, not the legacy Goal lookup."""

import asyncio
import zoneinfo
from datetime import date, datetime

from backend.models import Phase, Refeed
from backend.routers.daily import get_today


def _today() -> str:
    # Match get_today's America/Los_Angeles "today" so phase windows align
    # regardless of the test runner's UTC offset.
    return datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")


def test_running_totals_uses_phase_calorie_target(db, monkeypatch):
    monkeypatch.setenv("DAILY_CALORIE_TARGET", "1850")     # env default
    db.add(Phase(
        phase_type="cut", start_date=_today(), end_date=None,
        target_calories=1700, target_protein_g=200, target_carbs_g=160,
        target_fat_g=55, target_fiber_g=35,
    ))
    db.commit()

    result = asyncio.run(get_today(db=db))

    assert result.calorie_target == 1700                    # phase wins
    assert result.protein_target == 200
    assert result.carbs_target == 160
    assert result.fat_target == 55
    assert result.fiber_target == 35
    assert result.phase_type == "cut"
    assert result.phase_day == 1
    assert result.in_refeed is False


def test_running_totals_uses_refeed_target_when_in_window(db):
    phase = Phase(
        phase_type="cut", start_date="2026-01-01", end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    )
    db.add(phase); db.commit()
    today_iso = _today()
    db.add(Refeed(
        phase_id=phase.id, start_date=today_iso, end_date=today_iso,
        target_calories=2350, target_protein_g=180, target_carbs_g=280,
        target_fat_g=60, target_fiber_g=30,
    ))
    db.commit()

    result = asyncio.run(get_today(db=db))

    assert result.calorie_target == 2350
    assert result.in_refeed is True
    assert result.refeed_day == 1
    assert result.refeed_total_days == 1


def test_running_totals_falls_back_to_env_defaults_with_no_phase(db, monkeypatch):
    monkeypatch.setenv("DAILY_CALORIE_TARGET", "1850")
    monkeypatch.setenv("DAILY_PROTEIN_TARGET", "125")

    result = asyncio.run(get_today(db=db))

    assert result.calorie_target == 1850
    assert result.protein_target == 125
    assert result.phase_type is None
