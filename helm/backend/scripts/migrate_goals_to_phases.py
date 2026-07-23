"""
One-shot migration: seed a Phase from the active calorie_target Goal,
preserve the active weight goal as the new Phase's target_weight_lbs,
log discarded strength goals, then drop the `goals` table.

Idempotent — re-runs are safe (checks for `goals` table existence first).

Run with:
    docker compose exec helm python -m backend.scripts.migrate_goals_to_phases
"""

import os
import sys
from datetime import date

from sqlalchemy import inspect, text

# Ensure we can import backend modules when run as a module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.database import SessionLocal, engine     # noqa: E402
from backend.models import Phase                        # noqa: E402


CALORIE_DEFAULT = float(os.getenv("DAILY_CALORIE_TARGET", "1850"))
PROTEIN_DEFAULT = float(os.getenv("DAILY_PROTEIN_TARGET", "125"))
CARBS_DEFAULT = float(os.getenv("DAILY_CARBS_TARGET", "250"))
FAT_DEFAULT = float(os.getenv("DAILY_FAT_TARGET", "50"))
FIBER_DEFAULT = float(os.getenv("DAILY_FIBER_TARGET", "30"))


def main() -> None:
    inspector = inspect(engine)
    if "goals" not in inspector.get_table_names():
        print("[migrate] `goals` table does not exist — nothing to do.")
        return

    db = SessionLocal()
    try:
        # Read raw rows (Goal model is gone)
        cal_row = db.execute(
            text(
                "SELECT id, target_value FROM goals "
                "WHERE goal_type='calorie_target' AND is_active=1 "
                "ORDER BY id DESC LIMIT 1"
            )
        ).fetchone()
        weight_row = db.execute(
            text(
                "SELECT id, target_value FROM goals "
                "WHERE goal_type='weight' AND is_active=1 "
                "ORDER BY id DESC LIMIT 1"
            )
        ).fetchone()
        strength_rows = db.execute(
            text(
                "SELECT id, label, exercise_name, target_value FROM goals "
                "WHERE goal_type='strength' AND is_active=1"
            )
        ).fetchall()

        print(f"[migrate] Found calorie_target Goal: {cal_row}")
        print(f"[migrate] Found weight Goal: {weight_row}")
        print(f"[migrate] Found {len(strength_rows)} active strength Goal(s) (will be discarded):")
        for r in strength_rows:
            print(f"  - id={r.id}: {r.label} ({r.exercise_name}) target={r.target_value}")

        target_calories = float(cal_row.target_value) if cal_row else CALORIE_DEFAULT
        target_weight = float(weight_row.target_value) if weight_row else None
        today_iso = date.today().isoformat()

        seed = Phase(
            phase_type="cut",
            start_date=today_iso,
            end_date=None,
            target_calories=target_calories,
            target_protein_g=PROTEIN_DEFAULT,
            target_carbs_g=CARBS_DEFAULT,
            target_fat_g=FAT_DEFAULT,
            target_fiber_g=FIBER_DEFAULT,
            target_weight_lbs=target_weight,
            notes=f"Migrated from Goals on {today_iso} — please verify start_date and macros.",
        )
        db.add(seed)
        db.commit()
        db.refresh(seed)
        print(f"[migrate] Created seed Phase id={seed.id}, type=cut, start={today_iso}, "
              f"calories={target_calories}, target_weight={target_weight}")

        db.execute(text("DROP TABLE goals"))
        db.commit()
        print("[migrate] Dropped `goals` table.")

        print("\n[migrate] Done. Open the Phases page and:")
        print("  1. Edit the seed phase's start_date to your actual cut start date.")
        print("  2. Add a refeed sub-range for any past refeed period.")
        print("  3. Verify macros (script used env defaults for protein/carbs/fat/fiber).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
