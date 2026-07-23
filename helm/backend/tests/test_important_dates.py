"""Tests for important_dates.py — next-occurrence computation, windowing, and the
always-next fallback for the dashboard "Upcoming" card. Pure logic, no DB."""

from datetime import date

from backend.services.important_dates import ImportantDate, upcoming_dates


def test_recurring_birthday_later_this_year() -> None:
    today = date(2026, 6, 7)
    entry = ImportantDate("Mom", 8, 20, "birthday")
    result = upcoming_dates(today, window_days=365, dates=[entry])
    assert len(result) == 1
    assert result[0].name == "Mom"
    assert result[0].category == "birthday"
    assert result[0].emoji == "🎂"
    assert result[0].date == "2026-08-20"
    assert result[0].days_until == (date(2026, 8, 20) - today).days


def test_recurring_birthday_already_passed_rolls_to_next_year() -> None:
    today = date(2026, 6, 7)
    entry = ImportantDate("Dad", 3, 14, "birthday")  # already passed this year
    result = upcoming_dates(today, window_days=400, dates=[entry])
    assert result[0].date == "2027-03-14"
    assert result[0].days_until == (date(2027, 3, 14) - today).days


def test_recurring_birthday_today_is_zero_days() -> None:
    today = date(2026, 6, 7)
    entry = ImportantDate("Twin", 6, 7, "birthday")
    result = upcoming_dates(today, window_days=30, dates=[entry])
    assert result[0].days_until == 0
    assert result[0].date == "2026-06-07"


def test_one_off_future_within_window_included() -> None:
    today = date(2026, 6, 7)
    entry = ImportantDate("Wedding", 6, 14, "event", recurring=False, year=2026)
    result = upcoming_dates(today, window_days=30, dates=[entry])
    assert len(result) == 1
    assert result[0].date == "2026-06-14"
    assert result[0].days_until == 7
    assert result[0].emoji == "⭐"


def test_one_off_in_the_past_is_excluded() -> None:
    today = date(2026, 6, 7)
    past = ImportantDate("Old event", 1, 1, "event", recurring=False, year=2026)
    # Only a past one-off -> no future occurrence -> empty (also exercises empty fallback).
    result = upcoming_dates(today, window_days=400, dates=[past])
    assert result == []


def test_one_off_beyond_window_surfaces_via_always_next() -> None:
    today = date(2026, 6, 7)
    entry = ImportantDate("Far wedding", 12, 25, "event", recurring=False, year=2026)
    result = upcoming_dates(today, window_days=30, dates=[entry])
    assert len(result) == 1  # window empty -> always-next fallback returns it
    assert result[0].date == "2026-12-25"


def test_window_filter_excludes_entries_just_outside() -> None:
    today = date(2026, 6, 7)
    in_window = ImportantDate("Soon", 6, 20, "birthday")    # 13 days
    out_window = ImportantDate("Later", 7, 20, "birthday")  # 43 days
    result = upcoming_dates(today, window_days=30, dates=[in_window, out_window])
    assert [r.name for r in result] == ["Soon"]


def test_always_next_returns_single_nearest_when_all_beyond_window() -> None:
    today = date(2026, 6, 7)
    a = ImportantDate("A", 9, 1, "birthday")
    b = ImportantDate("B", 12, 1, "birthday")
    result = upcoming_dates(today, window_days=30, dates=[a, b])
    assert len(result) == 1
    assert result[0].name == "A"  # nearest future entry


def test_empty_list_returns_empty() -> None:
    assert upcoming_dates(date(2026, 6, 7), dates=[]) == []


def test_leap_day_recurring_falls_back_to_feb_28_in_non_leap_year() -> None:
    today = date(2026, 2, 1)  # 2026 is not a leap year
    entry = ImportantDate("Leapling", 2, 29, "birthday")
    result = upcoming_dates(today, window_days=60, dates=[entry])
    assert result[0].date == "2026-02-28"
    assert result[0].days_until == (date(2026, 2, 28) - today).days


def test_results_sorted_ascending_by_days_until() -> None:
    today = date(2026, 6, 7)
    far = ImportantDate("Far", 6, 25, "birthday")
    near = ImportantDate("Near", 6, 10, "birthday")
    mid = ImportantDate("Mid", 6, 18, "birthday")
    result = upcoming_dates(today, window_days=30, dates=[far, near, mid])
    assert [r.name for r in result] == ["Near", "Mid", "Far"]


def test_emoji_mapping_per_category() -> None:
    today = date(2026, 6, 7)
    entries = [
        ImportantDate("B", 6, 10, "birthday"),
        ImportantDate("A", 6, 11, "anniversary"),
        ImportantDate("E", 6, 12, "event"),
        ImportantDate("U", 6, 13, "mystery"),  # unknown -> fallback glyph
    ]
    result = upcoming_dates(today, window_days=30, dates=entries)
    emoji_by_name = {r.name: r.emoji for r in result}
    assert emoji_by_name["B"] == "🎂"
    assert emoji_by_name["A"] == "💍"
    assert emoji_by_name["E"] == "⭐"
    assert emoji_by_name["U"] == "📅"
