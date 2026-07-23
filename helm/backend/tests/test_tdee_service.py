"""Tests for tdee_service.py — TDEE estimation via formula and CICO regression."""

import pytest
from backend.services.tdee_service import compute_formula_tdee, compute_bmr, LBS_PER_KG, HEIGHT_CM, AGE


def _expected_bmr_tdee(weight_lbs: float, factor: float) -> float:
    """Hand-calculate expected TDEE using Mifflin-St Jeor formula."""
    weight_kg = weight_lbs * LBS_PER_KG
    bmr = 10 * weight_kg + 6.25 * HEIGHT_CM - 5 * AGE + 5
    return bmr * factor


@pytest.mark.parametrize("weight_lbs, workout_days, activity_factor", [
    (180.0, 0, 1.2),      # Sedentary (0 days)
    (180.0, 1, 1.375),    # Light (≤3 days)
    (180.0, 2, 1.375),    # Light
    (180.0, 3, 1.375),    # Light (boundary: ≤3)
    (180.0, 4, 1.55),     # Moderate (≤6 days)
    (180.0, 5, 1.55),     # Moderate
    (180.0, 6, 1.55),     # Moderate (boundary: ≤6)
    (180.0, 7, 1.725),    # Active (>6 days)
    (150.0, 3, 1.375),    # Lighter person, light activity
    (220.0, 5, 1.55),     # Heavier person, moderate
])
def test_compute_formula_tdee(weight_lbs, workout_days, activity_factor):
    expected = _expected_bmr_tdee(weight_lbs, activity_factor)
    result = compute_formula_tdee(weight_lbs, workout_days)
    assert result == pytest.approx(expected, rel=1e-6)


from backend.services.tdee_service import compute_cico_tdee_from_db, KCAL_PER_LB, MIN_STABLE_DAYS
from backend.models import DailySummary
from datetime import datetime, timedelta


class TestComputeCicoTdee:
    def test_insufficient_data_returns_none(self, db):
        db.add(DailySummary(
            date=datetime.now().strftime("%Y-%m-%d"),
            weight_lbs=180.0, calories_in=2000,
        ))
        db.commit()
        tdee, n, is_stable = compute_cico_tdee_from_db(db)
        assert tdee is None
        assert n == 1
        assert is_stable is False

    def test_stable_weight_tdee_approx_avg_calories(self, db):
        now = datetime.now()
        for i in range(20):
            db.add(DailySummary(
                date=(now - timedelta(days=i)).strftime("%Y-%m-%d"),
                weight_lbs=180.0,
                calories_in=2500,
            ))
        db.commit()
        tdee, n, is_stable = compute_cico_tdee_from_db(db)
        assert tdee is not None
        assert tdee == pytest.approx(2500, abs=50)
        assert n == 20
        assert is_stable is False  # 20 < MIN_STABLE_DAYS (28)

    def test_weight_loss_tdee_higher_than_intake(self, db):
        now = datetime.now()
        for i in range(20):
            db.add(DailySummary(
                date=(now - timedelta(days=i)).strftime("%Y-%m-%d"),
                weight_lbs=180.0 + (i * 0.1),
                calories_in=2000,
            ))
        db.commit()
        tdee, n, is_stable = compute_cico_tdee_from_db(db)
        assert tdee is not None
        assert tdee > 2000

    def test_rejects_implausible_values(self, db):
        now = datetime.now()
        for i in range(20):
            db.add(DailySummary(
                date=(now - timedelta(days=i)).strftime("%Y-%m-%d"),
                weight_lbs=180.0 - (i * 2),
                calories_in=500,
            ))
        db.commit()
        tdee, n, is_stable = compute_cico_tdee_from_db(db)
        assert tdee is None

    def test_stable_when_enough_days(self, db):
        """is_stable is True only when n >= MIN_STABLE_DAYS (28)."""
        now = datetime.now()
        for i in range(30):
            db.add(DailySummary(
                date=(now - timedelta(days=i)).strftime("%Y-%m-%d"),
                weight_lbs=180.0,
                calories_in=2500,
            ))
        db.commit()
        tdee, n, is_stable = compute_cico_tdee_from_db(db)
        assert tdee is not None
        assert n == 30
        assert is_stable is True  # 30 >= 28
