"""Single vocabulary for the workout domain's activity taxonomy.

Leaf module — imports nothing from models or other services, so both
workout_log_service and google_health_service (and activity_service) can depend
on it without circular imports. Every keyword table and classifier that decides
"which activity does this belong to" lives here and nowhere else.

Canonical activity vocabulary:
    strength · swim · run · bike · row · elliptical · hike · stairs · cardio (other)
"""
from __future__ import annotations

# Cardio names that ride with the strength session rather than their own card.
STRENGTH_CARDIO_KEYWORDS = (
    "backwards walk", "backward walk", "walking", "walk", "incline walk",
)

# (substring, normalized activity). Order matters — first hit wins.
CARDIO_KEYWORDS = (
    ("swim", "swim"), ("jog", "run"), ("treadmill", "run"), ("run", "run"),
    ("cycl", "bike"), ("spin", "bike"), ("bike", "bike"), ("row", "row"),
    ("elliptical", "elliptical"), ("hike", "hike"), ("stair", "stairs"),
)

# normalized activity -> Google exercise_type_raw values it matches.
ACTIVITY_GOOGLE_TYPES = {
    "strength": {"WORKOUT", "STRENGTH_TRAINING", "WEIGHTLIFTING"},
    "swim": {"SWIMMING", "SWIMMING_POOL", "OPEN_WATER_SWIM"},
    "run": {"RUNNING", "TREADMILL_RUNNING"},
    "bike": {"BIKING", "ROAD_BIKING", "MOUNTAIN_BIKING", "SPINNING"},
    "row": {"ROWING"},
    "elliptical": {"ELLIPTICAL"},
    "hike": {"HIKING"},
}

RUN_TYPES = ACTIVITY_GOOGLE_TYPES["run"]

# Cardio activities Fitbit exports under a generic raw type (WORKOUT) with only a
# distinguishing display label. These are resolved by label keyword — never by
# exercise_type_raw — so a WORKOUT-typed stair session can't be mistaken for the
# lifting session. activity -> label substrings.
LABEL_ACTIVITIES = {"stairs": ("stair",)}
LABEL_RESERVED = tuple(kw for kws in LABEL_ACTIVITIES.values() for kw in kws)

# The full canonical activity vocabulary (see module docstring). Anything else is
# not a valid stored `activities.activity` value.
CANONICAL_ACTIVITIES = frozenset({
    "strength", "swim", "run", "bike", "row", "elliptical", "hike", "stairs", "cardio",
})


def label_matches(label: str | None, label_kws) -> bool:
    """Whether a display label hits any of the given label keywords."""
    name = (label or "").lower()
    return any(k in name for k in label_kws)


def activity_of(name: str) -> str:
    """Normalized cardio activity from an exercise name (keyword match)."""
    n = (name or "").lower()
    for kw, act in CARDIO_KEYWORDS:
        if kw in n:
            return act
    return n.strip() or "cardio"


def is_strength_member(exercise_name: str, category: str) -> bool:
    """Lifts, and cardio entries that are gym warmup/accessory, count as strength."""
    if (category or "") != "Cardio":
        return True
    n = (exercise_name or "").lower()
    return any(k in n for k in STRENGTH_CARDIO_KEYWORDS)


def google_session_activity(raw: str, label: str | None) -> str:
    """Canonical activity for a Google session.

    Label-keyword activities win (a WORKOUT-typed "Stair climber" is stairs, never
    strength — the reservation rule), then raw-type sets, else other-cardio."""
    for activity, kws in LABEL_ACTIVITIES.items():
        if label_matches(label, kws):
            return activity
    for activity, types in ACTIVITY_GOOGLE_TYPES.items():
        if raw in types:
            return activity
    return "cardio"
