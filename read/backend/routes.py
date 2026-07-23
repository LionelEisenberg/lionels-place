"""API routes: POST /api/subscribe, GET /api/unsubscribe (stub)."""
import re

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import get_db
from .models import Subscriber, new_token
from .rate_limit import SlidingWindowRateLimiter
from .schemas import SubscribeRequest


router = APIRouter(prefix="/api")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_EMAIL_LEN = 254  # RFC 5321

# Module-level singleton. Tests reset via `_rate_limiter.reset()`.
_rate_limiter = SlidingWindowRateLimiter(max_requests=5, window_seconds=60.0)


def _client_ip(request: Request) -> str:
    """Resolve the original client IP, respecting Caddy's X-Forwarded-For."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # First comma-separated value = original client (Caddy appends).
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/subscribe")
def subscribe(
    payload: SubscribeRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    """Add an email to the subscribers table.

    Anti-abuse responses all return 200 ok=true silently:
    - honeypot field non-empty
    - rate limit exceeded for this IP
    - duplicate email (active OR previously unsubscribed → reactivates)

    Returns 400 for malformed email.
    """
    # Honeypot — silent success
    if payload.hp:
        return {"ok": True}

    # Rate limit — silent success
    if not _rate_limiter.is_allowed(_client_ip(request)):
        return {"ok": True}

    # Validate email
    email = payload.email.strip().lower()
    if len(email) > MAX_EMAIL_LEN or not EMAIL_RE.match(email):
        response.status_code = 400
        return {"error": "invalid_email"}

    existing = db.query(Subscriber).filter(Subscriber.email == email).first()
    if existing is not None:
        if existing.unsubscribed_at is not None:
            # Re-subscribe: clear flag, rotate token (old token may have leaked)
            existing.unsubscribed_at = None
            existing.unsubscribe_token = new_token()
            db.commit()
        return {"ok": True}

    try:
        db.add(Subscriber(email=email))
        db.commit()
    except IntegrityError:
        # Race: another request inserted the same email between our
        # SELECT and COMMIT. Treat as duplicate-active; silent success.
        db.rollback()
    return {"ok": True}


@router.get("/unsubscribe")
def unsubscribe(token: str):
    """Stub — implemented when the manual notification flow is built."""
    return Response(status_code=501, content="Not implemented")
