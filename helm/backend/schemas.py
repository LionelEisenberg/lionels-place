"""
Pydantic schemas for request/response validation.
Covers CRUD operations, the chat-first parse flow, and export formats.
"""

from __future__ import annotations
from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field

# ==========================================
# Enum-like Literals (from Gem instructions)
# ==========================================

EquipmentType = str

MuscleGroup = Literal[
    "Triceps", "Biceps", "Chest", "Lats", "Delts", "Quads",
    "Hamstrings", "Glutes", "Core", "Adductors", "Full Body",
    "Forearms / Grip", "Traps", "Lower Back", "Cardio", "Calves",
    "Abductors", "Rhomboids",
]


# ==========================================
# Meal Schemas
# ==========================================

class MealCreate(BaseModel):
    date: str
    meal: str
    description: str
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float = 0.0

class MealUpdate(BaseModel):
    date: Optional[str] = None
    meal: Optional[str] = None
    description: Optional[str] = None
    calories: Optional[float] = None
    protein_g: Optional[float] = None
    carbs_g: Optional[float] = None
    fat_g: Optional[float] = None
    fiber_g: Optional[float] = None

class MealItemResponse(BaseModel):
    id: int
    name: str
    quantity: str
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    confidence: float | None = None
    confidence_reason: str | None = None

    class Config:
        from_attributes = True

class MealResponse(BaseModel):
    id: int
    date: str
    meal: str
    description: str
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    confidence: float | None = None
    items: list[MealItemResponse] = []

    class Config:
        from_attributes = True


# ==========================================
# Quick Add Schemas
# ==========================================

class QuickAddItem(BaseModel):
    """A chip in the Quick Add panel — either popular or pinned."""
    name: str
    quantity: str
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    frequency: int | None = None    # count in window (popular); null for pinned
    is_pinned: bool = False
    pin_id: int | None = None

class QuickAddData(BaseModel):
    """Response shape for GET /api/meals/quick-add."""
    pinned: list[QuickAddItem]
    popular: list[QuickAddItem]
    window_days: int

class QuickAddPinRequest(BaseModel):
    """Body for POST /api/meals/quick-add/pins."""
    name: str
    quantity: str

class QuickAddLogRequest(BaseModel):
    """Body for POST /api/meals/quick-add/log."""
    meal_type: Literal["Breakfast", "Lunch", "Dinner", "Snack"]
    items: list[MealItemData]
    date: str | None = None


# ==========================================
# Workout Schemas
# ==========================================

class WorkoutCreate(BaseModel):
    date: str
    category: Literal["Upper Body", "Lower Body", "Core", "Cardio"]
    equipment_type: str
    exercise: str
    weight_lbs: str               # "30, 35, 35"
    reps_sets: str                # "8, 8, 9"
    notes: str = ""
    targeted_muscle_group: str
    # Per-activity edit flow: attach the row to THIS existing activity instead of
    # the keyword heuristic. Must belong to the same date. None = heuristic.
    activity_id: Optional[int] = None

class WorkoutUpdate(BaseModel):
    date: Optional[str] = None
    category: Optional[Literal["Upper Body", "Lower Body", "Core", "Cardio"]] = None
    equipment_type: Optional[str] = None
    exercise: Optional[str] = None
    weight_lbs: Optional[str] = None
    reps_sets: Optional[str] = None
    notes: Optional[str] = None
    targeted_muscle_group: Optional[str] = None

class ActivityUpdate(BaseModel):
    """Structured cardio edit — the activity's own metadata columns.
    All optional; explicit null clears a value (exclude_unset semantics)."""
    label: Optional[str] = None
    laps: Optional[int] = None
    distance_m: Optional[float] = None
    duration_min: Optional[float] = None
    notes: Optional[str] = None

class WorkoutResponse(BaseModel):
    id: int
    date: str
    category: Literal["Upper Body", "Lower Body", "Core", "Cardio"]
    equipment_type: str
    exercise: str
    weight_lbs: str
    reps_sets: str
    notes: str
    targeted_muscle_group: str

    class Config:
        from_attributes = True


class ActivityResponse(BaseModel):
    """One activity (strength · swim · run · …) on a day — the log's card unit.
    id is the real activities-table PK."""
    id: int
    label: str
    category: str                 # strength | cardio — derived from activity
    activity: str
    google_session_id: Optional[int] = None
    start: Optional[str] = None
    end: Optional[str] = None
    duration_min: Optional[float] = None
    avg_hr: Optional[int] = None
    laps: Optional[int] = None
    distance_m: Optional[float] = None
    pace_s_per_km: Optional[float] = None
    calories_kcal: Optional[float] = None
    credited_kcal: Optional[float] = None      # 70% of calories_kcal — the active burn credited to the day
    elevation_gain_m: Optional[float] = None
    avg_cadence_spm: Optional[int] = None
    has_route: bool = False
    notes: Optional[str] = None   # activity-level notes (row-less cardio)
    exercises: list[WorkoutResponse]

    class Config:
        from_attributes = True


LogSessionResponse = ActivityResponse   # transitional alias


class DayLogResponse(BaseModel):
    date: str
    day_type: Optional[str] = None
    exercise_count: int = 0
    total_sets: int = 0
    total_volume: float = 0.0
    is_cardio: bool = False
    sessions: list[ActivityResponse]


class PendingGoogleSession(BaseModel):
    """A watch-detected session not yet locked into the log (banner card).
    Carries the full metric set the watch captured so the card can render
    activity-specific stats (distance/pace/elevation for runs, etc.)."""
    activity_id: int
    date: str
    activity: str
    label: str
    start: Optional[str] = None
    end: Optional[str] = None
    duration_min: Optional[float] = None
    distance_m: Optional[float] = None
    calories_kcal: Optional[float] = None
    credited_kcal: Optional[float] = None      # 70% of calories_kcal — the active burn credited on finalize
    avg_hr: Optional[int] = None
    pace_s_per_km: Optional[float] = None
    elevation_gain_m: Optional[float] = None
    avg_cadence_spm: Optional[int] = None


class FinalizeActivityRequest(BaseModel):
    """Lock a Google-detected activity into the log, optionally with parsed exercises."""
    exercises: list[ExerciseEntryData] = Field(default_factory=list)


class RunSplit(BaseModel):
    distance_m: float
    seconds: float
    avg_hr: Optional[int] = None
    marker: Optional[list[float]] = None    # [lat, lng] at the km crossing


class RunDetailResponse(BaseModel):
    session_id: int
    route: Optional[list[list[float]]] = None
    splits: Optional[list[RunSplit]] = None
    route_status: str


class SessionHistoryRow(BaseModel):
    date: str
    duration_min: Optional[float] = None
    avg_hr: Optional[int] = None
    max_hr: Optional[int] = None
    laps: Optional[int] = None
    distance_m: Optional[float] = None
    pace_s_per_km: Optional[float] = None
    notes: Optional[str] = None


class ProgressionSession(BaseModel):
    date: str
    weight_lbs: str
    reps_sets: str
    notes: str
    max_weight: float   # parsed server-side from weight_lbs
    body_weight: float | None = None  # user's bodyweight that day (from daily_summaries)


class ExerciseProgressionResponse(BaseModel):
    exercise: str
    equipment_type: str
    sessions: list[ProgressionSession]


# ==========================================
# Daily Summary Schemas
# ==========================================

class DailySummaryUpdate(BaseModel):
    weight_lbs: Optional[float] = None
    bf_pct: Optional[float] = None
    workout_type: Optional[Literal["Push", "Pull", "Legs", "Cardio", "Mixed"]] = None
    est_active_burn: Optional[float] = None
    sedentary_tdee: Optional[float] = None
    drinks_consumed: Optional[float] = None
    habit_qty: Optional[float] = None
    caffeine_mg: Optional[float] = None
    sleep_bedtime: Optional[str] = None
    sleep_waketime: Optional[str] = None
    sleep_hours: Optional[float] = None
    mood: Optional[str] = None
    notes: Optional[str] = None
    habit_workout: Optional[bool] = None
    habit_clean: Optional[bool] = None
    habit_productivity: Optional[bool] = None
    habit_sleep: Optional[bool] = None
    habit_love: Optional[bool] = None
    habit_custom: Optional[bool] = None

class DailySummaryResponse(BaseModel):
    id: int
    date: str
    day_of_week: Optional[str]
    workout_type: Optional[str]
    weight_lbs: Optional[float]
    bf_pct: Optional[float]
    calories_in: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    est_active_burn: float
    sedentary_tdee: float
    formula_tdee: Optional[float] = None
    cico_tdee: Optional[float] = None
    net_deficit: float
    drinks_consumed: Optional[float]
    habit_qty: Optional[float]
    caffeine_mg: Optional[float]
    sleep_bedtime: Optional[str] = None
    sleep_waketime: Optional[str] = None
    sleep_hours: Optional[float] = None
    mood: Optional[str]
    notes: str
    habit_workout: bool = False
    habit_clean: bool = False
    habit_productivity: bool = False
    habit_sleep: bool = False
    habit_love: bool = False
    habit_custom: bool = False

    class Config:
        from_attributes = True


# ==========================================
# Chat-First Parse Flow Schemas
# ==========================================

class ParseRequest(BaseModel):
    """User's natural language input for parsing."""
    message: str
    date: Optional[str] = None    # Override date (defaults to today)
    image_base64: Optional[str] = None  # Base64-encoded meal photo for vision parsing

class ContinueRequest(BaseModel):
    """Continue building on staged intents (e.g. 'now add fries')."""
    message: str
    pending_intents: list[ParsedIntent] = []

# ==========================================
# Auth
# ==========================================

class LoginRequest(BaseModel):
    username: str
    password: str

class UserResponse(BaseModel):
    username: str
    role: str

    class Config:
        from_attributes = True

class LoginResponse(BaseModel):
    token: str
    user: UserResponse

class MeResponse(BaseModel):
    username: str
    role: str
    token: Optional[str] = None  # Present when silent refresh occurs


class MealItemData(BaseModel):
    name: str = Field(description="Name of the food item or dish")
    quantity: str = Field(description="Quantity, e.g., '1 bowl', '3 oz', '100g'")
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float = 0.0
    confidence: Optional[float] = Field(default=0.7, ge=0.0, le=1.0)
    confidence_reason: Optional[str] = Field(default="estimated_portion")

class MealIntentData(BaseModel):
    """Structured meal data parsed from natural language."""
    meal: str = ""                 # Breakfast, Lunch, Dinner, Snack, etc.
    description: str
    calories: float = 0.0
    protein_g: float = 0.0
    carbs_g: float = 0.0
    fat_g: float = 0.0
    fiber_g: float = 0.0
    resolved_from: Optional[str] = None   # "3/7/26 Breakfast" if "same as"
    items: list[MealItemData] = Field(default_factory=list)

class ExerciseEntryData(BaseModel):
    """A single exercise within a workout."""
    exercise: str
    category: Literal["Upper Body", "Lower Body", "Core", "Cardio"]
    equipment_type: str                    # Dumbbell, Barbell, Machine, etc.
    weight_lbs: Optional[str] = ""        # "30, 35, 35" — Gemini may return null for bodyweight
    reps_sets: Optional[str] = ""         # "8, 8, 9"
    notes: Optional[str] = None
    targeted_muscle_group: str

class WorkoutIntentData(BaseModel):
    """One real-world activity parsed from natural language (strength, a swim, …)."""
    activity: str = ""                     # canonical: strength|swim|run|bike|row|elliptical|hike|stairs|cardio
                                           # "" (or any non-canonical value) → commit falls back to the per-row heuristic
    label: Optional[str] = None            # display, e.g. "Pool swim"; defaults to activity.title()
    exercises: list[ExerciseEntryData]
    session_notes: Optional[str] = None

class WeightIntentData(BaseModel):
    """Weight entry parsed from natural language."""
    weight_lbs: float

class HabitIntentData(BaseModel):
    """Custom-habit quantity parsed from natural language. Can be negative for subtraction."""
    amount: float

class CaffeineIntentData(BaseModel):
    """Caffeine intake parsed from natural language (beverages, supplements, etc.)."""
    amount_mg: float

class MoodIntentData(BaseModel):
    """Daily mood parsed from natural language."""
    mood: str

class NoteIntentData(BaseModel):
    """Free-form note parsed from natural language."""
    note: str

class SleepIntentData(BaseModel):
    """Sleep data parsed from natural language."""
    bedtime: Optional[str] = None    # "23:00" (24h format)
    waketime: Optional[str] = None   # "06:30" (24h format)
    hours: float                      # Always present — direct or calculated

class ParsedIntent(BaseModel):
    """A single typed intent extracted from natural language input."""
    type: Literal["meal", "workout", "weight", "habit", "caffeine", "mood", "note", "sleep"]
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    source_text: str = ""
    date: Optional[str] = None             # Override date for this intent
    # Exactly one of these will be populated based on type
    meal_data: Optional[MealIntentData] = None
    workout_data: Optional[WorkoutIntentData] = None
    weight_data: Optional[WeightIntentData] = None
    habit_data: Optional[HabitIntentData] = None
    caffeine_data: Optional[CaffeineIntentData] = None
    mood_data: Optional[MoodIntentData] = None
    note_data: Optional[NoteIntentData] = None
    sleep_data: Optional[SleepIntentData] = None

class ParseResponse(BaseModel):
    """Response from /api/parse — multiple intents from one message."""
    intents: list[ParsedIntent] = []
    advice_response: Optional[str] = None  # If the message was a question, AI answer here
    request_log_id: Optional[str] = None

class CommitRequest(BaseModel):
    """User-confirmed intents to persist to the database."""
    date: str                              # Date to associate entries with
    intents: list[ParsedIntent]
    request_log_id: Optional[str] = None

class CommitResponse(BaseModel):
    """Result of committing intents to the database."""
    meals_created: int = 0
    workouts_created: int = 0
    weight_updated: bool = False
    habit_updated: bool = False
    caffeine_updated: bool = False
    mood_updated: bool = False
    notes_added: bool = False
    sleep_updated: bool = False
    daily_totals: Optional[DailySummaryResponse] = None


# ==========================================
# Advisor Schemas
# ==========================================

class AdvisorChatRequest(BaseModel):
    message: str

class AdvisorChatResponse(BaseModel):
    response: str


# ==========================================
# Async Job Schemas
# ==========================================

class AsyncJobSubmitResponse(BaseModel):
    job_id: str

class AsyncJobStatusResponse(BaseModel):
    job_id: str
    status: str  # pending, processing, completed, failed
    result: Optional[dict] = None
    error: Optional[str] = None


class LLMJobEnqueueRequest(BaseModel):
    context: str
    task_type: str
    request_payload: dict
    provider: Optional[str] = None
    model: Optional[str] = None
    effort: Optional[str] = None
    json_requested: bool = False
    idempotency_key: Optional[str] = None


class LLMJobResponse(BaseModel):
    job_id: str
    context: str
    task_type: str
    status: str
    provider: Optional[str] = None
    model: Optional[str] = None
    response_text: Optional[str] = None
    response_payload: Optional[dict] = None
    error: Optional[str] = None            # most recent error, if any
    attempt_count: int
    total_tokens: Optional[int] = None
    latency_ms: Optional[int] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None
    consumed_at: Optional[str] = None


class LLMJobListResponse(BaseModel):
    jobs: list[LLMJobResponse]


class LLMJobClaimResponse(BaseModel):
    job_id: str
    context: str
    task_type: str
    provider: Optional[str] = None
    model: Optional[str] = None
    effort: Optional[str] = None
    json_requested: bool
    request_payload: dict
    attempt_count: int


class LLMJobResultRequest(BaseModel):
    response_text: Optional[str] = None
    response_payload: Optional[dict] = None
    model: Optional[str] = None
    effort: Optional[str] = None
    prompt_tokens: int = 0
    response_tokens: int = 0
    total_tokens: int = 0
    latency_ms: int = 0
    estimated_cost: float = 0.0
    json_valid: Optional[bool] = None


class LLMJobFailRequest(BaseModel):
    error: str


class WorkoutPlanRequest(BaseModel):
    """Request to plan the next workout."""
    day_type: Optional[str] = None  # Push, Pull, Legs — auto-detected if not provided
    notes: str = ""                # "feeling tired", "skip swim", etc.

class WorkoutPlanExercise(BaseModel):
    name: str
    warm_up: Optional[str] = None          # e.g. "2x10 @ 40 lbs"
    sets: list[str]                        # e.g. ["*8", "*8", "*7"]
    weights: list[str]                     # per-set or single value
    previous_date: Optional[str] = None
    previous_weight: Optional[str] = None
    previous_reps: Optional[str] = None
    overload_note: str = ""

class WorkoutPlanSessionNotes(BaseModel):
    duration: str = ""
    cardio: str = ""
    caveats: str = ""

class WorkoutPlanResponse(BaseModel):
    workout_type: str
    date_label: str
    exercises: list[WorkoutPlanExercise]
    session_notes: WorkoutPlanSessionNotes


# ==========================================
# Running Totals
# ==========================================

class RunningTotalsResponse(BaseModel):
    date: str
    calories_in: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    protein_target: float         # From config (default 125)
    protein_pct: float            # protein_g / target * 100
    carbs_target: float
    fat_target: float
    fiber_target: float
    calorie_target: float
    weight_lbs: Optional[float]
    sleep_hours: Optional[float] = None
    meal_count: int
    # Phase context (null when no phase covers today)
    phase_type: Optional[str] = None
    phase_day: Optional[int] = None
    phase_total_days: Optional[int] = None
    in_refeed: bool = False
    refeed_day: Optional[int] = None
    refeed_total_days: Optional[int] = None

# ==========================================
# Progress Photo Schemas
# ==========================================

class ProgressPhotoResponse(BaseModel):
    id: int
    date: str
    filename: str
    created_at: datetime

    class Config:
        from_attributes = True


class DashboardStatsResponse(BaseModel):
    meal_streak: int
    workout_streak: int
    weekly_push: int
    weekly_pull: int
    weekly_legs: int
    weekly_workouts_total: int
    weekly_deficit: float
    avg_weight_7d: Optional[float]
    today_workout_target: Optional[str]
    # New — KPI sparklines
    weight_sparkline: list[Optional[float]] = []
    deficit_sparkline: list[float] = []
    sleep_sparkline: list[Optional[float]] = []
    # New — KPI detail fields
    current_weight: Optional[float] = None
    weight_goal: Optional[float] = None
    weight_lost_total: Optional[float] = None
    weight_remaining: Optional[float] = None
    tdee_cico: Optional[float] = None
    tdee_sedentary: Optional[float] = None
    sleep_avg_7d: Optional[float] = None
    sleep_bedtime: Optional[str] = None
    sleep_waketime: Optional[str] = None
    deficit_lbs_weekly: Optional[float] = None
    # Google Health vitals (KPI cards)
    resting_hr: Optional[int] = None
    resting_hr_avg_7d: Optional[float] = None
    rhr_sparkline: list[Optional[int]] = []
    hrv_ms: Optional[float] = None
    hrv_avg_7d: Optional[float] = None
    hrv_sparkline: list[Optional[float]] = []


class TDEEInfoResponse(BaseModel):
    tdee: float
    source: Literal["formula", "cico"]
    formula_tdee: Optional[float] = None
    cico_tdee: Optional[float] = None
    n_days: int
    is_stable: bool
    confidence: float


# ==========================================
# Task Schemas (Kanban board)
# ==========================================

class TaskCreate(BaseModel):
    title: str
    category: str = "Personal"
    status: Literal["todo", "in_progress", "done"] = "todo"
    priority: Optional[Literal["high", "medium", "low"]] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None
    position: float = 1000.0

class TaskUpdate(BaseModel):
    title: Optional[str] = None
    category: Optional[str] = None
    priority: Optional[Literal["high", "medium", "low"]] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None

class TaskMoveRequest(BaseModel):
    status: Literal["todo", "in_progress", "done"]
    position: float

class TaskResponse(BaseModel):
    id: int
    title: str
    category: str
    status: str
    priority: Optional[str]
    due_date: Optional[str]
    notes: Optional[str]
    position: float
    created_at: datetime
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True

class OverdueTaskResponse(BaseModel):
    id: int
    title: str
    category: str
    due_date: Optional[str] = None
    days_overdue: int
    priority: Optional[str] = None

class TaskAdvisorChatRequest(BaseModel):
    message: str

class TaskAdvisorChatResponse(BaseModel):
    response: str
    created_tasks: list[TaskResponse] = []


# ==========================================
# Company Schemas (Job Search)
# ==========================================

CompanyTier = Literal["gaming_t1", "gaming_t2", "tech_t1", "tech_t2", "adjacent"]

class CompanyCreate(BaseModel):
    name: str
    tier: CompanyTier
    location: Optional[str] = None
    notes: Optional[str] = None
    role_types: Optional[str] = None
    careers_url: Optional[str] = None
    website_url: Optional[str] = None

class CompanyUpdate(BaseModel):
    name: Optional[str] = None
    tier: Optional[CompanyTier] = None
    location: Optional[str] = None
    notes: Optional[str] = None
    role_types: Optional[str] = None
    careers_url: Optional[str] = None
    website_url: Optional[str] = None
    market_info: Optional[str] = None

class CompanyResponse(BaseModel):
    id: int
    name: str
    tier: str
    location: Optional[str]
    notes: Optional[str]
    role_types: Optional[str]
    careers_url: Optional[str]
    website_url: Optional[str]
    market_info: Optional[str]
    market_info_updated_at: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True

class CompanyResearch(BaseModel):
    """Structured research data returned by the isolated company research service."""
    summary: str = ""
    company_size: Optional[str] = None
    engineering_size: Optional[str] = None
    funding_stage: Optional[str] = None
    tech_stack: Optional[list[str]] = None
    culture_notes: Optional[list[str]] = None
    recent_layoffs: Optional[str] = None
    glassdoor_rating: Optional[str] = None
    hiring_signals: Optional[str] = None
    recent_news: Optional[str] = None
    stock_performance: Optional[str] = None
    careers_page_url: Optional[str] = None
    last_updated: str = ""

class CompanyResearchResponse(BaseModel):
    company: CompanyResponse
    research: CompanyResearch

class CompanyAdvisorChatRequest(BaseModel):
    message: str

class CompanyAdvisorChatResponse(BaseModel):
    response: str
    added_companies: list[CompanyResponse] = []
    updated_companies: list[CompanyResponse] = []
    removed_company_ids: list[int] = []


# ==========================================
# Application Schemas (Job Search)
# ==========================================

ApplicationStatus = Literal[
    "researching", "applied", "phone_screen", "technical",
    "final", "offer", "rejected", "withdrawn",
]

CLOSED_STATUSES = {"rejected", "withdrawn", "offer"}


class ApplicationCreate(BaseModel):
    company_id: Optional[int] = None
    company_name: str
    job_title: str
    status: ApplicationStatus = "researching"
    salary_range: Optional[str] = None
    recruiter_name: Optional[str] = None
    posting_url: Optional[str] = None
    notes: Optional[str] = None


class ApplicationUpdate(BaseModel):
    company_name: Optional[str] = None
    job_title: Optional[str] = None
    status: Optional[ApplicationStatus] = None
    salary_range: Optional[str] = None
    recruiter_name: Optional[str] = None
    posting_url: Optional[str] = None
    notes: Optional[str] = None


class ApplicationEventResponse(BaseModel):
    id: int
    status: str
    note: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class ApplicationResponse(BaseModel):
    id: int
    company_id: Optional[int]
    company_name: str
    job_title: str
    status: str
    salary_range: Optional[str]
    recruiter_name: Optional[str]
    posting_url: Optional[str]
    notes: Optional[str]
    applied_date: Optional[str]
    created_at: datetime
    updated_at: Optional[datetime]
    events: list[ApplicationEventResponse] = []

    class Config:
        from_attributes = True


class ApplicationStatsResponse(BaseModel):
    total: int
    active: int
    by_status: dict[str, int]
    response_rate: float


class ApplicationAdvisorChatRequest(BaseModel):
    message: str


class ApplicationAdvisorChatResponse(BaseModel):
    response: str
    created_applications: list[ApplicationResponse] = []
    updated_applications: list[ApplicationResponse] = []


# ==========================================
# Leetcode Schemas
# ==========================================

LeetcodeDifficulty = Literal["Easy", "Medium", "Hard"]
LeetcodeStatus = Literal["todo", "attempted", "solved"]


class LeetcodeProblemCreate(BaseModel):
    name: str
    number: Optional[int] = None
    url: Optional[str] = None
    category: str
    difficulty: LeetcodeDifficulty
    status: LeetcodeStatus = "todo"
    solved_without_help: bool = False
    notes: Optional[str] = None
    neetcode_order: Optional[int] = None


class LeetcodeProblemUpdate(BaseModel):
    name: Optional[str] = None
    number: Optional[int] = None
    url: Optional[str] = None
    category: Optional[str] = None
    difficulty: Optional[LeetcodeDifficulty] = None
    status: Optional[LeetcodeStatus] = None
    solved_without_help: Optional[bool] = None
    notes: Optional[str] = None
    neetcode_order: Optional[int] = None


class LeetcodeProblemResponse(BaseModel):
    id: int
    name: str
    number: Optional[int]
    url: Optional[str]
    category: str
    difficulty: str
    status: str
    solved_without_help: bool
    notes: Optional[str]
    created_at: datetime
    solved_at: Optional[datetime]
    neetcode_order: Optional[int] = None

    class Config:
        from_attributes = True


class LeetcodeStatsResponse(BaseModel):
    total: int
    solved: int
    attempted: int
    solved_without_help: int
    by_category: dict[str, dict[str, int]]
    by_difficulty: dict[str, dict[str, int]]
    streak: int


class LeetcodeAdvisorChatRequest(BaseModel):
    message: str
    problem_id: Optional[int] = None


class LeetcodeAdvisorChatResponse(BaseModel):
    response: str
    created_problems: list[LeetcodeProblemResponse] = []


class UpNextRecommendation(BaseModel):
    problem: LeetcodeProblemResponse
    reason: str


class UpNextResponse(BaseModel):
    recommendations: list[UpNextRecommendation]


# ==========================================
# Schedule — Template Blocks
# ==========================================

class TemplateBlockCreate(BaseModel):
    name: str
    day_of_week: int  # 0-6
    start_time: str   # "HH:MM"
    end_time: str     # "HH:MM"
    category: Literal["workout", "meals", "leetcode", "job_search", "productivity", "personal"] = "personal"
    color: str = "indigo"

class TemplateBlockUpdate(BaseModel):
    name: Optional[str] = None
    day_of_week: Optional[int] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    category: Optional[Literal["workout", "meals", "leetcode", "job_search", "productivity", "personal"]] = None
    color: Optional[str] = None

class TemplateBlockResponse(BaseModel):
    id: int
    name: str
    day_of_week: int
    start_time: str
    end_time: str
    category: str
    color: str

    class Config:
        from_attributes = True


# ==========================================
# Schedule — Time Blocks
# ==========================================

class TimeBlockCreate(BaseModel):
    date: str          # "YYYY-MM-DD"
    name: str
    start_time: str    # "HH:MM"
    end_time: str      # "HH:MM"
    category: Literal["workout", "meals", "leetcode", "job_search", "productivity", "personal"] = "personal"
    color: str = "indigo"
    status: Literal["planned", "done", "skipped"] = "planned"
    task_id: Optional[int] = None
    template_block_id: Optional[int] = None
    notes: Optional[str] = None

class TimeBlockUpdate(BaseModel):
    name: Optional[str] = None
    date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    category: Optional[Literal["workout", "meals", "leetcode", "job_search", "productivity", "personal"]] = None
    color: Optional[str] = None
    status: Optional[Literal["planned", "done", "skipped"]] = None
    task_id: Optional[int] = None
    notes: Optional[str] = None

class TimeBlockResponse(BaseModel):
    id: int
    date: str
    name: str
    start_time: str
    end_time: str
    category: str
    color: str
    status: str
    task_id: Optional[int]
    template_block_id: Optional[int]
    notes: Optional[str]
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Auto-completion enrichment fields (not in DB)
    auto_status: Optional[str] = None        # "done" if auto-completed, else None
    auto_detail: Optional[str] = None        # e.g. "5 exercises logged", "650 cal"
    task_title: Optional[str] = None         # Resolved task name
    task_status: Optional[str] = None        # Resolved task kanban status

    class Config:
        from_attributes = True

class TemplateApplyRequest(BaseModel):
    week_start_date: str  # "YYYY-MM-DD" (Monday of target week)

class WeeklyReviewResponse(BaseModel):
    adherence_pct: float
    total_blocks: int
    done_blocks: int
    skipped_blocks: int
    planned_hours: float
    completed_hours: float
    by_category: dict[str, dict]  # { "workout": { "done": 2, "total": 3 }, ... }
    skipped_list: list[dict]      # [{ "date": "...", "name": "...", "duration_hrs": 1.5 }]
    trend: list[dict]             # [{ "week": "W10", "week_start": "...", "adherence_pct": 70 }]

# ==========================================
# Recipe Bank Schemas
# ==========================================

class RecipeIngredientCreate(BaseModel):
    name: str
    amount: Optional[float] = None
    unit: Optional[str] = None
    original_unit: Optional[str] = None
    category: Optional[str] = None
    exotic: bool = False
    sort_order: int = 0

class RecipeIngredientResponse(BaseModel):
    id: int
    name: str
    amount: Optional[float] = None
    unit: Optional[str] = None
    original_unit: Optional[str] = None
    category: Optional[str] = None
    exotic: bool = False
    sort_order: int

    class Config:
        from_attributes = True


class CookLogCreate(BaseModel):
    date: str
    guests: Optional[int] = None
    scale_factor: float = 1.0
    notes: Optional[str] = None
    rating: Optional[float] = Field(None, ge=0, le=10)
    rating_comment: Optional[str] = None

class CookLogUpdate(BaseModel):
    date: Optional[str] = None
    guests: Optional[int] = None
    scale_factor: Optional[float] = None
    notes: Optional[str] = None
    rating: Optional[float] = Field(None, ge=0, le=10)
    rating_comment: Optional[str] = None

class ReactionAggregate(BaseModel):
    emoji: str
    count: int
    users: list[str]

class CommentResponse(BaseModel):
    id: int
    text: str
    username: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class CookLogResponse(BaseModel):
    id: int
    recipe_id: int
    date: str
    guests: Optional[int] = None
    scale_factor: float
    notes: Optional[str] = None
    rating: Optional[float] = None
    rating_comment: Optional[str] = None
    cooked_by: Optional[str] = None
    photo_filenames: list[str] = []
    reactions: list[ReactionAggregate] = []
    comments: list[CommentResponse] = []
    recipe_name: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class FeedResponse(BaseModel):
    items: list[CookLogResponse]
    has_more: bool

class ReactionCreate(BaseModel):
    emoji: str

class CommentCreate(BaseModel):
    text: str


class RecipeCreate(BaseModel):
    name: str
    source_url: Optional[str] = None
    instructions: str
    notes: Optional[str] = None
    servings: Optional[int] = None
    feeds: Optional[int] = None
    prep_ahead: bool = False
    tags: Optional[str] = None
    ingredients: list[RecipeIngredientCreate] = []

class RecipeUpdate(BaseModel):
    name: Optional[str] = None
    source_url: Optional[str] = None
    instructions: Optional[str] = None
    notes: Optional[str] = None
    servings: Optional[int] = None
    feeds: Optional[int] = None
    prep_ahead: Optional[bool] = None
    tags: Optional[str] = None
    ingredients: Optional[list[RecipeIngredientCreate]] = None

class RecipeResponse(BaseModel):
    id: int
    name: str
    source_url: Optional[str] = None
    instructions: str
    notes: Optional[str] = None
    rating: Optional[float] = None
    servings: Optional[int] = None
    feeds: Optional[int] = None
    prep_ahead: bool
    tags: Optional[str] = None
    image_filename: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    added_by: Optional[str] = None
    ingredients: list[RecipeIngredientResponse] = []
    cook_logs: list[CookLogResponse] = []

    class Config:
        from_attributes = True

class RecipeListResponse(BaseModel):
    id: int
    name: str
    rating: Optional[float] = None
    tags: Optional[str] = None
    servings: Optional[int] = None
    feeds: Optional[int] = None
    prep_ahead: bool
    image_filename: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    added_by: Optional[str] = None
    cook_count: int = 0
    last_cooked: Optional[str] = None
    cook_photos: list[str] = []

    class Config:
        from_attributes = True

class ShoppingListItemCreate(BaseModel):
    name: str
    amount: Optional[float] = None
    unit: Optional[str] = None
    category: str = "Other"
    recipe_id: Optional[int] = None
    recipe_name: Optional[str] = None
    exotic: bool = False

class ShoppingListItemUpdate(BaseModel):
    name: Optional[str] = None
    amount: Optional[float] = None
    unit: Optional[str] = None
    category: Optional[str] = None
    checked: Optional[bool] = None

class ShoppingListItemResponse(BaseModel):
    id: int
    name: str
    amount: Optional[float]
    unit: Optional[str]
    category: str
    recipe_id: Optional[int]
    recipe_name: Optional[str]
    checked: bool
    exotic: bool
    sort_order: int
    created_at: datetime

    class Config:
        from_attributes = True


class ParseUrlRequest(BaseModel):
    url: str
    instructions: Optional[str] = None

class ParseTextRequest(BaseModel):
    text: str
    source_url: Optional[str] = None
    instructions: Optional[str] = None

class ScaledIngredientResponse(BaseModel):
    name: str
    amount: Optional[float] = None
    unit: Optional[str] = None
    original_unit: Optional[str] = None
    category: Optional[str] = None
    exotic: bool = False
    sort_order: int
    original_amount: Optional[float] = None


# ==========================================
# Phase Schemas
# ==========================================

class RefeedBase(BaseModel):
    start_date: str
    end_date: str
    target_calories: float
    target_protein_g: float
    target_carbs_g: float
    target_fat_g: float
    target_fiber_g: float
    notes: Optional[str] = None


class RefeedCreate(RefeedBase):
    pass


class RefeedUpdate(BaseModel):
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    target_calories: Optional[float] = None
    target_protein_g: Optional[float] = None
    target_carbs_g: Optional[float] = None
    target_fat_g: Optional[float] = None
    target_fiber_g: Optional[float] = None
    notes: Optional[str] = None


class RefeedResponse(RefeedBase):
    id: int
    phase_id: int

    class Config:
        from_attributes = True


class PhaseBase(BaseModel):
    phase_type: Literal["cut", "maintenance", "bulk"]
    start_date: str
    end_date: Optional[str] = None
    target_calories: float
    target_protein_g: float
    target_carbs_g: float
    target_fat_g: float
    target_fiber_g: float
    target_weight_lbs: Optional[float] = None
    notes: Optional[str] = None


class PhaseCreate(PhaseBase):
    pass


class PhaseUpdate(BaseModel):
    phase_type: Optional[Literal["cut", "maintenance", "bulk"]] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    target_calories: Optional[float] = None
    target_protein_g: Optional[float] = None
    target_carbs_g: Optional[float] = None
    target_fat_g: Optional[float] = None
    target_fiber_g: Optional[float] = None
    target_weight_lbs: Optional[float] = None
    notes: Optional[str] = None


class PhaseResponse(PhaseBase):
    id: int
    refeeds: list[RefeedResponse] = []

    class Config:
        from_attributes = True


class CurrentPhaseResponse(BaseModel):
    """Returned by GET /api/phases/current — phase + active refeed if any."""
    phase: Optional[PhaseResponse]
    active_refeed: Optional[RefeedResponse]
    day_of_phase: Optional[int]            # 1-based day index, null if no phase
    total_phase_days: Optional[int]        # null when phase has no end_date
    refeed_day: Optional[int]              # day index within active refeed, null otherwise
    refeed_total_days: Optional[int]


class WeightProjectionResponse(BaseModel):
    target_value: float
    current_value: Optional[float]
    starting_value: Optional[float]
    projected_date: Optional[str]
    pace_per_week: Optional[float]
    days_remaining: Optional[int]


# ==========================================
# Google Health OAuth Schemas
# ==========================================

class HealthConnectUrl(BaseModel):
    authorize_url: str


class HealthConnectionStatus(BaseModel):
    status: str
    last_sync_at: Optional[datetime] = None
    last_error: Optional[str] = None
    scopes: Optional[str] = None


class HealthSyncResult(BaseModel):
    status: str
    last_sync_at: Optional[datetime] = None
    steps_today: Optional[int] = None


# ==========================================
# Google Health — data
# ==========================================

class DailyHealthResponse(BaseModel):
    date: str
    steps: Optional[int] = None
    resting_hr: Optional[int] = None
    hrv_ms: Optional[float] = None
    respiratory_rate: Optional[float] = None
    sleep_deep_min: Optional[int] = None
    sleep_light_min: Optional[int] = None
    sleep_rem_min: Optional[int] = None
    sleep_awake_min: Optional[int] = None
    sleep_efficiency_pct: Optional[float] = None

    class Config:
        from_attributes = True


class IntradayPoint(BaseModel):
    t: str
    bpm: int


class IntradayHeartRateResponse(BaseModel):
    date: str
    points: list[IntradayPoint]
    min_bpm: Optional[int] = None
    avg_bpm: Optional[int] = None
    max_bpm: Optional[int] = None


class BackfillResult(BaseModel):
    status: str
    start_date: Optional[str] = None


class WorkoutSessionResponse(BaseModel):
    id: int
    google_id: Optional[str] = None
    date: str
    exercise_type: str
    exercise_type_raw: str
    category: str
    start_time: str
    end_time: str
    duration_min: Optional[float] = None
    distance_m: Optional[float] = None
    avg_hr: Optional[int] = None
    max_hr: Optional[int] = None
    source: str

    class Config:
        from_attributes = True


class SessionHeartRateResponse(BaseModel):
    session_id: int
    date: str
    points: list[IntradayPoint]
    min_bpm: Optional[int] = None
    avg_bpm: Optional[int] = None
    max_bpm: Optional[int] = None
    zones: Optional[dict[str, int]] = None   # personalized HR-zone floors: {fat_burn, cardio, peak}


# ==========================================
# Important Dates Schemas
# ==========================================

class ImportantDateResponse(BaseModel):
    name: str
    category: str
    emoji: str
    date: str          # ISO "YYYY-MM-DD" of the next occurrence
    days_until: int
