# Read — editorial blog at `read.lionel.place`

A personal blog with hand-written HTML posts, client-side password-gated sections, and an email subscription form on the index page. Everything is served by a thin FastAPI app inside a Docker container.

This README covers **architecture** and **day-to-day operations**. For authoring posts, see `blog-posts/README.md`. For the design rationale behind subscriptions, see `../docs/superpowers/specs/2026-05-13-read-email-subscriptions-design.md`.

---

## Architecture

Two-stage Docker build (`Dockerfile`):

```
┌─────────────────────────────────────────────────────────┐
│ Stage 1: node:20-alpine                                 │
│  - npm ci                                                │
│  - node bin/build.mjs                                    │
│    • walks blog-posts/posts/*.html                       │
│    • encrypts <private password="…"> blocks via AES-GCM │
│    • strips YYYY-MM-DD- prefixes from filenames         │
│    • emits dist/ (index.html + posts/*.html + assets)   │
└─────────────────────────────────────────────────────────┘
                          │  (COPY --from=builder)
                          ▼
┌─────────────────────────────────────────────────────────┐
│ Stage 2: python:3.12-slim                                │
│  - pip install fastapi uvicorn sqlalchemy pydantic      │
│  - CMD uvicorn backend.app:app --host 0.0.0.0 --port 80 │
└─────────────────────────────────────────────────────────┘
```

The FastAPI app (`backend/app.py`) does two jobs:

1. **API routes** under `/api/*` (defined in `backend/routes.py`):
   - `POST /api/subscribe` — add an email to the subscriber list
   - `GET /api/unsubscribe?token=…` — currently `501 Not Implemented`; will land when the notification flow is built

2. **Static file serving** via a catch-all `GET /{path:path}` that mimics nginx's `try_files $uri $uri/ $uri.html /posts/$uri.html =404`. Both GET and HEAD work. Path traversal is blocked via `Path.is_relative_to`.

### Directory layout

```
read/
├── Dockerfile              # two-stage build
├── pyproject.toml          # FastAPI/uvicorn/SQLAlchemy/Pydantic deps + pytest config
├── package.json            # Node deps for the build step (build-time only)
├── bin/build.mjs           # encrypts <private> blocks → dist/
├── crypto-utils.mjs        # AES-GCM helpers (used by build and decrypt)
├── decrypt.js              # client-side decryption in the browser
├── style.css               # editorial style guide
├── index.html              # post listing + subscribe form (committed by hand)
├── template.html           # scaffold for new posts
├── assets/                 # favicon, og image, etc.
├── backend/
│   ├── app.py              # FastAPI entry point
│   ├── routes.py           # /api/subscribe + /api/unsubscribe stub
│   ├── models.py           # Subscriber ORM model
│   ├── database.py         # SQLite engine + session factory
│   ├── schemas.py          # Pydantic request/response models
│   ├── rate_limit.py       # in-memory sliding-window limiter (5 req/min/IP)
│   └── notify.py           # STUB — planned manual notification dispatch
├── data/                   # gitignored, volume-mounted; holds subscribers.db
├── .env                    # gitignored; READ_SMTP_USER + READ_SMTP_APP_PASSWORD
├── blog-posts/             # gitignored; clone of LionelEisenberg/read-posts
└── tests/                  # pytest suite (30 tests)
```

The compose service mounts `./read/data:/app/data` and `./read/.env` as an env file.

---

## Subscriber operations

The DB lives at `./read/data/subscribers.db`. You can query it directly from the host or via `docker exec`.

### View all active subscribers

```bash
sqlite3 ./read/data/subscribers.db \
  "select id, email, subscribed_at from subscribers where unsubscribed_at is null order by subscribed_at;"
```

### Count active subscribers

```bash
sqlite3 ./read/data/subscribers.db \
  "select count(*) from subscribers where unsubscribed_at is null;"
```

### Export to a file

```bash
sqlite3 -header -csv ./read/data/subscribers.db \
  "select email, subscribed_at from subscribers where unsubscribed_at is null;" \
  > subscribers.csv
```

### Delete a subscriber

```bash
sqlite3 ./read/data/subscribers.db \
  "delete from subscribers where email='someone@example.com';"
```

Note: deleting is a hard delete. The intended UX is soft-delete via `unsubscribed_at` (will be wired up when the unsubscribe endpoint graduates from 501).

### Back up the DB

SQLite's online backup is safe while the service is running:

```bash
docker exec read sqlite3 /app/data/subscribers.db \
  ".backup '/app/data/subscribers.backup.db'"
```

Then copy `./read/data/subscribers.backup.db` to your backup location.

---

## Subscribe API

### `POST /api/subscribe`

```http
POST /api/subscribe
Content-Type: application/json

{ "email": "reader@example.com", "hp": "" }
```

**`hp`** is a honeypot field. Real users (and the form on `index.html`) leave it empty. Bots tend to fill every input; non-empty `hp` is silently dropped.

| Scenario | Status | Body |
|---|---|---|
| New email | 200 | `{"ok": true}` |
| Already subscribed (active) | 200 | `{"ok": true}` |
| Re-subscribe after unsubscribe | 200 | `{"ok": true}` (clears `unsubscribed_at` and rotates the unsubscribe token) |
| Invalid email format | 400 | `{"error": "invalid_email"}` |
| Email > 254 chars (RFC 5321) | 400 | `{"error": "invalid_email"}` |
| Honeypot field non-empty | 200 | `{"ok": true}` (silent, no DB write) |
| Rate-limited (>5/min from this IP) | 200 | `{"ok": true}` (silent, no DB write) |

All anti-abuse responses are identical to prevent email enumeration via the response shape.

### `GET /api/unsubscribe?token=…`

Currently returns `501 Not Implemented`. When the notification flow lands, this will set `unsubscribed_at` for the matching token and return a confirmation page. The token-per-row column (`unsubscribe_token`) is already being generated and rotated on re-subscribe.

---

## Sending notifications (planned, not yet implemented)

`backend/notify.py` is a stub. The planned manual flow:

```bash
docker compose exec read python -m backend.notify <slug>
```

When implemented it will:

1. Look up the post's title + summary from `dist/index.html`
2. Query active subscribers (`unsubscribed_at IS NULL`)
3. Connect to `smtp.gmail.com:587` with `READ_SMTP_USER` + `READ_SMTP_APP_PASSWORD` from `.env`
4. Send one plaintext email per subscriber with a per-recipient unsubscribe link
5. Throttle ~250ms between sends to stay under Gmail's per-second limits

To prepare for the day this lands:

- Generate a Gmail app password at <https://myaccount.google.com/apppasswords>
- Fill in `./read/.env`:
  ```
  READ_SMTP_USER=you@gmail.com
  READ_SMTP_APP_PASSWORD=xxxx xxxx xxxx xxxx
  ```
- `docker compose up -d read` to pick up the env vars on the next restart

See `../docs/superpowers/specs/2026-05-13-read-email-subscriptions-design.md` for full details on the deferred notification design.

---

## Day-to-day operations

### Restart the container

```bash
docker compose restart read
```

### Rebuild after code changes

From `C:\Pirateship`:

```bash
docker compose up -d --build read
```

The Docker BuildKit snapshotter on Docker Desktop sometimes hits a corruption bug at the `pip install` step. If you see `failed to commit … snapshot … does not exist: not found`, fall back to the classic builder:

```bash
DOCKER_BUILDKIT=0 docker compose up -d --build read
```

A Docker Desktop restart also clears it.

### View logs

```bash
docker compose logs -f --tail 50 read
```

### Run tests

```bash
cd read && python -m pytest -v
```

Requires `fastapi`, `sqlalchemy`, `pydantic`, `pytest`, and `httpx` to be importable from the Python you run. `pip install -e ".[test]"` from `read/` covers it (needs Python ≥ 3.12; on older Python, install the deps manually).

### Pre-commit hook

The repo-level pre-commit hook automatically runs `cd read && python -m pytest -q` before every commit. It skips gracefully if the deps aren't importable from the host Python.

---

## Anti-abuse posture

The subscribe endpoint has three layers of defense, all of which return identical `200 {"ok": true}` so probing attackers can't tell the difference between cases:

1. **Honeypot field.** Hidden `<input name="hp">` on the form. Real browsers leave it empty; bots fill all inputs. Non-empty → silently dropped.
2. **Per-IP rate limit.** Sliding-window, 5 requests/minute keyed by `X-Forwarded-For` (first comma-separated value, falling back to `request.client.host`). In-memory; resets on container restart.
3. **Duplicate dedup.** Existing-email cases (active or previously-unsubscribed) return ok without inserting a second row. Re-subscribes rotate the unsubscribe token for defense in depth.

For a larger-scale deployment, swap the rate limiter for `slowapi` with Redis, add CAPTCHA, and consider double opt-in.

---

## What's NOT in here

Out of scope for the current implementation (see the spec for rationale):

- The actual email sending (`backend/notify.py` is a stub)
- The functional unsubscribe route (returns `501`)
- An admin UI for viewing/exporting subscribers — use `sqlite3` directly
- Double opt-in confirmation emails
- CAPTCHA
- RSS feed
- Moving the Node build step into FastAPI (would let you trigger rebuilds via API; currently you need `docker compose build`)
