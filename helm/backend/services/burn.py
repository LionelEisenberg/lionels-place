"""Active-calorie-burn accounting — a leaf module (imports nothing from services)
so both the sync (google_health_service) and the read path (workout_log_service,
routers) can share the tracker discount without a heavy dependency."""
from __future__ import annotations

# Consumer wearables track heart rate reasonably but overestimate active-calorie
# burn — validation studies (e.g. Stanford 2017) put the energy-expenditure error
# commonly around 20–30%+, skewed high. We credit a flat 70% of the watch's kcal.
# Blunt heuristic, not per-activity; tune here.
TRACKER_BURN_FACTOR = 0.70


def credited_burn(raw_kcal: float | None) -> float | None:
    """The watch's kcal discounted for tracker overestimation (None/0-safe)."""
    return raw_kcal * TRACKER_BURN_FACTOR if raw_kcal else raw_kcal
