# Helm — Project Documentation

The **Helm** is a high-performance, AI-integrated health and fitness tracking system designed for Lionel. It combines natural language processing with strict tracking rules to provide a "zero-friction" logging experience.

## 🚀 Project Overview

The core philosophy of Helm is **input simplicity via AI**. Instead of tapping through endless menus to find a specific brand of bread, the user simply tells the app: *"For breakfast I had 2 slices of sourdough with half an avocado and a fried egg."*

The system then:
1.  **Parses** the intent using Google Gemini Pro.
2.  **Itemizes** the meal into individual components with estimated/retrieved macros.
3.  **Stages** the results for user review and manual adjustment.
4.  **Persists** the data to a structured relational database.

---

## 🛠️ Technology Stack

| Layer | Technology |
| :--- | :--- |
| **Backend** | Python 3.11, FastAPI, Pydantic |
| **Database** | SQLite, SQLAlchemy (ORM) |
| **Frontend** | React, TypeScript, Vite |
| **Style** | Vanilla CSS (Vibrant Dark Mode, Glassmorphism) |
| **AI** | Google Gemini (`google-genai` SDK) + Claude (`claude-agent-sdk`). Requests are enqueued onto a durable job queue and executed by a separate `llm-worker` container (Claude default, Gemini opt-in) — see `docs/llm_routing.md`. |
| **DevOps** | Docker, Docker Compose |

---

## 📂 Code Structure

### Backend (`/backend`)
- `app.py`: The entry point for the FastAPI application.
- `models.py`: SQLAlchemy database models (Meals, Workouts, Weights, Moods, etc.).
- `schemas.py`: Pydantic models for request validation and API responses.
- `database.py`: Configuration for the SQLite engine and session management.
- `auth.py`: JWT authentication middleware backed by Jellyfin (`JWTAuthMiddleware`). Role-based access — `admin` gets full Helm; `friend` is scoped to cooking routes (recipes + shopping list). Public route allowlist for the read-only recipe view.
- `dependencies.py`: Shared FastAPI `Depends()` helpers (`get_current_user` resolves a `User` from the JWT).
- `routers/`: Modular API endpoints grouped by feature: `parse.py`, `meals.py`, `workouts.py`, `daily.py`, `advisor.py`, `export.py`, `phases.py`, `recipes.py`, `schedule.py`, `photos.py`, `applications.py`, `companies.py`, `leetcode.py`, `tasks.py`, `shopping_list.py`, `async_jobs.py`, `settings.py`, `gemini_dashboard.py`.
- `services/`:
  - `base_llm.py`: `BaseLLMService` — builds LLM payloads and enqueues them onto the durable `llm_jobs` queue. See `docs/llm_routing.md`.
  - `job_queue.py`: Durable `llm_jobs` queue — enqueue/claim/result/retry with a lazy reaper and TTL prune; a separate `llm-worker` container executes jobs (Claude default, Gemini opt-in) and posts results back.
  - `settings_service.py`: Runtime LLM settings (provider, Claude effort) cached in memory.
  - `auth_service.py`: Jellyfin auth + JWT sign/verify.
  - `advisor_service.py`: Health/fitness advisor — meal parsing, chat, and workout planning.
  - `daily_calculator.py`: Computes daily summary totals from meals, infers workout types.
  - `tdee_service.py`: TDEE estimation (formula-based and CICO-derived).
  - `phase_service.py` + `projection.py`: Phase target resolution + weight projection math.
  - `quick_add_service.py`: Pinned + popular MealItem quick-add aggregations.
  - `recipe_parser.py` / `ingredient_classifier.py`: Recipe import + aisle classification.
  - `schedule_service.py`, `application_service.py`, `company_research_service.py`, `leetcode_service.py`, `task_advisor_service.py`: feature-specific LLM-backed services.
  - `import_service.py`: CSV import for data portability.
  - `calorie_estimator.py`, `confidence.py`, `thumbnail.py`: small utilities (MET-based calorie estimation, parse-confidence scoring, image thumbnailing).

### Frontend (`/frontend`)
- `src/api.ts`: Centralized API wrapper for all backend communication.
- `src/pages/Dashboard.tsx`: The primary "Command Center" containing the AI input and circular progress trackers.
- `src/pages/Helm.tsx`: Tabular view of historical data plus a charts section with per-chart statistics.
- `src/pages/MealLog.tsx`: Detailed meal history view.
- `src/pages/WorkoutLog.tsx`: Workout history and progressive overload tracking.
- `src/pages/Phases.tsx`: Phase timeline (cut/bulk/maintenance) with refeeds and weight projection chart. Replaces the old Goals page.
- `src/pages/RecipeBank.tsx`: Recipe library with photos, ratings, scaling, and tag filters. Also rendered read-only on `recipes.lionel.place`.
- `src/pages/Schedule.tsx`: Calendar-style time-blocking view.
- `src/pages/ShoppingList.tsx`: Grouped grocery list with aisle/recipe views and optimistic toggles.
- `src/pages/Activity.tsx`: Cook log feed (recent cooks across users with photos and ratings).
- `src/pages/Settings.tsx`: Admin-only LLM provider/effort/model settings.
- `src/pages/jobs/Applications.tsx`: Job application tracking.
- `src/pages/jobs/Companies.tsx`: Company research with AI-powered analysis.
- `src/pages/jobs/Leetcode.tsx`: NeetCode 150 problem tracker with study plan and difficulty progression.
- `src/pages/jobs/Tasks.tsx`: Job search task management.
- `src/index.css`: The "Design System" — a curated collection of CSS variables defining the aesthetic identity of the project.

---

## 🧗 Product Responsibilities

### 1. Intelligent Parsing
The system converts chaotic natural language into strict database records. This includes:
- **Meals**: Extracting ingredients, quantities, and macros.
- **Workouts**: Parsing shorthand formats like *"Bench Press - 185 - 8, 8, 7"*.
- **Metrics**: Body weight (`weight_lbs`), mood (1-5 scale), caffeine (mg), drinks, and a configurable custom habit quantity (`amount`).

### 2. Progressive Overload Tracking
For workouts, the system retrieves the user's *previous session* for a specific exercise and automatically generates a "Comparison Note" (e.g., *"Up 5 lbs from last time"*), allowing the user to track progress without manual lookup.

### 3. Nutrition Visualization
The dashboard features circular SVG progress bars for Calories, Protein, Net Carbs, Fat, and Fiber. Net carbs are displayed as `carbs_g - fiber_g` to avoid double-counting fiber in stacked visualizations.
- Over-target calories are highlighted in rose (red).
- Under-target macros are tracked against specific goals (e.g., 125g protein/day).

### 4. Daily Habits Heatmap
A GitHub-style heatmap tracks 6 daily habits, including workouts, sleep, and a user-configurable custom habit. Per-habit filter buttons let you see which specific days each habit was completed.

### 5. Chart Statistics
Each chart in the Helm charts view has a compact stat summary bar computed from all-time data:
- **Body Fat %**: Current, average, trend (%/week via linear regression).
- **Calories & Deficit**: Avg cal/day, avg deficit/day.
- **Cumulative Deficit**: Tracked deficit, scale deficit (weight change × 3500 cal/lb via trend line), tracking-to-scale ratio. Includes a "Scale (trend)" dashed line on the chart.
- **Mood**: Average mood, streak of days >= 4.
- **Custom habit/Caffeine/Drinks**: Average consumption, percentage of days under target.

The **Weight Trend** chart additionally has a togglable trend line — Overall (OLS regression across all weigh-ins, projects to goal), 7d (trailing 7-day SMA), or 14d (trailing 14-day SMA). The choice persists in `localStorage`. In 7d/14d modes the tooltip gains a "Δ vs N days ago" loss row, colored green for loss / rose for gain. SMA + loss math is pure and tested in `src/utils/weight-chart-helpers.ts`; per-mode UI metadata is centralised in `TREND_MODE_META` in `Helm.tsx`.

### 6. Advisor Chat
A persistent chat interface where the user can ask questions like *"How much fiber should I have if I feel bloated?"* or *"What was my best hack squat weight last month?"*.

### 7. Phase-Based Cut/Bulk Tracking
The Phases page replaces the old Goals concept. Users define overlapping phases (`cut`, `bulk`, `maintenance`) with target weight, daily calorie/protein targets, and date ranges. Each phase can contain `Refeed` periods with overridden calorie targets. The page renders a timeline-spine layout with phase bands, weight projection, refeed callouts, and "% met" progress chips. Phase context flows into the advisor prompts and the daily running totals.

### 8. Recipe Bank, Shopping List, and Cook Feed
- **Recipe Bank**: photos, ratings, scaling, tags, and ingredient parsing. Public read-only view served on `recipes.lionel.place`.
- **Shopping List**: grouped by aisle or recipe, with optimistic checkbox toggling and AI ingredient classification.
- **Activity (Cook Feed)**: recent cooks across users with photos and ratings.

### 9. Job Search Tracking
A sidebar-navigable section for managing the job search process:
- **Applications**: Track job applications with status, company, role, and dates.
- **Companies**: AI-powered company research with structured data panels.
- **Leetcode**: NeetCode 150 problem tracker with seeded problems, difficulty progression, "Up Next" recommendations, and a study plan view.
- **Tasks**: Task management for job search activities.

---

## 💡 Developer Information

### Running the Project
The project is fully containerized. To start or rebuild:
```powershell
docker compose up -d --build
```

### Prompt Engineering
The logic for how the AI behaves is located in `backend/services/advisor_service.py`. If you want to change how the AI itemizes food or handles workout shorthand, you must update the `SYSTEM_PROMPT` or `PARSE_INSTRUCTIONS` constants.

### Database Updates
When changing database models in `models.py`, ensure you also update `schemas.py` and potentially the `api.ts` frontend types to maintain parity.

### Styling
Avoid using utility frameworks. All styles are defined in `index.css` using modern CSS variables. Stick to the theme tokens (e.g., `var(--accent-indigo)`) to maintain the premium dark look.

### Database Backups
A daily cron job (`data/backups/backup-fitness-db.sh`) backs up `fitness.db` using SQLite's safe backup API via Docker exec. Rolling 7-day retention — old backups are pruned automatically.
