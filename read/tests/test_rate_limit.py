"""Tests for the in-memory sliding-window rate limiter."""
import backend.rate_limit as rl_mod
from backend.rate_limit import SlidingWindowRateLimiter


def test_under_limit_allowed():
    rl = SlidingWindowRateLimiter(max_requests=3, window_seconds=10.0)
    assert rl.is_allowed("1.2.3.4")
    assert rl.is_allowed("1.2.3.4")
    assert rl.is_allowed("1.2.3.4")


def test_over_limit_denied():
    rl = SlidingWindowRateLimiter(max_requests=3, window_seconds=10.0)
    for _ in range(3):
        rl.is_allowed("1.2.3.4")
    assert not rl.is_allowed("1.2.3.4")


def test_keys_are_independent():
    rl = SlidingWindowRateLimiter(max_requests=2, window_seconds=10.0)
    rl.is_allowed("1.1.1.1")
    rl.is_allowed("1.1.1.1")
    assert not rl.is_allowed("1.1.1.1")
    assert rl.is_allowed("2.2.2.2")


def test_window_slides_releases_old_hits(monkeypatch):
    fake = {"t": 100.0}
    monkeypatch.setattr(rl_mod.time, "monotonic", lambda: fake["t"])

    rl = SlidingWindowRateLimiter(max_requests=2, window_seconds=10.0)
    rl.is_allowed("ip")
    rl.is_allowed("ip")
    assert not rl.is_allowed("ip")

    fake["t"] = 111.0  # 11s later — both hits aged out
    assert rl.is_allowed("ip")


def test_reset_clears_all_state():
    rl = SlidingWindowRateLimiter(max_requests=1, window_seconds=10.0)
    rl.is_allowed("ip")
    assert not rl.is_allowed("ip")
    rl.reset()
    assert rl.is_allowed("ip")
