"""
Gemini API integration for the Helm health/fitness advisor.
Single master prompt (from Gem instructions) with task-specific context injection.
Uses google-genai SDK with JSON mode for structured output.
"""

from google.genai.types import GenerateContentConfig

from .base_llm import BaseLLMService
from .habit_config import habit_label, habit_synonyms_hint, habit_unit

# ==========================================
# System Prompt (from Gem instructions)
# ==========================================

SYSTEM_PROMPT = """You are Lionel's personal nutritionist advisor and workout planner. Your primary objective is to help Lionel develop and maintain healthy eating habits, track daily calorie/macro intake, and manage a strict Push-Pull-Legs workout schedule.

Core Responsibilities:
- Nutritionist & Assistant: Look up calorie/macro info, estimate portion sizes from descriptions, and offer insights based on nutritional goals. Prioritize tracking fiber and major macros. Never use Fahrenheit; always use Celsius.
- Workout Planner: Follow this weekly schedule strictly: Push -> Pull -> Legs -> Rest/Cardio -> Push -> Pull -> Legs -> Rest/Cardio.
  - Push session: Upper body (arms, chest, shoulders).
  - Pull session: Upper body (arms, back, core).
  - Legs session: Lower body.
  - Cardio session: Swimming in the pool after each workout.
- Targeted Muscle Groups (ONLY these exact terms): Triceps, Biceps, Chest, Lats, Delts, Quads, Hamstrings, Glutes, Core, Adductors, Full Body, Forearms / Grip, Traps, Lower Back, Cardio, Calves, Abductors, Rhomboids.
- Equipment Categories (ONLY these): Dumbbell, Barbell, None, Plates, Machine, Cable, Bodyweight, Smith Machine, Bands.
- Date Format: MM/DD or MM/DD/YY. Never use DD/MM.
- Progressive Overload & Tracking: Before suggesting a new set or parsing a logged set, retrieve the most recent entry of that specific exercise from the RECENT DATA CONTEXT. Compare the new weight/reps against the previous session's weight/reps, and add a brief comparison note (along with any user-provided notes) to the exercise record.
- Exercise Categories: Every exercise must be categorized as either 'Upper Body', 'Lower Body', 'Core', or 'Cardio'. Note that these are different from the overall workout session types (Push, Pull, Legs).

Meal Database Rules:
- Log every ingredient/item by weight in grams (net weight excluding bones/packaging), including all sauces and oils.
- Consolidate items eaten together into a single line for that meal (e.g., Dinner).
- Use exact macros when provided by the user rather than generic estimates.
- ALWAYS break down meals into their individual components/ingredients in the `items` array when possible, providing the individual calories/macros for each component. The parent meal object should be the sum of these items.
- When user provides label data (e.g. "70 calories each"), use those exact numbers.

Daily Target: 125g protein per day."""


_PARSE_INSTRUCTIONS_TEMPLATE = """
You are processing a natural language message from the user. Extract ALL intents from the message and return them as structured JSON.

The message may contain ANY combination of:
1. **Meals** — food descriptions, "same as yesterday" references, pre-parsed macros
2. **Workouts** — exercise entries in shorthand format (e.g. "Hack squat - 30, 35, 35 - *8, *8, *9")
3. **Weight** — a body weight measurement (e.g. "weighed 227", "weigh in - 227.6")
4. **__HABIT_LABEL__** — the user's custom tracked habit, quantity in __HABIT_UNIT__ (e.g. "1.5__HABIT_UNIT__", "subtract 0.5"). __HABIT_SYNONYMS__ Interpret subtractions or removals as negative `amount`.
5. **Caffeine** — caffeine intake in milligrams from beverages or supplements (e.g. "had a coffee", "2 espressos", "pre-workout", "200mg caffeine", "energy drink"). Use standard estimates when exact amounts aren't given: drip coffee ~95mg/cup, espresso ~63mg/shot, latte/cappuccino ~63mg per shot of espresso, cold brew ~200mg/serving, energy drink ~80–160mg/can, pre-workout ~150–200mg/serving, green tea ~30mg/cup, black tea ~47mg/cup.
6. **Mood** — daily emotional state or feeling (e.g. "Feeling fantastic", "Mood: stressed")
6. **Notes** — status updates, skipped workouts, health notes (e.g. "woke up sick", "no swim due to fatigue")
7. **Questions** — Helm advice questions (return answer in advice_response)
8. **Sleep** — sleep duration, bedtime, and/or wake time (e.g. "slept 7 hours", "slept 11pm to 6:30am", "went to bed at midnight, woke up at 7"). Extract bedtime and waketime in 24h format (e.g. "23:00", "06:30"). Calculate hours from bedtime/waketime when both are present (if waketime < bedtime numerically, assume next day — e.g. 23:00→06:30 = 7.5h). If only duration is mentioned, set hours directly and leave bedtime/waketime null.

For caffeine:
- Estimate mg from common beverages when exact amounts aren't provided (see amounts above).
- Multiple drinks in one message should be summed into a single caffeine intent (e.g. "2 coffees and an espresso" = 190+63 = 253mg).

For meals:
- If user says "same as yesterday" or "same [meal] as [time]", look at the RECENT MEALS context and resolve it to the actual meal with macros. Set resolved_from to the source date and meal.
- If user provides exact macros (e.g. "805 cal, 79g protein"), use those exact values.
- If user describes ingredients or multiple dishes (e.g., "had Korean shortribs, potatoes, rice"), break each distinct component down into the `items` array with its own estimated macros, and sum them up for the parent meal object.
- When user provides label data (e.g. "70 calories each"), use those exact numbers.

Date Overrides:
- If the user explicitly mentions a relative or absolute date (e.g., "yesterday", "on Tuesday", "last night"), use the "CURRENT DATE" context to determine the exact `YYYY-MM-DD` and set the `date` field for that intent. If no date is specified, omit the `date` field entirely.

Mood Parsing:
- You must distill the user's emotional description into a strict 1-5 scale:
  - `1 - Terrible`
  - `2 - Bad`
  - `3 - Neutral`
  - `4 - Good`
  - `5 - Great`
- For example, "didn't feel great, didn't feel terrible" becomes "3 - Neutral". Return ONLY the exact scaled string.

For workouts, parse the shorthand format:
- Emit ONE workout intent per distinct real-world activity in the message. Choose "activity" from this exact set: strength, swim, run, bike, row, elliptical, hike, stairs, cardio. Put all lifts and any gym warm-up walk into a single "strength" intent; give each distinct cardio (a swim, a run) its own intent. Every workout intent has at least one exercise; for a cardio activity the cardio itself is that exercise row (e.g. Swim — 40 laps).
- "Exercise - weight - *reps, *reps" → extract exercise, per-set weights, per-set reps
- "(F)" means failure on that set
- Negative weights mean assisted (e.g. "-115" for assisted pull-ups)
- "Swim - N laps" is cardio
- **Cardio / Swimming**: For cardio exercises (swimming, running, etc.), `weight_lbs` MUST be empty string `""` or null — never set it to the user's bodyweight. Equipment type should be `"None"`.
- Determine the exercise category (MUST be one of: Upper Body, Lower Body, Core, Cardio).
- Identify the equipment type and targeted muscle group.
- **CRITICAL (Normalization)**: Normalize the `exercise` name by stripping out the equipment type AND execution modifiers.
  - For example, "Dumbbell Bench Press" -> `exercise: "Bench Press"`, `equipment_type: "Dumbbell"`.
  - "Pec Fly machine (unilateral)" -> `exercise: "Pec Fly"`, `equipment_type: "Machine"`.
  - Any modifiers you strip out (like "unilateral" or "single arm") MUST be included when you synthesize the `notes` field.
- **CRITICAL (Name Consistency)**: BEFORE creating a new exercise name, check the RECENT DATA CONTEXT for a matching or very similar exercise.
  - If the user's input closely matches an existing exercise name from history, use the EXACT historical name. This is essential for progressive overload tracking.
  - For example, if history shows "Cable Curl" and the user writes "Bayesian Cable Curl", the exercise is "Cable Curl" (not "Bayesian Curl"). "Bayesian" is an execution modifier that goes in `notes`.
  - When in doubt between stripping a word as equipment vs keeping it as part of the exercise name, prefer the form that matches historical data.
- **CRITICAL**: For the `notes` field of each exercise:
  1. Check the RECENT DATA CONTEXT to find the last time the user did this exact exercise.
  2. Synthesize a brief, cohesive note that combines a performance comparison (e.g., "Up 5 lbs from last time", "Added 1 rep to set 2") with the core intent of any specific notes the user provided in their prompt.
  3. Do NOT just append or copy-paste the user's exact words. Rewrite and synthesize the information into a single tracking note.
  4. If no previous data exists, synthesize the user's notes, or write "First time logging" if none.

Return valid JSON matching this exact schema:
{
  "intents": [
    {
      "type": "meal" | "workout" | "weight" | "habit" | "caffeine" | "mood" | "note" | "sleep",
      "source_text": "the part of input this was parsed from",
      "date": "YYYY-MM-DD" | null,
      "meal_data": {
        "meal": "Breakfast/Lunch/Dinner/Snack",
        "description": "...",
        "calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0, "fiber_g": 0,
        "resolved_from": null,
        "items": [
          { "name": "...", "quantity": "...", "calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0, "fiber_g": 0, "confidence": 0.85, "confidence_reason": "weighed" }
        ]
      } | null,
      "workout_data": { ... } | null,
      "weight_data": { ... } | null,
      "habit_data": { ... } | null,
      "caffeine_data": { ... } | null,
      "mood_data": { ... } | null,
      "note_data": { ... } | null,
      "sleep_data": { "bedtime": "23:00"|null, "waketime": "06:30"|null, "hours": 7.5 } | null
    }
  ],
  "advice_response": "answer to any questions" | null
}

meal_item schema: { "name": str, "quantity": str, "calories": float, "protein_g": float, "carbs_g": float, "fat_g": float, "fiber_g": float, "confidence": float, "confidence_reason": str }
meal_data schema: { "meal": str, "description": str, "calories": float, "protein_g": float, "carbs_g": float, "fat_g": float, "fiber_g": float, "resolved_from": str|null, "items": [meal_item] }
workout_data schema: { "activity": str, "label": str|null, "exercises": [{ "exercise": str, "category": str, "equipment_type": str, "weight_lbs": str, "reps_sets": str, "notes": str, "targeted_muscle_group": str }], "session_notes": str|null }
weight_data schema: { "weight_lbs": float }
habit_data schema: { "amount": float }
caffeine_data schema: { "amount_mg": float }
mood_data schema: { "mood": str }
note_data schema: { "note": str }
sleep_data schema: { "bedtime": str|null, "waketime": str|null, "hours": float }

For each meal item, score your confidence in the calorie/macro estimate:
- confidence: 0.0–1.0 float. How certain you are about this item's nutrition data.
- confidence_reason: one of "labeled", "weighed", "standard_serving", "estimated_portion", "vague_description", "composite_dish"

The reason explains the source of uncertainty, not the score itself. Score based on full context:
- labeled: user provided exact nutrition facts (0.90–0.99)
- weighed: user gave exact weight in grams/oz for a known food (0.80–0.90)
- standard_serving: recognized countable portion like "1 large egg" (0.70–0.80)
- estimated_portion: approximate amount like "a bowl of rice" (0.45–0.65)
- vague_description: no quantity info like "some cake" (0.20–0.40)
- composite_dish: multi-ingredient dish estimated as a whole like "pad thai" (0.30–0.55)
These ranges are guidance — adjust based on how well-known the food is.
"""

PARSE_INSTRUCTIONS = (
    _PARSE_INSTRUCTIONS_TEMPLATE
    .replace("__HABIT_LABEL__", habit_label())
    .replace("__HABIT_UNIT__", habit_unit())
    .replace("__HABIT_SYNONYMS__", habit_synonyms_hint())
)


class GeminiAdvisor(BaseLLMService):
    """Health/fitness Gemini advisor — parsing, chat, and workout planning."""

    LOG_PREFIX = "[HELM_ADVISOR]"
    TASK_TYPE = "chat"

    def parse_input_prompt(self, message: str, context: str = "", current_date: str | None = None,
                           image_bytes: bytes | None = None, image_mime: str = "image/jpeg") -> tuple:
        """Build the (contents, config) for parse_input — shared by the sync path and the queue enqueue."""
        prompt_parts = [PARSE_INSTRUCTIONS]
        if current_date:
            prompt_parts.append(f"\n--- CURRENT DATE ---\n{current_date}\n--- END CURRENT DATE ---\n")
        if context:
            prompt_parts.append(f"\n--- RECENT DATA CONTEXT ---\n{context}\n--- END CONTEXT ---\n")
        if image_bytes:
            prompt_parts.append("\nThe user has attached a photo of their meal. Identify the food items, estimate portions, and parse as a meal intent. Use the user's text message for any additional context (meal type, time, etc).")
        prompt_parts.append(f"\nUser message: {message}")

        full_prompt = "\n".join(prompt_parts)

        # Build contents — text only or text + image for multimodal
        if image_bytes:
            from google.genai.types import Part
            contents = [full_prompt, Part.from_bytes(data=image_bytes, mime_type=image_mime)]
        else:
            contents = full_prompt

        config = GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            temperature=0.3,
        )
        return contents, config

    def chat_prompt(self, message: str, context: str = "") -> tuple:
        """Build the (prompt, config) for advisor chat — shared by the sync path and the queue enqueue."""
        prompt_parts = []
        if context:
            prompt_parts.append(f"--- RECENT DATA CONTEXT ---\n{context}\n--- END CONTEXT ---\n")
        prompt_parts.append(message)

        full_prompt = "\n".join(prompt_parts)

        config = GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            temperature=0.7,
        )
        return full_prompt, config

    def plan_workout_prompt(self, recent_exercises_text: str, day_type: str = "", notes: str = "") -> tuple:
        """Build the (prompt, config) for a workout plan — shared by the sync path and the queue enqueue."""
        schema_instructions = """{
  "workout_type": "Push|Pull|Legs|Cardio|Mixed",
  "date_label": "e.g. Monday, March 9, 2026",
  "exercises": [
    {
      "name": "Exercise Name",
      "warm_up": "optional warm-up description or null",
      "weights": ["40", "45", "45"],
      "sets": ["*8", "*8", "*6"],
      "previous_date": "YYYY-MM-DD or null",
      "previous_weight": "e.g. 40 lbs or null",
      "previous_reps": "e.g. x8,8,7 or null",
      "overload_note": "What changed vs last session"
    }
  ],
  "session_notes": {
    "duration": "Estimated duration",
    "cardio": "Swim/cardio recommendation",
    "caveats": "Injury/fatigue caveats from recent notes"
  }
}"""
        prompt = f"""You are planning a detailed workout session for Lionel. Return ONLY valid JSON matching the schema below. No markdown, no extra text.

CONTEXT:
{notes}

INSTRUCTIONS:
1. Workout type: {day_type or 'infer from PPL schedule and context'}
2. Select 5-7 compound + isolation exercises for the muscle group. When choosing exercises, consider the full history — not just the most recent session. Vary the selection across sessions; don't default to repeating the same exercises every time.
3. For EACH exercise: find the most recent entry in the history, apply progressive overload (+2.5-5 lbs or +1-2 reps), and record it.
4. If no history exists for an exercise, start at a conservative weight.
5. Always recommend 3-4 working sets.
6. Fill session_notes with realistic duration, cardio recommendation (always include swim), and any relevant caveats from notes.

JSON SCHEMA TO FOLLOW:
{schema_instructions}

--- RECENT EXERCISE HISTORY ({day_type}) ---
{recent_exercises_text}
--- END HISTORY ---

Return ONLY the JSON object, no other text."""
        config = GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            temperature=0.4,
        )
        return prompt, config

    @staticmethod
    def build_meal_context(meals: list) -> str:
        """Format recent meal ORM objects into readable context text."""
        if not meals:
            return "No recent meals found."

        lines = ["Recent Meals:"]
        for m in meals:
            lines.append(
                f"  {m.date} {m.meal}: {m.description} | "
                f"{m.calories} cal, {m.protein_g}g P, {m.carbs_g}g C, "
                f"{m.fat_g}g F, {m.fiber_g}g Fiber"
            )
        return "\n".join(lines)

    @staticmethod
    def build_workout_context(workouts: list) -> str:
        """Format recent workout ORM objects into readable context text."""
        if not workouts:
            return "No recent workouts found."

        lines = ["Recent Workouts:"]
        for w in workouts:
            notes_str = f" — {w.notes}" if w.notes else ""
            lines.append(
                f"  {w.date} {w.exercise} ({w.targeted_muscle_group}): "
                f"W: {w.weight_lbs} | R: {w.reps_sets}{notes_str}"
            )
        return "\n".join(lines)

    @staticmethod
    def build_daily_context(summaries: list, db=None) -> str:
        """Format recent daily summary ORM objects into readable context text."""
        from datetime import datetime
        from .phase_service import build_phase_context_line

        lines = []
        if db is not None:
            today = datetime.utcnow().date().strftime("%Y-%m-%d")
            lines.append(build_phase_context_line(today, db))
            lines.append("")    # blank separator

        if not summaries:
            lines.append("No recent daily summaries found.")
            return "\n".join(lines)

        lines.append("Recent Daily Summaries:")
        for d in summaries:
            lines.append(
                f"  {d.date} ({d.day_of_week or '?'}): "
                f"Weight: {d.weight_lbs or '?'} lbs | "
                f"{d.calories_in} cal in | {d.protein_g}g P | "
                f"Deficit: {d.net_deficit} | {d.workout_type or 'no workout'}"
            )
        return "\n".join(lines)
