"""One-time backfill: recompute daily_summaries.workout_type with the new
canonical algorithm. Overwrites every existing value (auto or manual).

Run inside the helm container:
    docker exec helm python -m backend.scripts.backfill_workout_types
"""

from __future__ import annotations

import sys

from backend.database import SessionLocal
from backend.models import DailySummary, Workout
from backend.services.workout_type import infer_workout_type


def backfill() -> tuple[int, int, int]:
    """Return (rows_visited, rows_updated, rows_set_null)."""
    db = SessionLocal()
    try:
        rows = db.query(DailySummary).all()
        visited = len(rows)
        updated = 0
        cleared = 0

        for row in rows:
            workouts = db.query(Workout).filter(Workout.date == row.date).all()
            new_type = infer_workout_type(workouts)
            old_type = row.workout_type
            if new_type != old_type:
                row.workout_type = new_type
                if new_type is None:
                    cleared += 1
                else:
                    updated += 1

        db.commit()
        return visited, updated, cleared
    finally:
        db.close()


def main() -> int:
    visited, updated, cleared = backfill()
    print(f"Visited {visited} daily_summaries rows")
    print(f"  Updated to a new type: {updated}")
    print(f"  Cleared to NULL (no workouts that day): {cleared}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
