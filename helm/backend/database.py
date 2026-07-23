"""
Database layer for the fitness tracker application.
Uses SQLAlchemy with SQLite backend. The database file is stored
in a Docker-mounted volume at /app/data/fitness.db for persistence.
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
os.makedirs(DATA_DIR, exist_ok=True)

DATABASE_URL = f"sqlite:///{os.path.join(DATA_DIR, 'fitness.db')}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},  # Required for SQLite + FastAPI
    echo=False,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def init_db() -> None:
    """Create all tables if they don't exist."""
    from . import models  # noqa: F401 — import to register models with Base
    from sqlalchemy import text, inspect
    Base.metadata.create_all(bind=engine)
    with engine.connect() as conn:
        cols = [c['name'] for c in inspect(engine).get_columns('daily_summaries')]
        if 'habit_custom' not in cols:
            conn.execute(text("ALTER TABLE daily_summaries ADD COLUMN habit_custom BOOLEAN NOT NULL DEFAULT 0"))
            conn.commit()
        if 'habit_qty' not in cols:
            conn.execute(text("ALTER TABLE daily_summaries ADD COLUMN habit_qty REAL"))
            conn.commit()
        if 'caffeine_mg' not in cols:
            conn.execute(text("ALTER TABLE daily_summaries ADD COLUMN caffeine_mg REAL"))
            conn.commit()
        if 'sleep_bedtime' not in cols:
            conn.execute(text("ALTER TABLE daily_summaries ADD COLUMN sleep_bedtime TEXT"))
            conn.commit()
        if 'sleep_waketime' not in cols:
            conn.execute(text("ALTER TABLE daily_summaries ADD COLUMN sleep_waketime TEXT"))
            conn.commit()
        if 'sleep_hours' not in cols:
            conn.execute(text("ALTER TABLE daily_summaries ADD COLUMN sleep_hours REAL"))
            conn.commit()
        if 'sleep_source' not in cols:
            conn.execute(text("ALTER TABLE daily_summaries ADD COLUMN sleep_source TEXT"))
            conn.commit()
        # Add context column to chat_messages if missing
        chat_tables = inspect(engine).get_table_names()
        if 'chat_messages' in chat_tables:
            chat_cols = [c['name'] for c in inspect(engine).get_columns('chat_messages')]
            if 'context' not in chat_cols:
                conn.execute(text("ALTER TABLE chat_messages ADD COLUMN context TEXT NOT NULL DEFAULT 'advisor'"))
                conn.commit()
        # workout_sessions: UTC window columns for on-demand native-resolution HR fetch
        if 'workout_sessions' in inspect(engine).get_table_names():
            ws_cols = [c['name'] for c in inspect(engine).get_columns('workout_sessions')]
            if 'start_utc' not in ws_cols:
                conn.execute(text("ALTER TABLE workout_sessions ADD COLUMN start_utc TEXT"))
                conn.commit()
            if 'end_utc' not in ws_cols:
                conn.execute(text("ALTER TABLE workout_sessions ADD COLUMN end_utc TEXT"))
                conn.commit()
            if 'hr_curve' not in ws_cols:
                conn.execute(text("ALTER TABLE workout_sessions ADD COLUMN hr_curve TEXT"))
                conn.commit()
            # Run-import scalar columns (Google metricsSummary)
            for col, ddl in [
                ("calories_kcal", "ALTER TABLE workout_sessions ADD COLUMN calories_kcal REAL"),
                ("elevation_gain_m", "ALTER TABLE workout_sessions ADD COLUMN elevation_gain_m REAL"),
                ("avg_cadence_spm", "ALTER TABLE workout_sessions ADD COLUMN avg_cadence_spm INTEGER"),
                ("avg_pace_s_per_km", "ALTER TABLE workout_sessions ADD COLUMN avg_pace_s_per_km REAL"),
                ("burn_applied", "ALTER TABLE workout_sessions ADD COLUMN burn_applied BOOLEAN NOT NULL DEFAULT 0"),
                ("is_duplicate", "ALTER TABLE workout_sessions ADD COLUMN is_duplicate BOOLEAN NOT NULL DEFAULT 0"),
                ("platform", "ALTER TABLE workout_sessions ADD COLUMN platform TEXT"),
            ]:
                if col not in ws_cols:
                    conn.execute(text(ddl))
                    conn.commit()
        # Activity-model spine: attach manual rows to activities (additive)
        w_cols = [c['name'] for c in inspect(engine).get_columns('workouts')]
        if 'activity_id' not in w_cols:
            conn.execute(text("ALTER TABLE workouts ADD COLUMN activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL"))
            conn.commit()
            print("[INIT] Added activity_id column to workouts", flush=True)
        # create_all skips existing tables, so migrated DBs never got the model's
        # declared index on workouts.activity_id — create it explicitly (idempotent).
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_workouts_activity_id ON workouts(activity_id)"))
        conn.commit()
        # activities.finalized — user "locked in" a Google session (visible w/o manual rows)
        if 'activities' in inspect(engine).get_table_names():
            a_cols = [c['name'] for c in inspect(engine).get_columns('activities')]
            if 'finalized' not in a_cols:
                conn.execute(text("ALTER TABLE activities ADD COLUMN finalized BOOLEAN NOT NULL DEFAULT 0"))
                conn.commit()
                print("[INIT] Added finalized column to activities", flush=True)
            # Row-less cardio (2026-07-16): manual cardio metrics live on the activity
            for col, ddl in [
                ("laps", "ALTER TABLE activities ADD COLUMN laps INTEGER"),
                ("distance_m", "ALTER TABLE activities ADD COLUMN distance_m REAL"),
                ("duration_min", "ALTER TABLE activities ADD COLUMN duration_min REAL"),
                ("notes", "ALTER TABLE activities ADD COLUMN notes TEXT"),
            ]:
                if col not in a_cols:
                    conn.execute(text(ddl))
                    conn.commit()
                    print(f"[INIT] Added {col} column to activities", flush=True)
    # Multi-user: add user_id to recipes, cook_logs, shopping_list_items
    with engine.connect() as conn:
        for table in ['recipes', 'cook_logs', 'shopping_list_items']:
            cols = [c['name'] for c in inspect(engine).get_columns(table)]
            if 'user_id' not in cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL"))
                conn.commit()
                print(f"[INIT] Added user_id column to {table}", flush=True)
    # Migrate ratings from recipes to cook_logs
    with engine.connect() as conn:
        cook_log_cols = [c['name'] for c in inspect(engine).get_columns('cook_logs')]
        if 'rating' not in cook_log_cols:
            conn.execute(text("ALTER TABLE cook_logs ADD COLUMN rating REAL"))
            conn.execute(text("ALTER TABLE cook_logs ADD COLUMN rating_comment TEXT"))
            # Copy recipe ratings to their first cook log
            conn.execute(text("""
                UPDATE cook_logs SET rating = (
                    SELECT r.rating FROM recipes r WHERE r.id = cook_logs.recipe_id
                ), rating_comment = (
                    SELECT r.rating_comment FROM recipes r WHERE r.id = cook_logs.recipe_id
                )
                WHERE cook_logs.id IN (
                    SELECT MIN(cl.id) FROM cook_logs cl
                    INNER JOIN recipes r ON r.id = cl.recipe_id
                    WHERE r.rating IS NOT NULL
                    GROUP BY cl.recipe_id
                )
            """))
            conn.commit()
            print("[INIT] Migrated ratings from recipes to cook_logs", flush=True)

        # Drop rating columns from recipes (if they still exist)
        try:
            recipe_cols = [c['name'] for c in inspect(engine).get_columns('recipes')]
            if 'rating' in recipe_cols:
                conn.execute(text("ALTER TABLE recipes DROP COLUMN rating"))
                conn.execute(text("ALTER TABLE recipes DROP COLUMN rating_comment"))
                conn.commit()
                print("[INIT] Dropped rating/rating_comment from recipes table", flush=True)
        except Exception:
            conn.rollback()

    # Drop old ApiUsage table (replaced by GeminiQuota/GeminiRequestLog, since retired)
    with engine.connect() as conn:
        conn.execute(text("DROP TABLE IF EXISTS api_usage"))
        conn.commit()

    # Add confidence columns to meal_items, meals
    with engine.connect() as conn:
        mi_cols = [c['name'] for c in inspect(engine).get_columns('meal_items')]
        if 'confidence' not in mi_cols:
            conn.execute(text("ALTER TABLE meal_items ADD COLUMN confidence REAL"))
            conn.execute(text("ALTER TABLE meal_items ADD COLUMN confidence_reason TEXT"))
            conn.commit()
            print("[INIT] Added confidence columns to meal_items", flush=True)

        m_cols = [c['name'] for c in inspect(engine).get_columns('meals')]
        if 'confidence' not in m_cols:
            conn.execute(text("ALTER TABLE meals ADD COLUMN confidence REAL"))
            conn.commit()
            print("[INIT] Added confidence column to meals", flush=True)

        if 'llm_jobs' in inspect(engine).get_table_names():
            lj_cols = [c['name'] for c in inspect(engine).get_columns('llm_jobs')]
            for col, ddl in [
                ("service", "ALTER TABLE llm_jobs ADD COLUMN service TEXT"),
                ("method", "ALTER TABLE llm_jobs ADD COLUMN method TEXT"),
                ("project", "ALTER TABLE llm_jobs ADD COLUMN project TEXT"),
                ("waterfall_position", "ALTER TABLE llm_jobs ADD COLUMN waterfall_position INTEGER"),
                ("avg_confidence", "ALTER TABLE llm_jobs ADD COLUMN avg_confidence REAL"),
                ("min_confidence", "ALTER TABLE llm_jobs ADD COLUMN min_confidence REAL"),
                ("low_confidence_count", "ALTER TABLE llm_jobs ADD COLUMN low_confidence_count INTEGER"),
            ]:
                if col not in lj_cols:
                    conn.execute(text(ddl)); conn.commit()

    # Seed companies if table is empty
    from .routers.companies import seed_companies
    db = SessionLocal()
    try:
        seed_companies(db)
    finally:
        db.close()

    # Migrate legacy claude_* HelmSetting keys to generic llm_* keys
    _s = SessionLocal()
    try:
        migrate_llm_setting_keys(_s)
    finally:
        _s.close()

    # Activities backfill (workout activity model, 2026-07-13). Guarded by a
    # needs-backfill check rather than table-emptiness: live writers (manual +
    # hourly sync) already create activities for new data, so the table is
    # non-empty before the historical backfill runs. migrate_activities is
    # idempotent, so re-running on leftovers is safe and converges to a no-op.
    from .services.activity_service import migrate_activities, needs_activity_backfill
    _a = SessionLocal()
    try:
        if needs_activity_backfill(_a):
            migrate_activities(_a)
    finally:
        _a.close()

    # Google session dedup (2026-07-14): Google stores one workout as several sessions
    # (two type enums, or phone+watch). Flag the extra copies + prune the orphan
    # activities they created. Idempotent one-time cleanup here; also runs every sync.
    from .services.google_health_service import dedupe_sessions
    _dd = SessionLocal()
    try:
        n = dedupe_sessions(_dd)
        if n:
            print(f"[INIT] flagged {n} duplicate Google session(s)", flush=True)
    finally:
        _dd.close()

    # Row-less cardio (2026-07-16): absorb legacy cardio carrier rows into
    # activity columns and delete them. Guarded + idempotent (converges to
    # zero rows attached to standalone-cardio activities). Runs AFTER the
    # activities backfill so every row has its activity_id.
    from .services.activity_service import migrate_cardio_metadata
    _cm = SessionLocal()
    try:
        migrate_cardio_metadata(_cm)
    finally:
        _cm.close()


def migrate_llm_setting_keys(db) -> None:
    """Rename legacy claude_* HelmSetting keys to generic llm_* keys (idempotent)."""
    from .models import HelmSetting
    renames = {"claude_model": "llm_model", "claude_effort": "llm_effort"}
    changed = False
    for old, new in renames.items():
        row = db.query(HelmSetting).filter_by(key=old).first()
        if row and not db.query(HelmSetting).filter_by(key=new).first():
            row.key = new
            changed = True
        elif row:
            db.delete(row)  # a new key already exists; drop the stale old one
            changed = True
    if changed:
        db.commit()


def get_db():
    """FastAPI dependency that yields a database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
