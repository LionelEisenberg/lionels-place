# LLM Routing

How Helm runs AI requests: a durable **job queue** consumed by a separate **`llm-worker`** container. Every LLM call is enqueued, executed out-of-process, and reconnectable from any view — fire a request on the Dashboard, navigate away, come back, and the result is waiting.

## Architecture

```
Service (AdvisorService, …)                     Frontend (Dashboard, Tasks, …)
    │ .parse_input() / .chat() / …                   │ useContextJobs(context)
    ▼                                                 │  polls GET /api/llm-jobs?context=…
BaseLLMService._enqueue()                             │  delivers each terminal job ONCE
    │ builds {system_prompt, prompt,                  ▲
    │         want_json, image_base64}                │
    ▼                                                 │
job_queue.enqueue()  ─────►  llm_jobs  (SQLite: queue + audit log, one row per request)
                                 ▲   │ claim (lease + heartbeat)
                                 │   ▼
                             llm-worker  (separate container — the ONLY executor)
                                 │  polls  POST /internal/llm-jobs/claim
                                 │  executes the job's provider:
                                 │     claude ─► claude_exec.run_claude   (claude-agent-sdk, Max sub)
                                 │     gemini ─► gemini_exec              (google-genai + worker-local quota)
                                 ▼
                             POST /internal/llm-jobs/{id}/result
                                 │  record_result → result_hooks.run_hook(context)
                                 ▼
                             job row terminal (succeeded / failed) → frontend poll delivers it
```

**One execution path.** There is no synchronous/in-process LLM call left. Services enqueue; the worker executes; results land back in `llm_jobs`. The one in-request consumer that still needs its answer inline — ingredient auto-categorization — uses `job_queue.enqueue_and_wait()`, which enqueues and blocks on the same worker (with an `'Other'` fallback on timeout), so it shares this exact path.

**Helm is the sole DB writer.** The worker never touches SQLite directly — it interacts only over HTTP through `/internal/llm-jobs/*`, authenticated with a shared `HELM_WORKER_SECRET` bearer token. This keeps all schema/ownership logic in one process.

## The queue (`llm_jobs`)

A single SQLite table is both the **work queue** and the **audit log** — no separate history table.

- **Lifecycle:** `queued → running → succeeded | failed`. `claim_next` atomically leases the oldest `queued` job (sets `running`, stamps a lease). The worker heartbeats while executing.
- **Lease reaper = retry:** `claim_next` lazily sweeps stale `running` jobs (lease expired, worker died mid-flight) back to `queued` up to a retry cap, then to `failed`. No external scheduler — the reaper runs inline on every claim.
- **TTL prune:** `claim_next` also lazily purges terminal rows older than the retention window (`purge_old`), keeping the table bounded without a cron.
- **Idempotency / reconnect:** each job carries a `context` (the page/view that owns it, e.g. `dashboard_parse`, `tasks_chat`) and an optional `context_key`. The frontend reconnects by querying open jobs for its `context`.
- **Audit fields:** provider, model, effort, prompt/response tokens, estimated cost, `json_requested`/`json_valid`, latency, error, and truncated input/output text — everything the old `gemini_request_log` tracked, now on the job row itself.

## Settings (runtime, no restart needed)

| Setting | Values | Default | Where |
|---------|--------|---------|-------|
| `llm_provider` | `claude`, `gemini` | `claude` | Admin Settings page or `helm/.env` (`LLM_PROVIDER`) |
| `llm_model` | provider model IDs | (Max-sub tier) | Admin Settings page or `helm/.env` (`LLM_MODEL`) |
| `llm_effort` | `low`, `medium`, `high`, `max` | `high` | Admin Settings page or `helm/.env` (`LLM_EFFORT`) |
| `llm_fallback` | `""`, `gemini`, `claude` | `""` (off) | Admin Settings page or `helm/.env` (`LLM_FALLBACK`) |

Settings live in the `helm_settings` DB table, cached in memory. The provider is stamped onto the job at enqueue time (`get_setting("llm_provider", "claude")`), so the worker executes whatever the job says. Env vars are fallback defaults when no DB value is set.

**Claude is the default provider.** Auto Claude→Gemini fallback is **off** by default (`llm_fallback=""`): if a Claude job fails, it fails (visible in the dashboard, retryable) rather than silently degrading. Set `llm_fallback=gemini` to opt back in.

## Providers (executed in the worker)

The worker owns all provider execution and its own quota state (`quota_store.py`) — Helm holds no provider SDKs.

### Claude (default)

`claude_exec.run_claude` calls `claude-agent-sdk.query()` with the job's system prompt, prompt, and effort, leveraging a Max subscription for $0 per-token cost.

- **Model:** determined by the Max subscription tier (override via `llm_model`).
- **Effort** (`llm_effort`): `low` (fastest) → `medium` → `high` *(default)* → `max` (deepest reasoning).
- **Agentic turns:** the SDK is agentic; marker/action prompts (e.g. `[CREATE_TASK]`) can need more than one turn, so the worker allows up to `CLAUDE_MAX_TURNS` (default 8) with no tools.
- **JSON mode:** Claude has no native JSON mode — the worker appends a JSON-only instruction, strips code fences, validates with `json.loads()`, and retries once stricter on failure.

### Gemini (opt-in)

`gemini_exec` calls `google-genai` with worker-local waterfall routing and quota/RPM tracking (ported from the old in-process `GeminiRouter`). Used only when a job's provider is `gemini` (via the setting, image fallback, or `llm_fallback`).

- **Image fallback:** when a job carries `image_base64` (meal-photo parsing), the worker routes it to Gemini regardless of the provider setting — Claude's Agent SDK has no multimodal input.
- **Keys** (`helm/.env`): `GEMINI_PAID_KEY`, `GEMINI_FREE_KEY_1`, `GEMINI_FREE_KEY_2`. Free keys alternate (RPM round-robin) within daily quotas; most tasks run free-tier ($0), only `parse_input` prefers paid Pro.

## Reconnect UX (`useContextJobs`)

The frontend is server-authoritative — it never holds an in-flight request in React state that a navigation would drop.

- A view calls `useContextJobs(context)`; the hook polls `GET /api/llm-jobs?context=…` while any job for that context is open, and stops when none are.
- Each terminal job is **delivered once** (tracked in a `delivered` set, then `ackLlmJob`'d), so remounting a view doesn't replay old results.
- Because the source of truth is `llm_jobs`, you can fire a request on the Dashboard, switch to the Daily tab, come back, and the completed result renders — the canonical use case this refactor was built for.

## Result hooks (server-side)

Some chats emit action markers (`[CREATE_TASK]`, `[ADD_COMPANY]`, `[ADD_PROBLEM]`, `[CREATE_APP]`) or need post-processing (ingredient classify caching). When a result lands, `result_hooks.run_hook(db, job)` dispatches on `job.context` to a registered hook that performs the DB mutation and can rewrite `job.response_text` to the cleaned, user-facing text. Hooks run in Helm (the sole DB writer), swallow their own errors, and keep the worker oblivious to app semantics.

## Services

All services inherit from `BaseLLMService` and enqueue through `_enqueue`; none knows which provider runs its job.

| Service | Task Types | JSON Mode | Multimodal |
|---------|------------|-----------|------------|
| `AdvisorService` | `parse_input`, `chat`, `plan_workout` | parse + plan | Yes (meal photos) |
| `RecipeParserService` | `recipe_parse` | Yes | No |
| `CompanyResearchService` | `company_research`, `chat` | research only | No |
| `IngredientClassifierService` | `ingredient_classify` | Yes | No |
| `TaskAdvisorService` | `chat` | No | No |
| `LeetcodeAdvisorService` | `chat`, `leetcode_hint` | No | No |
| `ApplicationAdvisorService` | `chat` | No | No |

## Observability

**Dashboard:** `/helm/api/llm-dash` — live HTML view of `llm_jobs`: status, provider, model, effort, tokens, cost, JSON validity, latency, retries, and errors. Failed jobs are retryable.

**API:** `GET /api/llm-jobs` (admin) lists/filters jobs; `GET /api/llm-jobs?context=…` powers `useContextJobs`. `/internal/llm-jobs/*` (worker-secret) is the worker's claim/heartbeat/result surface.

## Infrastructure

**Docker Compose** (`docker-compose.yml`):

```yaml
helm:          # FastAPI + SPA — enqueues jobs, serves /api + /internal, sole DB writer
  build: ./helm

llm-worker:    # the executor — claims jobs, runs providers, posts results back
  build: ./helm/bridge
  environment:
    - HELM_INTERNAL_URL=http://helm:8001
    - HELM_WORKER_SECRET=${HELM_WORKER_SECRET}
  volumes:
    - ~/.claude:/root/.claude:ro   # Claude Max auth
```

```bash
docker compose up -d --build helm llm-worker
```

The legacy `claude-bridge` service (`--profile claude`) is retired — nothing calls its `/generate` endpoint anymore; the worker executes Claude directly via `claude_exec`. It can be removed from `docker-compose.yml`.

## Key Files

| File | Purpose |
|------|---------|
| `helm/backend/services/base_llm.py` | `BaseLLMService` — builds payloads, `_enqueue` seam, image detection |
| `helm/backend/services/job_queue.py` | Queue ops: `enqueue`, `claim_next` (reaper + prune), `record_result`, `retry`, `enqueue_and_wait`, `list_for_context` |
| `helm/backend/services/result_hooks.py` | Server-side post-result hooks keyed by `job.context` |
| `helm/backend/routers/llm_jobs.py` | `/api/llm-jobs` (admin) + `/internal/llm-jobs/*` (worker-secret) |
| `helm/backend/routers/gemini_dashboard.py` | LLM jobs dashboard (HTML) |
| `helm/backend/models.py` | `LLMJob`, `HelmSetting`, `IngredientCategory` models |
| `helm/backend/services/settings_service.py` | Runtime settings with in-memory cache |
| `helm/frontend/src/useContextJobs.ts` | Per-context reconnect hook (poll + deliver-once) |
| `helm/bridge/worker.py` | The `llm-worker` loop (claim → execute → result) |
| `helm/bridge/claude_exec.py` | Claude execution via `claude-agent-sdk` |
| `helm/bridge/gemini_exec.py` + `quota_store.py` | Gemini execution + worker-local quota/waterfall |
