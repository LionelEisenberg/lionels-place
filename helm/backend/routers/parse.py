"""
Parse router — the core chat-first endpoint.
Accepts natural language → returns typed intent cards via Gemini.
Handles the parse → preview → confirm flow.
"""

from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Meal, MealItem, Workout, DailySummary
from ..schemas import (
    CommitRequest, CommitResponse,
    WorkoutCreate, MealCreate,
    DailySummaryResponse,
)
from ..services.advisor_service import GeminiAdvisor
from ..services.daily_calculator import get_or_create_daily, recalc_daily
from ..services import job_queue
from ..services import activity_service
from ..services.activity_taxonomy import is_strength_member

router = APIRouter(prefix="/api/parse", tags=["parse"])


def _today_str() -> str:
    """Return today's date in YYYY-MM-DD format."""
    import zoneinfo
    return datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")


def _get_recent_meals(db: Session, limit: int = 150) -> list:
    """Get the most recent meals for context injection."""
    return db.query(Meal).order_by(Meal.date.desc(), Meal.id.desc()).limit(limit).all()


def _get_recent_workouts(db: Session, limit: int = 200) -> list:
    """Get the most recent workouts for context injection."""
    return db.query(Workout).order_by(Workout.date.desc(), Workout.id.desc()).limit(limit).all()


def _get_recent_daily(db: Session, limit: int = 14) -> list:
    """Get recent daily summaries for context injection."""
    return db.query(DailySummary).order_by(DailySummary.date.desc()).limit(limit).all()


def _apply_confidence_metrics(db, *, request_log_id, item_confidences) -> None:
    """Update the llm_jobs row (keyed by job_id) with confidence metrics from a commit."""
    if not (item_confidences and request_log_id):
        return
    from ..models import LLMJob
    row = db.query(LLMJob).filter(LLMJob.job_id == request_log_id).first()
    if row:
        row.avg_confidence = sum(item_confidences) / len(item_confidences)
        row.min_confidence = min(item_confidences)
        row.low_confidence_count = sum(1 for c in item_confidences if c < 0.4)
        db.commit()


def _build_context(db: Session) -> str:
    """Build combined context from recent data for Gemini."""
    meals = _get_recent_meals(db)
    workouts = _get_recent_workouts(db)
    daily = _get_recent_daily(db)

    parts = [
        GeminiAdvisor.build_meal_context(meals),
        GeminiAdvisor.build_workout_context(workouts),
        GeminiAdvisor.build_daily_context(daily, db=db),
    ]
    return "\n\n".join(parts)


@router.post("/commit", response_model=CommitResponse)
async def commit_intents(req: CommitRequest, db: Session = Depends(get_db)):
    """
    Persist confirmed intent cards to the database.
    Recalculates daily totals after commit.
    """
    meals_created = 0
    workouts_created = 0
    weight_updated = False
    caffeine_updated = False
    notes_added = False
    sleep_updated = False

    all_item_confidences = []
    dates_touched: set[str] = set()

    for intent in req.intents:
        entry_date = getattr(intent, 'date', None) or req.date
        dates_touched.add(entry_date)

        if intent.type == "meal" and intent.meal_data:
            from ..services.confidence import compute_meal_confidence
            meal_confidence = compute_meal_confidence(intent.meal_data.items) if intent.meal_data.items else None

            meal = Meal(
                date=entry_date,
                meal=intent.meal_data.meal,
                description=intent.meal_data.description,
                calories=intent.meal_data.calories,
                protein_g=intent.meal_data.protein_g,
                carbs_g=intent.meal_data.carbs_g,
                fat_g=intent.meal_data.fat_g,
                fiber_g=intent.meal_data.fiber_g,
                confidence=meal_confidence,
            )
            db.add(meal)
            db.flush()  # Get meal.id for MealItem FK

            # Persist sub-items parsed by Gemini
            for item in intent.meal_data.items:
                db.add(MealItem(
                    meal_id=meal.id,
                    name=item.name,
                    quantity=item.quantity,
                    calories=item.calories,
                    protein_g=item.protein_g,
                    carbs_g=item.carbs_g,
                    fat_g=item.fat_g,
                    fiber_g=item.fiber_g,
                    confidence=item.confidence,
                    confidence_reason=item.confidence_reason,
                ))

            all_item_confidences.extend([item.confidence for item in intent.meal_data.items])
            meals_created += 1

        elif intent.type == "workout" and intent.workout_data:
            wd = intent.workout_data
            valid = activity_service.is_canonical_activity(wd.activity)
            act = (activity_service.get_or_create_activity(db, entry_date, wd.activity, wd.label)
                   if valid else None)
            for ex in wd.exercises:
                declared_cardio = act is not None and act.activity != "strength"
                if declared_cardio and not is_strength_member(ex.exercise, ex.category):
                    # Row-less cardio: the entry folds into the activity's columns.
                    activity_service.absorb_exercise(
                        db, act, ex.exercise, ex.reps_sets or "", ex.notes or "")
                    continue
                workout = Workout(
                    date=entry_date, category=ex.category, equipment_type=ex.equipment_type,
                    exercise=ex.exercise, weight_lbs=ex.weight_lbs or "",
                    reps_sets=ex.reps_sets or "", notes=ex.notes or "",
                    targeted_muscle_group=ex.targeted_muscle_group,
                )
                db.add(workout)
                db.flush()
                if act is not None and not declared_cardio:
                    workout.activity_id = act.id                 # LLM-declared split
                else:
                    # Heuristic fallback — and the guard for a strength-style entry
                    # inside a cardio-labelled intent: absorbing it would silently
                    # destroy the weights, so it routes to strength as a row instead.
                    activity_service.record_exercise(db, workout)
            workouts_created += len(wd.exercises)
            # Sticky workout_type re-derivation. NO est_active_burn — MET removed.
            get_or_create_daily(entry_date, db)

        elif intent.type == "weight" and intent.weight_data:
            daily = get_or_create_daily(entry_date, db)
            daily.weight_lbs = intent.weight_data.weight_lbs
            weight_updated = True

        elif intent.type == "note" and intent.note_data:
            daily = get_or_create_daily(entry_date, db)
            existing_notes = daily.notes or ""
            separator = "; " if existing_notes else ""
            daily.notes = existing_notes + separator + intent.note_data.note
            notes_added = True

        elif intent.type == "habit" and intent.habit_data:
            daily = get_or_create_daily(entry_date, db)
            daily.habit_qty = round((daily.habit_qty or 0) + intent.habit_data.amount, 2)

        elif intent.type == "caffeine" and intent.caffeine_data:
            daily = get_or_create_daily(entry_date, db)
            daily.caffeine_mg = round((daily.caffeine_mg or 0) + intent.caffeine_data.amount_mg, 1)
            caffeine_updated = True

        elif intent.type == "mood" and intent.mood_data:
            daily = get_or_create_daily(entry_date, db)
            daily.mood = intent.mood_data.mood
            # mood_updated is not strictly tracked in the CommitResponse schema, but we persist it.

        elif intent.type == "sleep" and intent.sleep_data:
            daily = get_or_create_daily(entry_date, db)
            if intent.sleep_data.bedtime:
                daily.sleep_bedtime = intent.sleep_data.bedtime
            if intent.sleep_data.waketime:
                daily.sleep_waketime = intent.sleep_data.waketime
            daily.sleep_hours = intent.sleep_data.hours
            sleep_updated = True

    # Update confidence metrics on the llm_jobs row (keyed by job_id)
    _apply_confidence_metrics(db, request_log_id=req.request_log_id, item_confidences=all_item_confidences)

    # Resolve the parse job server-side (durable belt to the frontend ack): once its
    # intents are committed, it must not reconnect on refresh and re-stage them.
    if req.request_log_id:
        job_queue.mark_resolved(db, req.request_log_id)

    db.commit()

    # Recalculate daily totals for every date touched by the intents
    # (an intent's date may differ from req.date, e.g. logging a meal for yesterday)
    dates_touched.add(req.date)
    for d in dates_touched:
        if d != req.date:
            recalc_daily(d, db)
    daily = recalc_daily(req.date, db)

    daily_response = DailySummaryResponse(
        id=daily.id,
        date=daily.date,
        day_of_week=daily.day_of_week,
        workout_type=daily.workout_type,
        weight_lbs=daily.weight_lbs,
        calories_in=daily.calories_in,
        protein_g=daily.protein_g,
        carbs_g=daily.carbs_g,
        fat_g=daily.fat_g,
        fiber_g=daily.fiber_g,
        bf_pct=daily.bf_pct,
        est_active_burn=daily.est_active_burn,
        sedentary_tdee=daily.sedentary_tdee,
        formula_tdee=daily.formula_tdee,
        cico_tdee=daily.cico_tdee,
        net_deficit=daily.net_deficit,
        drinks_consumed=daily.drinks_consumed,
        habit_qty=daily.habit_qty,
        caffeine_mg=daily.caffeine_mg,
        sleep_bedtime=daily.sleep_bedtime,
        sleep_waketime=daily.sleep_waketime,
        sleep_hours=daily.sleep_hours,
        mood=daily.mood,
        notes=daily.notes or "",
    )

    return CommitResponse(
        meals_created=meals_created,
        workouts_created=workouts_created,
        weight_updated=weight_updated,
        caffeine_updated=caffeine_updated,
        notes_added=notes_added,
        sleep_updated=sleep_updated,
        daily_totals=daily_response,
    )
