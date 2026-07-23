"""
One-time CSV import service.
Imports data exported from Google Sheets into the SQLite database.
Normalizes dates from DD/MM/YY (Google Sheets format) to YYYY-MM-DD (ISO, sortable).
Only imports if the target table is empty (true one-time import).
"""

import csv
import os
from datetime import datetime
from sqlalchemy.orm import Session

from ..models import Meal, Workout, DailySummary
from . import activity_service
from .habit_config import habit_qty_header


def normalize_date(date_str: str) -> str:
    """
    Convert various date formats to YYYY-MM-DD.
    Handles: DD/MM/YY, DD/MM/YYYY, YYYY-MM-DD (passthrough)
    We assume DD/MM/YY as the primary input format (user's Google Sheets).
    """
    date_str = date_str.strip()
    if not date_str:
        return date_str

    # Already ISO format
    if len(date_str) >= 8 and date_str[4] == '-':
        return date_str

    # Try DD/MM/YY first (user's format)
    for fmt in ("%d/%m/%y", "%d/%m/%Y"):
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue

    # Fallback: try MM/DD/YY
    for fmt in ("%m/%d/%y", "%m/%d/%Y"):
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue

    # Last resort: return as-is
    print(f"  WARNING: Could not parse date '{date_str}', storing as-is")
    return date_str


def today_iso() -> str:
    """Return today's date in YYYY-MM-DD format."""
    import zoneinfo
    return datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")


def format_display_date(iso_date: str) -> str:
    """Convert YYYY-MM-DD to DD/MM/YY for display."""
    try:
        return datetime.strptime(iso_date, "%Y-%m-%d").strftime("%d/%m/%y")
    except (ValueError, TypeError):
        return iso_date


def safe_float(val, default: float = 0.0) -> float:
    """Safely parse a float from a string, handling empty/invalid values."""
    if val is None:
        return default
    if isinstance(val, (int, float)):
        return float(val)
    val = str(val).strip().replace(",", "")
    if not val or val == "—" or val == "-":
        return default
    try:
        return float(val)
    except ValueError:
        return default


def import_meals_csv(file_path: str, db: Session) -> int:
    """
    Import meals from a CSV file.
    Skips import entirely if meals table already has data.
    """
    if not os.path.exists(file_path):
        return 0

    # Skip if table already has data (one-time import)
    existing_count = db.query(Meal).count()
    if existing_count > 0:
        print(f"  Meals table already has {existing_count} rows, skipping import.")
        return 0

    count = 0
    skipped = 0
    with open(file_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for line_num, row in enumerate(reader, start=2):  # line 1 is header
            try:
                date = normalize_date(row.get("Date", ""))
                if not date:
                    print(f"  Skipping meal line {line_num}: empty date")
                    skipped += 1
                    continue

                description = row.get("Description", "").strip()
                if not description:
                    print(f"  Skipping meal line {line_num}: empty description")
                    skipped += 1
                    continue

                meal = Meal(
                    date=date,
                    meal=row.get("Meal", "").strip(),
                    description=description,
                    calories=safe_float(row.get("Calories")),
                    protein_g=safe_float(row.get("Protein (g)")),
                    carbs_g=safe_float(row.get("Carbs (g)")),
                    fat_g=safe_float(row.get("Fat (g)")),
                    fiber_g=safe_float(row.get("Fiber (g)")),
                )
                db.add(meal)
                count += 1
            except Exception as e:
                print(f"  Skipping meal line {line_num}: {e}")
                skipped += 1
                continue

    db.commit()
    if skipped > 0:
        print(f"  Meals: imported {count}, skipped {skipped}")
    return count


def import_workouts_csv(file_path: str, db: Session) -> int:
    """
    Import workouts from a CSV file.
    Skips import entirely if workouts table already has data.
    """
    if not os.path.exists(file_path):
        return 0

    # Skip if table already has data (one-time import)
    existing_count = db.query(Workout).count()
    if existing_count > 0:
        print(f"  Workouts table already has {existing_count} rows, skipping import.")
        return 0

    count = 0
    skipped = 0
    with open(file_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for line_num, row in enumerate(reader, start=2):
            try:
                date = normalize_date(row.get("Date", ""))
                if not date:
                    print(f"  Skipping workout line {line_num}: empty date")
                    skipped += 1
                    continue

                exercise = row.get("Exercise", "").strip()
                if not exercise:
                    print(f"  Skipping workout line {line_num}: empty exercise")
                    skipped += 1
                    continue

                workout = Workout(
                    date=date,
                    category=row.get("Category", "").strip(),
                    equipment_type=row.get("Equipment Type", "").strip(),
                    exercise=exercise,
                    weight_lbs=row.get("Weight (lbs)", "").strip(),
                    reps_sets=row.get("Reps / Sets", "").strip(),
                    notes=row.get("Notes", "").strip(),
                    targeted_muscle_group=row.get("Targeted Muscle Group", "").strip(),
                )
                db.add(workout)
                db.flush()
                activity_service.record_exercise(db, workout)
                count += 1
            except Exception as e:
                print(f"  Skipping workout line {line_num}: {e}")
                skipped += 1
                continue

    db.commit()
    if skipped > 0:
        print(f"  Workouts: imported {count}, skipped {skipped}")
    return count


def import_daily_csv(file_path: str, db: Session) -> int:
    """
    Import daily summaries from a CSV file.
    Skips import entirely if daily table already has data.
    """
    if not os.path.exists(file_path):
        return 0

    # Skip if table already has data (one-time import)
    existing_count = db.query(DailySummary).count()
    if existing_count > 0:
        print(f"  Daily table already has {existing_count} rows, skipping import.")
        return 0

    count = 0
    skipped = 0
    with open(file_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for line_num, row in enumerate(reader, start=2):
            try:
                date_str = normalize_date(row.get("Date", ""))
                if not date_str:
                    print(f"  Skipping daily line {line_num}: empty date")
                    skipped += 1
                    continue

                daily = DailySummary(
                    date=date_str,
                    day_of_week=row.get("DOTW", "").strip(),
                    workout_type=row.get("Workout", "").strip(),
                    weight_lbs=safe_float(row.get("Weight (lbs)")),
                    calories_in=safe_float(row.get("Calories In")),
                    protein_g=safe_float(row.get("Protein (g)")),
                    carbs_g=safe_float(row.get("Carbs (g)")),
                    fat_g=safe_float(row.get("Fat (g)")),
                    fiber_g=safe_float(row.get("Fiber (g)")),
                    est_active_burn=safe_float(row.get("Est. Active Burn")),
                    sedentary_tdee=safe_float(row.get("Sedentary TDEE") or row.get("Conservative TDEE")),
                    formula_tdee=safe_float(row.get("Formula TDEE")),
                    cico_tdee=safe_float(row.get("CICO TDEE")),
                    net_deficit=safe_float(row.get("Net Deficit")),
                    drinks_consumed=safe_float(row.get("Drinks Consumed")),
                    habit_qty=safe_float(row.get(habit_qty_header())),
                    mood=row.get("Mood", "").strip(),
                    notes=row.get("Notes", "").strip(),
                )
                db.add(daily)
                count += 1
            except Exception as e:
                print(f"  Skipping daily line {line_num}: {e}")
                skipped += 1
                continue

    db.commit()
    if skipped > 0:
        print(f"  Daily: imported {count}, skipped {skipped}")
    return count


def run_import(import_dir: str, db: Session) -> dict:
    """
    Run all CSV imports from the given directory.
    Looks for meals.csv, workouts.csv, daily.csv files.
    Each table is only imported if it's currently empty (one-time import).
    """
    results = {}
    results["meals"] = import_meals_csv(os.path.join(import_dir, "meals.csv"), db)
    results["workouts"] = import_workouts_csv(os.path.join(import_dir, "workouts.csv"), db)
    results["daily"] = import_daily_csv(os.path.join(import_dir, "daily.csv"), db)
    return results
