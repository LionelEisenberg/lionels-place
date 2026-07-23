"""In-memory sliding-window rate limiter, keyed by string (e.g. IP)."""
import time
from collections import defaultdict, deque
from threading import Lock


class SlidingWindowRateLimiter:
    """Simple per-key rate limiter using a sliding time window.

    Not durable across process restarts — by design. For a personal-blog
    subscribe endpoint this is sufficient; under abuse the process can be
    restarted to clear state, and legitimate users are unaffected by the
    short-lived in-memory store.
    """

    def __init__(self, max_requests: int, window_seconds: float):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def is_allowed(self, key: str) -> bool:
        """Record a hit for `key` and return whether it's within the limit."""
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] < cutoff:
                hits.popleft()
            if len(hits) >= self.max_requests:
                return False
            hits.append(now)
            return True

    def reset(self) -> None:
        """Clear all state. Used by tests."""
        with self._lock:
            self._hits.clear()
