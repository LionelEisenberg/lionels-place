"""Tests for the configurable custom-habit settings (env-driven)."""
from backend.services import habit_config


def test_defaults(monkeypatch):
    for var in ("HABIT_LABEL", "HABIT_EMOJI", "HABIT_UNIT", "HABIT_SYNONYMS"):
        monkeypatch.delenv(var, raising=False)
    assert habit_config.habit_label() == "Habit"
    assert habit_config.habit_emoji() == "✳️"
    assert habit_config.habit_unit() == "g"
    assert habit_config.habit_synonyms() == []
    assert habit_config.habit_qty_header() == "Habit (g)"


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("HABIT_LABEL", "Reading")
    monkeypatch.setenv("HABIT_EMOJI", "📚")
    monkeypatch.setenv("HABIT_UNIT", "min")
    monkeypatch.setenv("HABIT_SYNONYMS", "book, pages , kindle")
    assert habit_config.habit_label() == "Reading"
    assert habit_config.habit_emoji() == "📚"
    assert habit_config.habit_qty_header() == "Reading (min)"
    assert habit_config.habit_synonyms() == ["book", "pages", "kindle"]


def test_synonyms_hint(monkeypatch):
    monkeypatch.delenv("HABIT_SYNONYMS", raising=False)
    assert habit_config.habit_synonyms_hint() == ""
    monkeypatch.setenv("HABIT_SYNONYMS", "book,kindle")
    hint = habit_config.habit_synonyms_hint()
    assert "book" in hint and "kindle" in hint
