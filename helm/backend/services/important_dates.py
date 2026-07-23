"""Important dates — hard-coded birthdays, anniversaries, and one-off events
surfaced on the Helm dashboard "Upcoming" card.

There is intentionally NO UI for editing these. Add or remove dates by editing
``IMPORTANT_DATES`` below and saving; the backend hot-reloads.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class ImportantDate:
    """A single curated date. Recurring entries repeat yearly on (month, day);
    one-off entries (``recurring=False``) happen once on (year, month, day)."""

    name: str
    month: int
    day: int
    category: str = "event"      # "birthday" | "anniversary" | "event"
    recurring: bool = True
    year: int | None = None       # required when recurring=False


@dataclass(frozen=True)
class UpcomingDate:
    """A render-ready entry returned to the dashboard."""

    name: str
    category: str
    emoji: str
    date: str          # ISO "YYYY-MM-DD" of the next occurrence
    days_until: int


# ==========================================
# Helpers
# ==========================================

_CATEGORY_EMOJI: dict[str, str] = {
    "birthday": "🎂",
    "anniversary": "💍",
    "event": "⭐",
}
_FALLBACK_EMOJI = "📅"


def _emoji_for(category: str) -> str:
    return _CATEGORY_EMOJI.get(category, _FALLBACK_EMOJI)


def _safe_date(year: int, month: int, day: int) -> date:
    """Build a date, rolling a Feb 29 in a non-leap year back to Feb 28."""
    try:
        return date(year, month, day)
    except ValueError:
        if month == 2 and day == 29:
            return date(year, 2, 28)
        raise


def _next_occurrence(entry: ImportantDate, today: date) -> date | None:
    """The next on-or-after-today occurrence of an entry, or None if it has
    none (a one-off whose date is already in the past)."""
    if entry.recurring:
        candidate = _safe_date(today.year, entry.month, entry.day)
        if candidate < today:
            candidate = _safe_date(today.year + 1, entry.month, entry.day)
        return candidate
    candidate = date(entry.year, entry.month, entry.day)
    return candidate if candidate >= today else None


# ==========================================
# Public API
# ==========================================

def upcoming_dates(
    today: date,
    window_days: int = 30,
    dates: list[ImportantDate] | None = None,
) -> list[UpcomingDate]:
    """Curated dates within ``window_days`` of ``today``, sorted soonest-first.

    If nothing falls inside the window, the single nearest upcoming date is
    returned anyway so the card is never empty. Returns ``[]`` only when no
    entry has any future occurrence.
    """
    if dates is None:
        dates = IMPORTANT_DATES

    computed: list[UpcomingDate] = []
    for entry in dates:
        occurrence = _next_occurrence(entry, today)
        if occurrence is None:
            continue
        computed.append(
            UpcomingDate(
                name=entry.name,
                category=entry.category,
                emoji=_emoji_for(entry.category),
                date=occurrence.isoformat(),
                days_until=(occurrence - today).days,
            )
        )

    computed.sort(key=lambda u: (u.days_until, u.name))

    in_window = [u for u in computed if u.days_until <= window_days]
    if in_window:
        return in_window
    return computed[:1]  # always-next fallback (computed is already sorted)


# ==========================================
# Hard-coded source of truth — EDIT THIS LIST
# ==========================================
# Add/remove dates here, then save — the backend hot-reloads.
#   - Recurring (birthday/anniversary): ImportantDate("Name", month, day, "birthday")
#   - One-off event: ImportantDate("Name", month, day, "event", recurring=False, year=2026)
IMPORTANT_DATES: list[ImportantDate] = [
    ImportantDate("Olivia", 6, 24, "birthday"),
    ImportantDate("Oscar", 1, 13, "birthday"),
    ImportantDate("Arthur", 7, 23, "birthday"),
    ImportantDate("Norah", 5, 27, "birthday"),

    ImportantDate("Dad", 6, 21, "birthday"),
    ImportantDate("Mom", 5, 14, "birthday"),
    ImportantDate("Jim", 11, 26, "birthday"),
    ImportantDate("Jerome", 8, 26, "birthday"),
    ImportantDate("Robin", 8, 23, "birthday"),

    ImportantDate("Ryan", 7, 31, "birthday"),
    ImportantDate("Jack", 7, 30, "birthday"),
    ImportantDate("Belle", 5, 5, "birthday"),
    ImportantDate("Payton", 1, 6, "birthday"),
    ImportantDate("Unwana", 3, 31, "birthday"),
    ImportantDate("Jane", 4, 18, "birthday"),
]
