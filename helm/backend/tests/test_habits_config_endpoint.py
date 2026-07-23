"""Contract test for /daily/habits/config habit-meta injection."""
from backend.routers.daily import get_habits_config


def test_meta_defaults(monkeypatch):
    for var in ("HABIT_LABEL", "HABIT_EMOJI", "HABIT_UNIT"):
        monkeypatch.delenv(var, raising=False)
    config = get_habits_config()
    assert config["_meta"] == {"label": "Habit", "emoji": "✳️", "unit": "g"}


def test_meta_env_override(monkeypatch):
    monkeypatch.setenv("HABIT_LABEL", "Reading")
    monkeypatch.setenv("HABIT_EMOJI", "📚")
    monkeypatch.setenv("HABIT_UNIT", "min")
    config = get_habits_config()
    assert config["_meta"] == {"label": "Reading", "emoji": "📚", "unit": "min"}
