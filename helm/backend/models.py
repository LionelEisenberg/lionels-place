"""
SQLAlchemy ORM models for the fitness tracker.
Maps directly to the existing Google Sheets schema.
"""

from datetime import datetime
from sqlalchemy import Column, Integer, Float, Text, Boolean, DateTime, CheckConstraint, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from .database import Base

# ==========================================
# Valid enum values (matching Gem instructions)
# ==========================================

EQUIPMENT_TYPES = ("Dumbbell", "Barbell", "None", "Plates", "Machine", "Cable", "Bodyweight", "Smith Machine", "Bands")
WORKOUT_TYPES = ("Push", "Pull", "Legs", "Cardio", "Mixed")

MUSCLE_GROUPS = (
    "Triceps", "Biceps", "Chest", "Lats", "Delts", "Quads",
    "Hamstrings", "Glutes", "Core", "Adductors", "Full Body",
    "Forearms / Grip", "Traps", "Lower Back", "Cardio", "Calves",
    "Abductors", "Rhomboids",
)


class Meal(Base):
    """A single meal entry (one row in the Meal Database sheet)."""
    __tablename__ = "meals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Text, nullable=False, index=True)          # MM/DD/YY
    meal = Column(Text, nullable=False)                       # Breakfast, Lunch, etc.
    description = Column(Text, nullable=False)
    calories = Column(Float, nullable=False)
    protein_g = Column(Float, nullable=False)
    carbs_g = Column(Float, nullable=False)
    fat_g = Column(Float, nullable=False)
    fiber_g = Column(Float, nullable=False, server_default="0")
    confidence = Column(Float, nullable=True)
    created_at = Column(Text, server_default=func.now())

    items = relationship("MealItem", back_populates="meal", cascade="all, delete-orphan")


class MealItem(Base):
    """A single food item within a meal (sub-ingredient parsed by Gemini AI)."""
    __tablename__ = "meal_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    meal_id = Column(Integer, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(Text, nullable=False)
    quantity = Column(Text, nullable=False)
    calories = Column(Float, nullable=False)
    protein_g = Column(Float, nullable=False)
    carbs_g = Column(Float, nullable=False)
    fat_g = Column(Float, nullable=False)
    fiber_g = Column(Float, nullable=False, server_default="0")
    confidence = Column(Float, nullable=True)
    confidence_reason = Column(Text, nullable=True)

    meal = relationship("Meal", back_populates="items")


class MealItemPin(Base):
    """A pinned MealItem (by name+quantity) for the Quick Add panel."""
    __tablename__ = "meal_item_pins"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False)         # stored lowercased
    quantity = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("name", "quantity", name="uq_pin_name_qty"),
    )


class Workout(Base):
    """A single exercise entry (one row in the Workout Database sheet)."""
    __tablename__ = "workouts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Text, nullable=False, index=True)
    category = Column(Text, nullable=False)                   # Upper Body, Lower Body, Core, Cardio
    equipment_type = Column(Text, nullable=False)
    exercise = Column(Text, nullable=False)
    weight_lbs = Column(Text, nullable=False)                 # "30, 35, 35" per-set
    reps_sets = Column(Text, nullable=False)                  # "8, 8, 9" per-set
    notes = Column(Text, nullable=False, server_default="")
    targeted_muscle_group = Column(Text, nullable=False)
    # Nullable for migration safety only — every writer sets it (activity_service).
    activity_id = Column(Integer, ForeignKey("activities.id", ondelete="SET NULL"),
                         nullable=True, index=True)
    created_at = Column(Text, server_default=func.now())


class DailySummary(Base):
    """Daily summary row (one row per day in the Daily Database sheet)."""
    __tablename__ = "daily_summaries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Text, nullable=False, unique=True, index=True)
    day_of_week = Column(Text)                                # Monday, Tuesday, etc.
    workout_type = Column(Text)                                # Push, Pull, Legs, Rest/Cardio
    weight_lbs = Column(Float)                                  # Morning dry weight
    bf_pct = Column(Float, nullable=True)                       # Body Fat Percentage
    calories_in = Column(Float, nullable=False, server_default="0")
    protein_g = Column(Float, nullable=False, server_default="0")
    carbs_g = Column(Float, nullable=False, server_default="0")
    fat_g = Column(Float, nullable=False, server_default="0")
    fiber_g = Column(Float, nullable=False, server_default="0")
    est_active_burn = Column(Float, nullable=False, server_default="0")
    sedentary_tdee = Column(Float, nullable=False, server_default="0")
    formula_tdee = Column(Float, nullable=True)
    cico_tdee = Column(Float, nullable=True)
    net_deficit = Column(Float, nullable=False, server_default="0")
    drinks_consumed = Column(Float, nullable=False, default=0.0, server_default="0")
    habit_qty = Column(Float, nullable=True)
    caffeine_mg = Column(Float, nullable=True)
    sleep_bedtime = Column(Text, nullable=True)               # "23:00" 24h format
    sleep_waketime = Column(Text, nullable=True)              # "06:30" 24h format
    sleep_hours = Column(Float, nullable=True)                 # Hours slept (direct or calculated)
    sleep_source = Column(Text, nullable=True)                 # 'manual' | 'google' — gap-fill provenance
    mood = Column(Text, nullable=True)
    notes = Column(Text, nullable=False, server_default="")
    habit_workout = Column(Boolean, nullable=False, server_default="0")
    habit_clean = Column(Boolean, nullable=False, server_default="0")
    habit_productivity = Column(Boolean, nullable=False, server_default="0")
    habit_sleep = Column(Boolean, nullable=False, server_default="0")
    habit_love = Column(Boolean, nullable=False, server_default="0")
    habit_custom = Column(Boolean, nullable=False, server_default="0")
    created_at = Column(Text, server_default=func.now())


class ProgressPhoto(Base):
    """One progress photo per day, stored on disk."""
    __tablename__ = "progress_photos"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Text, nullable=False, unique=True, index=True)   # YYYY-MM-DD
    filename = Column(Text, nullable=False)                         # e.g. "2026-03-10.jpg"
    created_at = Column(DateTime, default=datetime.utcnow)


class HelmSetting(Base):
    """Key-value runtime settings, changeable via admin UI."""
    __tablename__ = "helm_settings"

    key = Column(Text, primary_key=True)
    value = Column(Text, nullable=False)


class Task(Base):
    """A task card on the Kanban board."""
    __tablename__ = "tasks"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    title        = Column(Text, nullable=False)
    category     = Column(Text, nullable=False, server_default="Personal")
    status       = Column(Text, nullable=False, server_default="todo")
    priority     = Column(Text, nullable=True)
    due_date     = Column(Text, nullable=True)
    notes        = Column(Text, nullable=True)
    position     = Column(Float, nullable=False, server_default="1000.0")
    created_at   = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        CheckConstraint("status IN ('todo','in_progress','done')", name="ck_task_status"),
        CheckConstraint("priority IN ('high','medium','low') OR priority IS NULL", name="ck_task_priority"),
    )


COMPANY_TIERS = ("gaming_t1", "gaming_t2", "tech_t1", "tech_t2", "adjacent")


class Company(Base):
    """A target company in the job search tier list."""
    __tablename__ = "companies"

    id                     = Column(Integer, primary_key=True, autoincrement=True)
    name                   = Column(Text, nullable=False)
    tier                   = Column(Text, nullable=False)
    location               = Column(Text, nullable=True)
    notes                  = Column(Text, nullable=True)
    role_types             = Column(Text, nullable=True)
    careers_url            = Column(Text, nullable=True)
    website_url            = Column(Text, nullable=True)
    market_info            = Column(Text, nullable=True)
    market_info_updated_at = Column(DateTime, nullable=True)
    created_at             = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        CheckConstraint(
            "tier IN ('gaming_t1','gaming_t2','tech_t1','tech_t2','adjacent')",
            name="ck_company_tier",
        ),
    )


class ChatMessage(Base):
    """Stores chat history for the AI advisor. Scoped by context."""
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    role = Column(Text, nullable=False)                        # 'user' or 'assistant'
    content = Column(Text, nullable=False)
    context = Column(Text, nullable=False, server_default="advisor")  # 'advisor' | 'companies' | 'applications' | 'leetcode' | 'leetcode:{id}'
    created_at = Column(Text, server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "role IN ('user', 'assistant')",
            name="ck_chat_role",
        ),
    )


# ==========================================
# Job Search — Applications
# ==========================================

APPLICATION_STATUSES = (
    "researching", "applied", "phone_screen", "technical",
    "final", "offer", "rejected", "withdrawn",
)


class Application(Base):
    """A job application with status tracking and event history."""
    __tablename__ = "applications"

    id             = Column(Integer, primary_key=True, autoincrement=True)
    company_id     = Column(Integer, nullable=True, index=True)   # FK to companies.id (nullable for unlisted)
    company_name   = Column(Text, nullable=False)                 # Denormalized for display
    job_title      = Column(Text, nullable=False)
    status         = Column(Text, nullable=False, server_default="researching")
    salary_range   = Column(Text, nullable=True)                  # Free text, e.g. "$180-220k"
    recruiter_name = Column(Text, nullable=True)
    posting_url    = Column(Text, nullable=True)
    notes          = Column(Text, nullable=True)
    applied_date   = Column(Text, nullable=True)                  # Auto-set on first transition to "applied"
    created_at     = Column(DateTime, default=datetime.utcnow)
    updated_at     = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        CheckConstraint(
            "status IN ('researching','applied','phone_screen','technical','final','offer','rejected','withdrawn')",
            name="ck_application_status",
        ),
    )


class ApplicationEvent(Base):
    """An event in an application's timeline (status transitions, notes)."""
    __tablename__ = "application_events"

    id             = Column(Integer, primary_key=True, autoincrement=True)
    application_id = Column(Integer, nullable=False, index=True)  # FK to applications.id
    status         = Column(Text, nullable=False)                 # The status transitioned TO
    note           = Column(Text, nullable=True)
    created_at     = Column(DateTime, default=datetime.utcnow)


# ==========================================
# Job Search — Leetcode Tracker
# ==========================================

LEETCODE_CATEGORIES = (
    "Arrays & Hashing", "Two Pointers", "Sliding Window", "Stack",
    "Binary Search", "Linked List", "Trees", "Tries",
    "Heap / Priority Queue", "Backtracking", "Graphs", "Advanced Graphs",
    "1-D Dynamic Programming", "2-D Dynamic Programming",
    "Greedy", "Intervals", "Math & Geometry", "Bit Manipulation",
)

LEETCODE_DIFFICULTIES = ("Easy", "Medium", "Hard")
LEETCODE_STATUSES = ("todo", "attempted", "solved")


class LeetcodeProblem(Base):
    """A leetcode problem for interview prep tracking."""
    __tablename__ = "leetcode_problems"

    id                  = Column(Integer, primary_key=True, autoincrement=True)
    name                = Column(Text, nullable=False)
    number              = Column(Integer, nullable=True)           # LC problem number
    url                 = Column(Text, nullable=True)
    category            = Column(Text, nullable=False)             # Pattern tag
    difficulty          = Column(Text, nullable=False)             # Easy / Medium / Hard
    status              = Column(Text, nullable=False, server_default="todo")
    solved_without_help = Column(Boolean, nullable=False, server_default="0")
    notes               = Column(Text, nullable=True)
    created_at          = Column(DateTime, default=datetime.utcnow)
    solved_at           = Column(DateTime, nullable=True)
    neetcode_order      = Column(Integer, nullable=True)         # Position in NeetCode 150 (1-150), null for custom

    __table_args__ = (
        CheckConstraint("status IN ('todo','attempted','solved')", name="ck_lc_status"),
        CheckConstraint("difficulty IN ('Easy','Medium','Hard')", name="ck_lc_difficulty"),
    )


# ==========================================
# Schedule — Template & Time Blocks
# ==========================================

class TemplateBlock(Base):
    """A single block in the user's ideal week template."""
    __tablename__ = "template_blocks"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    name        = Column(Text, nullable=False)
    day_of_week = Column(Integer, nullable=False)              # 0=Monday, 6=Sunday
    start_time  = Column(Text, nullable=False)                 # "HH:MM"
    end_time    = Column(Text, nullable=False)                 # "HH:MM"
    category    = Column(Text, nullable=False, server_default="personal")
    color       = Column(Text, nullable=False, server_default="indigo")

    __table_args__ = (
        CheckConstraint("day_of_week >= 0 AND day_of_week <= 6", name="ck_template_dow"),
        CheckConstraint(
            "category IN ('workout','meals','leetcode','job_search','productivity','personal')",
            name="ck_template_category",
        ),
    )


class TimeBlock(Base):
    """An actual scheduled block for a specific date."""
    __tablename__ = "time_blocks"

    id                = Column(Integer, primary_key=True, autoincrement=True)
    date              = Column(Text, nullable=False, index=True)     # "YYYY-MM-DD"
    name              = Column(Text, nullable=False)
    start_time        = Column(Text, nullable=False)                 # "HH:MM"
    end_time          = Column(Text, nullable=False)                 # "HH:MM"
    category          = Column(Text, nullable=False, server_default="personal")
    color             = Column(Text, nullable=False, server_default="indigo")
    status            = Column(Text, nullable=False, server_default="planned")
    task_id           = Column(Integer, nullable=True)               # FK to tasks.id
    template_block_id = Column(Integer, nullable=True)               # FK to template_blocks.id
    notes             = Column(Text, nullable=True)
    created_at        = Column(DateTime, default=datetime.utcnow)
    updated_at        = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        CheckConstraint(
            "category IN ('workout','meals','leetcode','job_search','productivity','personal')",
            name="ck_timeblock_category",
        ),
        CheckConstraint(
            "status IN ('planned','done','skipped')",
            name="ck_timeblock_status",
        ),
    )

# ==========================================
# Recipe Bank
# ==========================================

class Recipe(Base):
    """A recipe in the personal cookbook."""
    __tablename__ = "recipes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False)
    source_url = Column(Text, nullable=True)
    instructions = Column(Text, nullable=False)
    notes = Column(Text, nullable=True)
    servings = Column(Integer, nullable=True)
    feeds = Column(Integer, nullable=True)         # How many people it feeds (vs servings/yield)
    prep_ahead = Column(Boolean, nullable=False, server_default="0")
    tags = Column(Text, nullable=True)           # Comma-separated: "Italian,Dessert"
    image_filename = Column(Text, nullable=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    ingredients = relationship("RecipeIngredient", back_populates="recipe", cascade="all, delete-orphan")
    cook_logs = relationship("CookLog", back_populates="recipe", cascade="all, delete-orphan")
    user = relationship("User", foreign_keys=[user_id])

    @property
    def added_by(self) -> str | None:
        return self.user.username if self.user else None

    @property
    def rating(self) -> float | None:
        """Average rating from cook logs, or None if no logs are rated."""
        if not self.cook_logs:
            return None
        rated = [cl.rating for cl in self.cook_logs if cl.rating is not None]
        if not rated:
            return None
        return round(sum(rated) / len(rated), 1)


class RecipeIngredient(Base):
    """An ingredient within a recipe."""
    __tablename__ = "recipe_ingredients"

    id = Column(Integer, primary_key=True, autoincrement=True)
    recipe_id = Column(Integer, ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(Text, nullable=False)
    amount = Column(Float, nullable=True)        # Null for "a pinch", "to taste"
    unit = Column(Text, nullable=True)           # "cups", "tbsp", null for unitless
    original_unit = Column(Text, nullable=True)  # Original unit before gram conversion (e.g., "2 tbsp")
    category = Column(Text, nullable=True)       # "Dough", "Filling", "Sauce"
    exotic = Column(Boolean, nullable=False, server_default="0")  # Non-pantry-staple ingredient
    sort_order = Column(Integer, nullable=False, server_default="0")

    recipe = relationship("Recipe", back_populates="ingredients")


class CookLog(Base):
    """A cooking attempt for a recipe."""
    __tablename__ = "cook_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    recipe_id = Column(Integer, ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    date = Column(Text, nullable=False)          # YYYY-MM-DD
    guests = Column(Integer, nullable=True)
    scale_factor = Column(Float, nullable=False, server_default="1.0")
    notes = Column(Text, nullable=True)
    rating = Column(Float, nullable=True)
    rating_comment = Column(Text, nullable=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        CheckConstraint("rating >= 0 AND rating <= 10 OR rating IS NULL", name="ck_cooklog_rating"),
    )

    recipe = relationship("Recipe", back_populates="cook_logs")
    user = relationship("User", foreign_keys=[user_id])
    photos = relationship("CookLogPhoto", back_populates="cook_log", cascade="all, delete-orphan")
    reactions = relationship("CookLogReaction", back_populates="cook_log", cascade="all, delete-orphan")
    comments = relationship("CookLogComment", back_populates="cook_log", cascade="all, delete-orphan")

    @property
    def cooked_by(self) -> str | None:
        return self.user.username if self.user else None

    @property
    def photo_filenames(self) -> list[str]:
        return [p.filename for p in self.photos] if self.photos else []


class CookLogPhoto(Base):
    """A photo attached to a cook log."""
    __tablename__ = "cook_log_photos"

    id = Column(Integer, primary_key=True, autoincrement=True)
    cook_log_id = Column(Integer, ForeignKey("cook_logs.id", ondelete="CASCADE"), nullable=False, index=True)
    filename = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    cook_log = relationship("CookLog", back_populates="photos")


class CookLogReaction(Base):
    """An emoji reaction on a cook log."""
    __tablename__ = "cook_log_reactions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    cook_log_id = Column(Integer, ForeignKey("cook_logs.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    emoji = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("cook_log_id", "user_id", "emoji", name="uq_reaction_per_user"),
    )

    cook_log = relationship("CookLog", back_populates="reactions")
    user = relationship("User", foreign_keys=[user_id])


class CookLogComment(Base):
    """A comment on a cook log."""
    __tablename__ = "cook_log_comments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    cook_log_id = Column(Integer, ForeignKey("cook_logs.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    cook_log = relationship("CookLog", back_populates="comments")
    user = relationship("User", foreign_keys=[user_id])


class ShoppingListItem(Base):
    """An item on the shopping list."""
    __tablename__ = "shopping_list_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False)
    amount = Column(Float, nullable=True)
    unit = Column(Text, nullable=True)
    category = Column(Text, nullable=False, server_default="Other")
    recipe_id = Column(Integer, ForeignKey("recipes.id", ondelete="SET NULL"), nullable=True, index=True)
    recipe_name = Column(Text, nullable=True)
    checked = Column(Boolean, nullable=False, server_default="0")
    exotic = Column(Boolean, nullable=False, server_default="0")
    sort_order = Column(Integer, nullable=False, server_default="0")
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class IngredientCategory(Base):
    """Cached ingredient → grocery aisle mapping. Self-building via Gemini lookups."""
    __tablename__ = "ingredient_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False, unique=True, index=True)  # lowercased ingredient name
    category = Column(Text, nullable=False)  # Produce, Dairy, Meat, Pantry, Spices, Other


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    jellyfin_id = Column(Text, unique=True, nullable=False, index=True)
    username = Column(Text, nullable=False)
    role = Column(Text, nullable=False, server_default="friend")
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime, default=datetime.utcnow)


class LLMJob(Base):
    """Durable LLM job — queue + audit log in one row (Phase 2).

    Helm is the sole writer. Status: queued -> running -> succeeded | failed.
    """
    __tablename__ = "llm_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    job_id = Column(Text, unique=True, nullable=False, index=True)
    idempotency_key = Column(Text, nullable=True, index=True)
    context = Column(Text, nullable=False, index=True)      # originating view, e.g. "dashboard"
    task_type = Column(Text, nullable=False)                # parse_input, chat, plan_workout, ...
    provider = Column(Text, nullable=True)                  # requested override (falls back to settings)
    model = Column(Text, nullable=True)
    effort = Column(Text, nullable=True)
    priority = Column(Integer, nullable=False, server_default="0")   # higher runs first
    status = Column(Text, nullable=False, server_default="queued", index=True)
    lease_expires_at = Column(DateTime, nullable=True)      # set on claim; expiry -> requeue
    attempt_count = Column(Integer, nullable=False, server_default="0")
    max_attempts = Column(Integer, nullable=False, server_default="3")
    errors = Column(Text, nullable=True)                    # JSON array of {attempt, error, ts}
    request_payload = Column(Text, nullable=False)          # JSON
    response_payload = Column(Text, nullable=True)          # JSON
    response_text = Column(Text, nullable=True)
    prompt_tokens = Column(Integer, nullable=True)
    response_tokens = Column(Integer, nullable=True)
    total_tokens = Column(Integer, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    estimated_cost = Column(Float, nullable=True)
    json_requested = Column(Boolean, nullable=False, server_default="0")
    json_valid = Column(Boolean, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    consumed_at = Column(DateTime, nullable=True)           # frontend ack — result seen/accepted

    # --- audit fields (merged from gemini_request_log) ---
    service = Column(Text, nullable=True)              # e.g. HELM_ADVISOR
    method = Column(Text, nullable=True)              # e.g. plan_workout
    project = Column(Text, nullable=True)             # paid / free-tier-1 / claude (worker-reported; null on new rows until 2C worker change)
    waterfall_position = Column(Integer, nullable=True)
    avg_confidence = Column(Float, nullable=True)
    min_confidence = Column(Float, nullable=True)
    low_confidence_count = Column(Integer, nullable=True)


PHASE_TYPES = ("cut", "maintenance", "bulk")


class Phase(Base):
    """A nutrition phase (cut/maintenance/bulk) spanning a date range."""
    __tablename__ = "phases"

    id                = Column(Integer, primary_key=True, autoincrement=True)
    phase_type        = Column(Text, nullable=False)
    start_date        = Column(Text, nullable=False)            # YYYY-MM-DD
    end_date          = Column(Text, nullable=True)             # null = ongoing
    target_calories   = Column(Float, nullable=False)
    target_protein_g  = Column(Float, nullable=False)
    target_carbs_g    = Column(Float, nullable=False)
    target_fat_g      = Column(Float, nullable=False)
    target_fiber_g    = Column(Float, nullable=False)
    target_weight_lbs = Column(Float, nullable=True)
    notes             = Column(Text, nullable=True)
    created_at        = Column(DateTime, default=datetime.utcnow)
    updated_at        = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    refeeds = relationship(
        "Refeed",
        back_populates="phase",
        cascade="all, delete-orphan",
        order_by="Refeed.start_date",
    )

    __table_args__ = (
        CheckConstraint(
            "phase_type IN ('cut','maintenance','bulk')",
            name="ck_phase_type",
        ),
    )


class Refeed(Base):
    """A typed sub-range within a cut phase with its own macro target."""
    __tablename__ = "refeeds"

    id               = Column(Integer, primary_key=True, autoincrement=True)
    phase_id         = Column(
        Integer,
        ForeignKey("phases.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    start_date       = Column(Text, nullable=False)
    end_date         = Column(Text, nullable=False)             # always bounded
    target_calories  = Column(Float, nullable=False)
    target_protein_g = Column(Float, nullable=False)
    target_carbs_g   = Column(Float, nullable=False)
    target_fat_g     = Column(Float, nullable=False)
    target_fiber_g   = Column(Float, nullable=False)
    notes            = Column(Text, nullable=True)
    created_at       = Column(DateTime, default=datetime.utcnow)

    phase = relationship("Phase", back_populates="refeeds")


class OAuthCredential(Base):
    """Stored OAuth tokens for an external provider (Google Health). One row per (provider, user)."""
    __tablename__ = "oauth_credentials"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider = Column(Text, nullable=False, server_default="google_health")
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    refresh_token_enc = Column(Text, nullable=False)
    access_token_enc = Column(Text, nullable=True)
    access_token_expires_at = Column(DateTime, nullable=True)
    scopes = Column(Text, nullable=True)
    status = Column(Text, nullable=False, server_default="connected")  # connected | needs_reconsent | disconnected
    last_sync_at = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("provider", "user_id", name="uq_oauth_provider_user"),
    )


class OAuthState(Base):
    """Short-lived CSRF + PKCE correlation for the OAuth connect handshake."""
    __tablename__ = "oauth_states"

    state = Column(Text, primary_key=True)
    code_verifier = Column(Text, nullable=False)
    user_id = Column(Integer, nullable=True)
    expires_at = Column(DateTime, nullable=False)


class DailyHealth(Base):
    """Net-new Google Health daily biometrics. One row per day, 1:1 with DailySummary by date."""
    __tablename__ = "daily_health"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Text, nullable=False, unique=True, index=True)   # YYYY-MM-DD
    steps = Column(Integer, nullable=True)
    resting_hr = Column(Integer, nullable=True)                     # bpm
    hrv_ms = Column(Float, nullable=True)                           # RMSSD, ms
    respiratory_rate = Column(Float, nullable=True)                 # breaths/min
    sleep_deep_min = Column(Integer, nullable=True)
    sleep_light_min = Column(Integer, nullable=True)
    sleep_rem_min = Column(Integer, nullable=True)
    sleep_awake_min = Column(Integer, nullable=True)
    sleep_efficiency_pct = Column(Float, nullable=True)
    synced_at = Column(DateTime, default=datetime.utcnow)


class IntradayHeartRate(Base):
    """One row per day holding the intraday HR curve (compact JSON) + daily extremes."""
    __tablename__ = "intraday_heart_rate"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Text, nullable=False, unique=True, index=True)   # YYYY-MM-DD
    samples = Column(Text, nullable=False)                          # JSON: {base, interval_s, bpm[]}
    min_bpm = Column(Integer, nullable=True)
    avg_bpm = Column(Integer, nullable=True)
    max_bpm = Column(Integer, nullable=True)
    synced_at = Column(DateTime, default=datetime.utcnow)


class WorkoutSession(Base):
    """A Google `exercise` session — one activity (strength, swim, run, …) with its
    own time window. Parallel to the manual per-exercise Workout rows; sourced from
    Google and never mutates manual data. Many sessions can share a date."""
    __tablename__ = "workout_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    google_id = Column(Text, unique=True, nullable=True, index=True)  # stable datapoint id
    date = Column(Text, nullable=False, index=True)        # YYYY-MM-DD, local start date
    exercise_type = Column(Text, nullable=False)           # display label, e.g. "Pool swim"
    exercise_type_raw = Column(Text, nullable=False)       # raw Google enum (audit)
    category = Column(Text, nullable=False)                # "strength" | "cardio" | "other"
    start_time = Column(Text, nullable=False)              # local ISO "YYYY-MM-DDTHH:MM:SS"
    end_time = Column(Text, nullable=False)                # local ISO
    start_utc = Column(Text, nullable=True)               # UTC ISO — for on-demand windowed HR fetch
    end_utc = Column(Text, nullable=True)                 # UTC ISO
    duration_min = Column(Float, nullable=True)
    distance_m = Column(Float, nullable=True)              # land cardio only (run/walk/bike)
    avg_hr = Column(Integer, nullable=True)                # bpm, from Google metricsSummary
    max_hr = Column(Integer, nullable=True)                # bpm, derived from intraday at read time
    hr_curve = Column(Text, nullable=True)                # cached HR curve JSON {points, min/avg/max} — avoids the live fetch
    calories_kcal = Column(Float, nullable=True)           # metricsSummary.caloriesKcal
    elevation_gain_m = Column(Float, nullable=True)        # metricsSummary.elevationGainMillimeters / 1000
    avg_cadence_spm = Column(Integer, nullable=True)       # metricsSummary.mobilityMetrics.avgCadenceStepsPerMinute
    avg_pace_s_per_km = Column(Float, nullable=True)       # metricsSummary.averagePaceSecondsPerMeter * 1000
    burn_applied = Column(Boolean, nullable=False, server_default="0")  # kcal already added to est_active_burn
    is_duplicate = Column(Boolean, nullable=False, server_default="0")   # same real workout as a canonical sibling (two type enums / phone+watch); no activity, no burn
    platform = Column(Text, nullable=True)                               # Google dataSource.platform: FITBIT | HEALTH_CONNECT | … — the Fitbit copy wins dedup
    source = Column(Text, nullable=False, server_default="google")
    synced_at = Column(DateTime, default=datetime.utcnow)


class RunDetail(Base):
    """TCX-derived per-run payload (route polyline + splits) — 1:1 child of a
    RUNNING/TREADMILL_RUNNING WorkoutSession. Blobs live here to keep the hot
    workout_sessions table narrow."""
    __tablename__ = "run_details"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workout_session_id = Column(Integer, ForeignKey("workout_sessions.id", ondelete="CASCADE"),
                                unique=True, nullable=False, index=True)
    route = Column(Text, nullable=True)        # JSON [[lat, lng], ...], downsampled to <=500 points; null when no GPS
    splits = Column(Text, nullable=True)       # JSON [{distance_m, seconds, avg_hr, marker}, ...]
    route_status = Column(Text, nullable=False)  # ok | none (no GPS) | error
    fetched_at = Column(DateTime, default=datetime.utcnow)


class Activity(Base):
    """One real-world workout session (strength · swim · run · …) on a date.

    The spine of the workout domain: manual exercise rows (workouts.activity_id)
    and the Google session (google_session_id) both hang off it. Deliberately
    thin — Google metrics stay on workout_sessions and join at read time; no
    stored source (derivable from the links) and no stored category (a function
    of `activity`). Created ONLY by services/activity_service.py."""
    __tablename__ = "activities"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Text, nullable=False, index=True)            # YYYY-MM-DD (Helm canonical)
    activity = Column(Text, nullable=False)                    # strength|swim|run|bike|row|elliptical|hike|stairs|cardio
    label = Column(Text, nullable=True)                        # display name (e.g. Google "Pool swim"); None → title-cased activity
    google_session_id = Column(Integer, ForeignKey("workout_sessions.id", ondelete="SET NULL"),
                               unique=True, nullable=True, index=True)  # link decided once, never re-matched
    finalized = Column(Boolean, nullable=False, server_default="0")  # confirmed by the user (logged or locked in)
    # Row-less cardio (2026-07-16): manual cardio metrics live HERE, not on
    # carrier workout rows. Google metrics still join from workout_sessions;
    # at read time Google duration wins, manual distance wins (runs excepted).
    laps = Column(Integer, nullable=True)          # pool laps
    distance_m = Column(Float, nullable=True)      # manual distance (meters)
    duration_min = Column(Float, nullable=True)    # manual duration (minutes)
    notes = Column(Text, nullable=True)            # activity-level notes
    created_at = Column(DateTime, default=datetime.utcnow)
