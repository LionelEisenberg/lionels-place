# Job Search Section — Multi-Phase Plan

## Overview
Adding job search tracking features to Helm: Applications, Companies, Leetcode, and a general-purpose Tasks board.

---

## Current Architecture (as-built)

### Sidebar Nav
```
Home (/)
Health (collapsible)
  ├─ Meals       /meals
  ├─ Workouts    /workouts
  ├─ Helm   /daily
  └─ Goals       /goals
Job Search (collapsible)
  ├─ Applications  /jobs/applications   ← stub page
  ├─ Companies     /jobs/companies      ← BUILT
  └─ Leetcode      /jobs/leetcode       ← stub page
Tasks (top-level, not nested)  /tasks
```

### Backend Routes (job search specific)
| Route prefix | File | Notes |
|---|---|---|
| `/api/tasks` | `routers/tasks.py` | CRUD + `/move` + `/chat` |
| `/api/companies` | `routers/companies.py` | CRUD + `/research` + `/chat` + `/chat/history` |

### Backend Services (job search specific)
| File | Purpose |
|---|---|
| `services/company_research_service.py` | Isolated Gemini client — company research (JSON) + advisor chat |

### Models (job search specific)
| Model | Key fields |
|---|---|
| `Task` | title, category, status (`todo/in_progress/done`), priority, due_date, position (float, drag order) |
| `Company` | name, tier, location, notes, role_types, careers_url, website_url, market_info (JSON str), market_info_updated_at |
| `ChatMessage` | role, content, `context` (`advisor` \| `companies`) — scoped history |

### Schemas (job search specific)
- `TaskCreate/Update/MoveRequest/Response`, `TaskAdvisorChatRequest/Response`
- `CompanyTier` (Literal), `CompanyCreate/Update/Response`
- `CompanyResearch` (12-field structured research model)
- `CompanyResearchResponse`, `CompanyAdvisorChatRequest/Response`

### Frontend Pages
| File | Status |
|---|---|
| `pages/jobs/Companies.tsx` | Built — full implementation |
| `pages/jobs/Tasks.tsx` | Built — full implementation (top-level nav) |
| `pages/jobs/Applications.tsx` | Stub placeholder |
| `pages/jobs/Leetcode.tsx` | Stub placeholder |

---

## Phase A: Tasks (Kanban Board) — COMPLETE

General-purpose Kanban task board with category-colored cards, drag-and-drop, AI advisor chat.

### What Was Built
- **Backend:** `Task` model with float `position` for ordering; CRUD + `/move` endpoint; AI chat at `/tasks/chat` with `[CREATE_TASK: title="...", category="...", priority="...", due_date="..."]` markers; auto-manages `completed_at`
- **Frontend:** 3-column Kanban (Todo / In Progress / Done), collapsible Done column, category filter chips (derived from task data — no duplicate pills), task modal, DragOverlay ghost, Task Advisor collapsible section at bottom
- **DnD:** `@dnd-kit/core` + `@dnd-kit/sortable`; custom `kanbanCollision` detector (pointerWithin + rectIntersection, filters self-collision); `useDroppable` on each column; `PointerSensor` + `TouchSensor`
- **Nav:** Tasks is its own top-level nav item, not nested under Job Search

---

## Phase B + 2.5: Companies Page — COMPLETE

### What Was Built
Tiered target company list with inline editing, AI-powered structured research, and a dedicated advisor chat.

### Key Decisions
- **Tiers:** `gaming_t1`, `gaming_t2`, `tech_t1`, `tech_t2`, `adjacent` (Tech T3 job boards/sources excluded from companies list)
- **Layout:** Table view grouped by tier with expandable inline detail rows; click row to expand
- **Seed data:** 67 companies auto-seeded from job search plan on first startup (checked in `init_db`)
- **Inline editing:** Module-level `EditInput` component (WorkoutLog pattern); save on Enter, cancel on Escape
- **Tier colors:** gaming_t1=indigo, gaming_t2=violet, tech_t1=emerald, tech_t2=sky, adjacent=amber

### AI Research
- **Isolated service:** `company_research_service.py` is fully independent — own Gemini client, own system prompts, zero shared code with `advisor_service.py` (no health/fitness bleed)
- **Structured output:** `CompanyResearch` Pydantic model with 12 fields stored as JSON string in `market_info` column; parsed on read in frontend
- **Fields:** summary, company_size, engineering_size, funding_stage, tech_stack, culture_notes, recent_layoffs, glassdoor_rating, hiring_signals, recent_news, stock_performance, careers_page_url, last_updated

### Research Panel Design
Data terminal aesthetic — no bullet points:
- Each field is a labeled cell with subtle border/background (`rp-cell`)
- Tech stack: monospace `rp-chip--code` tokens (indigo tint, JetBrains Mono)
- Culture notes: pill chips (`rp-chip`)
- Hiring signal: semantic color — green cell if active hiring, amber if freeze/layoff
- Skeleton loader matches 3-col grid layout
- "Refreshed N days ago" timestamp (uses `datetime.now()` — not `utcnow()` to avoid JS offset bug)

### Company Advisor Chat
- Isolated system prompt — job search strategy only, no health context
- Action markers parsed from response: `[ADD_COMPANY: name="...", tier="...", ...]`, `[UPDATE_COMPANY: id=5, ...]`, `[REMOVE_COMPANY: id=5]`
- Chat history persisted in `ChatMessage` table with `context='companies'`
- Lazy-loads history on first open (up to 50 messages)
- Advisor panel positioned **above** the table (top of page)
- On add/update/remove: frontend re-fetches company list automatically

---

## Phase C: Applications Page — NEXT

Track the full job application lifecycle per company.

### Planned Features
- Link each application to a Company (FK or name reference)
- Application status: `researching → applied → phone_screen → technical → final → offer → rejected → withdrawn`
- Timestamped event log per application (status changes, notes)
- Recruiter name, job posting URL
- Summary stats: total applied, in-flight, response rate
- Stub page `Applications.tsx` already exists

### Open Questions
- Is this a new `Application` model or just extended state on `Company`? (Separate model recommended — a company can have multiple applications over time)
- Should old closed applications be archived or hard deleted?

---

## Phase D: Leetcode Tracker — PLANNED

NeetCode 150 progress tracking, pattern-based, weekly topic breakdown.

### Planned Features
- Problem list seeded from NeetCode 150
- Status per problem: `todo → attempted → solved`
- Pattern tags (sliding window, two pointers, dp, etc.)
- Weekly focus topic + completion rate
- Stub page `Leetcode.tsx` already exists
