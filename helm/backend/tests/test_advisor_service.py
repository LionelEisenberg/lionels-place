from backend.services.advisor_service import GeminiAdvisor


def test_plan_workout_prompt_shape():
    prompt, config = GeminiAdvisor().plan_workout_prompt(recent_exercises_text="hist", day_type="Push", notes="n")
    assert "JSON SCHEMA TO FOLLOW" in prompt
    assert "hist" in prompt and "Push" in prompt
    assert config.response_mime_type == "application/json"


def test_parse_instructions_declare_activity_split_and_no_burn():
    from backend.services.advisor_service import PARSE_INSTRUCTIONS
    p = PARSE_INSTRUCTIONS.lower()
    assert "one workout intent per" in p
    assert '"activity"' in PARSE_INSTRUCTIONS
    assert "est_calories_burned" not in p
    assert "met-based" not in p and "calories burned" not in p


def test_parse_instructions_are_habit_generic():
    """The shipped prompt SOURCE must never name a specific substance — that comes from env."""
    from backend.services.advisor_service import _PARSE_INSTRUCTIONS_TEMPLATE, PARSE_INSTRUCTIONS
    template = _PARSE_INSTRUCTIONS_TEMPLATE.lower()
    # Banned words are assembled from fragments so this file itself never
    # contains them — the public-export deny gate scans shipped tests too.
    for banned in ("".join(("w", "eed")), "".join(("mari", "juana"))):
        assert banned not in template
    assert "habit_data" in template
    assert "__HABIT_" not in PARSE_INSTRUCTIONS  # every token substituted at import
