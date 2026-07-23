"""Cardio free-text parsing — laps / distance / duration out of a carrier
string like "23 mi, 2 hrs", "40 laps" or "1h30m".

The single parser for the absorb write path and the one-time cardio-metadata
migration (row-less cardio, 2026-07-16). The read side never parses text —
activities carry laps/distance_m/duration_min columns. Leaf module."""
from __future__ import annotations

import re

_LAPS = re.compile(r"(\d+)\s*laps?", re.IGNORECASE)
_DIST = re.compile(r"([\d.]+)\s*(km|mi(?:les?)?|m|meters?)\b", re.IGNORECASE)
# (?![a-z]) instead of \b: "1h30m" has no word boundary between the h and the 3.
_HRS_MIN = re.compile(r"(\d+)\s*(?:hrs?|hours?|h)(?![a-z])\s*,?\s*(?:(\d+)\s*(?:min(?:utes?)?|m)(?![a-z]))?", re.IGNORECASE)
_COLON = re.compile(r"\b(\d+):(\d{2})\b")
_MIN_ONLY = re.compile(r"(\d+)\s*min(?:utes?)?\b", re.IGNORECASE)


def parse_cardio_text(s: str | None) -> tuple[int | None, float | None, float | None]:
    """(laps, distance_m, duration_min) parsed from free text; None when absent.

    Distance understands km / m / meters / mi / miles (miles × 1609.34).
    Duration understands "2 hrs", "45 min", "1:30", "1h30m", "1h 20min".
    The duration span is blanked before the distance scan so the "30m" in
    "1h30m" can never be read as 30 meters."""
    text = (s or "").lower()
    laps = dist = None
    dur: float | None = None

    m = _LAPS.search(text)
    if m:
        laps = int(m.group(1))

    m = _HRS_MIN.search(text)
    if m:
        dur = float(int(m.group(1)) * 60 + (int(m.group(2)) if m.group(2) else 0))
    else:
        m = _COLON.search(text)
        if m:
            dur = float(int(m.group(1)) * 60 + int(m.group(2)))
        else:
            m = _MIN_ONLY.search(text)
            if m:
                dur = float(m.group(1))
    if m is not None and dur is not None:
        text = text[:m.start()] + " " * (m.end() - m.start()) + text[m.end():]

    d = _DIST.search(text)
    if d:
        unit = d.group(2)
        mult = 1000 if unit == "km" else 1609.34 if unit.startswith("mi") else 1
        dist = float(d.group(1)) * mult

    return laps, dist, dur
