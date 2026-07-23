"""parse_cardio_text — the single cardio free-text parser (absorb + migration)."""
import pytest

from backend.services.cardio_text import parse_cardio_text


def test_laps_only():
    assert parse_cardio_text("40 Laps") == (40, None, None)


def test_km_distance():
    assert parse_cardio_text("5.2 km") == (None, 5200.0, None)


def test_meters_distance():
    assert parse_cardio_text("1500m") == (None, 1500.0, None)


def test_miles_distance():
    assert parse_cardio_text("23 mi, 2 hrs") == (None, pytest.approx(23 * 1609.34), 120.0)
    assert parse_cardio_text("6 miles") == (None, pytest.approx(6 * 1609.34), None)


def test_duration_forms():
    assert parse_cardio_text("2 hrs")[2] == 120.0
    assert parse_cardio_text("45 min")[2] == 45.0
    assert parse_cardio_text("1:30")[2] == 90.0
    assert parse_cardio_text("1h30m")[2] == 90.0
    assert parse_cardio_text("1h 20min, 15.35 miles") == (None, pytest.approx(15.35 * 1609.34), 80.0)


def test_h30m_is_not_meters():
    # The "30m" inside a blanked duration span must not read as 30 meters.
    assert parse_cardio_text("1h30m")[1] is None


def test_laps_plus_duration():
    assert parse_cardio_text("40 laps, 45 min") == (40, None, 45.0)


def test_strength_text_parses_nothing():
    assert parse_cardio_text("8, 8, 7") == (None, None, None)
    assert parse_cardio_text("") == (None, None, None)
    assert parse_cardio_text(None) == (None, None, None)


def test_min_is_not_distance():
    assert parse_cardio_text("45 min")[1] is None
