"""Tests for DailySummary column defaults."""

from backend.models import DailySummary


def test_drinks_consumed_defaults_to_zero_when_not_provided(db):
    """New DailySummary rows should have drinks_consumed=0 by default,
    so dry-day stats aren't skewed by unlogged days."""
    daily = DailySummary(date="2026-04-19")
    db.add(daily)
    db.commit()
    db.refresh(daily)
    assert daily.drinks_consumed == 0
