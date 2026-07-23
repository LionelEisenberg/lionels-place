"""Verify advisor_service.build_daily_context prepends a phase context line."""

from datetime import date

from backend.models import DailySummary, Phase
from backend.services.advisor_service import GeminiAdvisor as AdvisorService


def test_build_daily_context_includes_phase_line(db):
    today = date.today().isoformat()
    db.add(Phase(
        phase_type="cut", start_date=today, end_date=None,
        target_calories=1850, target_protein_g=180, target_carbs_g=180,
        target_fat_g=60, target_fiber_g=30,
    ))
    db.add(DailySummary(
        date=today, day_of_week="Sunday", weight_lbs=172,
        calories_in=1800, protein_g=180, carbs_g=180, fat_g=60,
        net_deficit=200, workout_type="Push",
    ))
    db.commit()

    summaries = db.query(DailySummary).all()
    context = AdvisorService.build_daily_context(summaries, db=db)

    assert "Current phase: Cut" in context
    assert "1850" in context


def test_build_daily_context_no_phase_line_when_none_active(db):
    db.add(DailySummary(
        date="2026-05-10", day_of_week="Sunday", weight_lbs=172,
        calories_in=1800, protein_g=180, carbs_g=180, fat_g=60,
        net_deficit=200,
    ))
    db.commit()

    summaries = db.query(DailySummary).all()
    context = AdvisorService.build_daily_context(summaries, db=db)

    assert "No active phase" in context
