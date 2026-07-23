"""
Configurable custom-habit settings.

Helm tracks one user-defined habit with an optional quantity
(daily_summaries.habit_qty) and a did-it flag (daily_summaries.habit_custom).
What that habit *is* stays out of the codebase: the private deployment names
it via env vars. Public code and prompts only ever see these accessors.
"""
import os


def habit_label() -> str:
    """Display name of the custom habit (e.g. shown in charts and CSV headers)."""
    return os.getenv("HABIT_LABEL", "Habit")


def habit_emoji() -> str:
    """Emoji used for the habit in UI chips and intent cards."""
    return os.getenv("HABIT_EMOJI", "✳️")


def habit_unit() -> str:
    """Unit for the habit quantity (e.g. g, min, pages)."""
    return os.getenv("HABIT_UNIT", "g")


def habit_synonyms() -> list[str]:
    """Extra words the LLM parser should treat as referring to the habit."""
    raw = os.getenv("HABIT_SYNONYMS", "")
    return [s.strip() for s in raw.split(",") if s.strip()]


def habit_synonyms_hint() -> str:
    """Sentence injected into the parse prompt; empty when no synonyms configured."""
    syns = habit_synonyms()
    if not syns:
        return ""
    return "Treat these words as referring to this habit: " + ", ".join(syns) + "."


def habit_qty_header() -> str:
    """CSV column header for the habit quantity in the daily export/import."""
    return f"{habit_label()} ({habit_unit()})"
