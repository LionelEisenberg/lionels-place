"""
MET-based workout calorie burn estimator.
Uses lean body mass and exercise volume to produce smarter estimates
than the old hardcoded category values.
"""

from __future__ import annotations

from ..schemas import ExerciseEntryData

# Height is fixed (user-specific constant)
HEIGHT_CM = 185

# MET values by workout category
MET_BY_CATEGORY: dict[str, float] = {
    "push": 5.0,
    "pull": 5.0,
    "upper body": 5.0,
    "legs": 6.0,
    "lower body": 6.0,
    "cardio": 7.0,
    "full body": 6.0,
    "core": 3.5,
}

# Baseline volume (lbs) thresholds for intensity scaling
VOLUME_BASELINE: dict[str, float] = {
    "push": 8000,
    "pull": 8000,
    "upper body": 8000,
    "legs": 12000,
    "lower body": 12000,
    "cardio": 0,
    "full body": 10000,
    "core": 2000,
}

# Fallback estimates when no body metrics are available (legacy behavior)
FALLBACK_BURN: dict[str, float] = {
    "push": 280,
    "pull": 280,
    "upper body": 280,
    "legs": 350,
    "lower body": 350,
    "cardio": 400,
    "full body": 400,
    "core": 180,
}
DEFAULT_FALLBACK = 280


def _parse_set_count(reps_sets: str | None) -> int:
    """Count the number of sets from a comma-separated reps string like '8, 8, 9'."""
    if not reps_sets:
        return 0
    return len([s for s in reps_sets.split(",") if s.strip()])


def _parse_volume(weight_lbs: str | None, reps_sets: str | None) -> float:
    """Calculate total volume (weight × reps) from comma-separated strings."""
    if not weight_lbs or not reps_sets:
        return 0.0
    weights = [s.strip() for s in weight_lbs.split(",") if s.strip()]
    reps = [s.strip() for s in reps_sets.split(",") if s.strip()]
    total = 0.0
    for i in range(min(len(weights), len(reps))):
        try:
            w = float(weights[i])
            r = float(reps[i])
            total += w * r
        except (ValueError, TypeError):
            continue
    return total


def _dominant_category(exercises: list[ExerciseEntryData]) -> str:
    """Return the most common category (lowercased) across exercises."""
    counts: dict[str, int] = {}
    for ex in exercises:
        cat = (ex.category or "").lower()
        counts[cat] = counts.get(cat, 0) + 1
    if not counts:
        return "push"
    return max(counts, key=lambda k: counts[k])


def estimate_workout_calories(
    exercises: list[ExerciseEntryData],
    weight_lbs: float | None,
    bf_pct: float | None,
) -> float:
    """
    Estimate workout calorie burn using MET × LBM hybrid formula.

    If weight/bf% are unavailable, falls back to category-based estimates.
    """
    if not exercises:
        return 0.0

    # Check for swim bonus across all exercises
    swim_bonus = 0
    for ex in exercises:
        ex_name = (ex.exercise or "").lower()
        ex_notes = (ex.notes or "").lower()
        if "swim" in ex_name or "swim" in ex_notes:
            swim_bonus = 150
            break

    dominant = _dominant_category(exercises)

    # Fallback path: no body metrics available
    if weight_lbs is None or bf_pct is None:
        base = FALLBACK_BURN.get(dominant, DEFAULT_FALLBACK)
        return base + swim_bonus

    # --- MET × LBM formula ---
    weight_kg = weight_lbs / 2.205
    lbm_kg = weight_kg * (1 - bf_pct / 100)

    # Total sets across all exercises → estimated duration (~3 min/set incl rest)
    total_sets = sum(_parse_set_count(ex.reps_sets) for ex in exercises)
    duration_minutes = max(total_sets * 3, 15)  # minimum 15 min floor

    # Weighted average MET across exercises (weight by set count)
    weighted_met = 0.0
    total_weight = 0
    for ex in exercises:
        cat = (ex.category or "").lower()
        met = MET_BY_CATEGORY.get(cat, 5.0)
        sets = _parse_set_count(ex.reps_sets) or 1
        weighted_met += met * sets
        total_weight += sets
    avg_met = weighted_met / total_weight if total_weight > 0 else 5.0

    # Base burn: standard MET formula using LBM instead of total body weight
    # MET × 3.5 × mass(kg) / 200 = kcal/min
    base_burn = (avg_met * 3.5 * lbm_kg / 200) * duration_minutes

    # Volume intensity factor: scale 0.85–1.15 based on total volume vs baseline
    total_volume = sum(_parse_volume(ex.weight_lbs, ex.reps_sets) for ex in exercises)
    baseline = VOLUME_BASELINE.get(dominant, 8000)
    if baseline > 0 and total_volume > 0:
        ratio = total_volume / baseline
        intensity_factor = max(0.85, min(1.15, 0.85 + 0.30 * ratio))
    else:
        intensity_factor = 1.0

    adjusted_burn = base_burn * intensity_factor + swim_bonus
    return round(adjusted_burn)
