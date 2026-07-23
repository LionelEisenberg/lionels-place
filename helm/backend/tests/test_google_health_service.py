"""Tests for the Google Health OAuth service."""
import os

from cryptography.fernet import Fernet

# Configure env BEFORE importing the service (reads are lazy, but set here for all tests).
os.environ["OAUTH_ENCRYPTION_KEY"] = Fernet.generate_key().decode()
os.environ["GOOGLE_HEALTH_CLIENT_ID"] = "test-client-id"
os.environ["GOOGLE_HEALTH_CLIENT_SECRET"] = "test-secret"
os.environ["GOOGLE_HEALTH_REDIRECT_URI"] = "https://helm.example/api/health/oauth/callback"

from backend.services import google_health_service as ghs


def test_encrypt_decrypt_roundtrip():
    token = "super-secret-refresh-token"
    enc = ghs.encrypt(token)
    assert enc != token
    assert ghs.decrypt(enc) == token


def test_decrypt_rejects_tampered_ciphertext():
    import pytest
    from cryptography.fernet import InvalidToken
    enc = ghs.encrypt("x")
    # Flip a character in the middle to corrupt the HMAC (appending to a Fernet token
    # can still produce valid base64 that decodes without error on some versions).
    mid = len(enc) // 2
    corrupted = enc[:mid] + ("A" if enc[mid] != "A" else "B") + enc[mid + 1:]
    with pytest.raises(InvalidToken):
        ghs.decrypt(corrupted)


def test_is_configured_true_when_env_present():
    assert ghs.is_configured() is True


def test_is_configured_false_when_missing(monkeypatch):
    monkeypatch.delenv("GOOGLE_HEALTH_CLIENT_ID", raising=False)
    assert ghs.is_configured() is False


def test_scopes_include_location_readonly():
    assert "https://www.googleapis.com/auth/googlehealth.location.readonly" in ghs.SCOPES


def test_create_and_consume_state(db):
    state, challenge = ghs.create_oauth_state(db, user_id=7)
    assert state and challenge
    verifier, user_id = ghs.consume_oauth_state(db, state)
    assert user_id == 7
    assert verifier  # the PKCE verifier persisted with the state


def test_consume_unknown_state_raises(db):
    import pytest
    with pytest.raises(ValueError, match="Unknown"):
        ghs.consume_oauth_state(db, "nope")


def test_state_is_one_time(db):
    state, _ = ghs.create_oauth_state(db, user_id=1)
    ghs.consume_oauth_state(db, state)
    import pytest
    with pytest.raises(ValueError):
        ghs.consume_oauth_state(db, state)


def test_expired_state_rejected(db):
    from datetime import datetime, timedelta
    from backend.models import OAuthState
    db.add(OAuthState(state="old", code_verifier="v", user_id=1,
                      expires_at=datetime.utcnow() - timedelta(minutes=1)))
    db.commit()
    import pytest
    with pytest.raises(ValueError, match="Expired"):
        ghs.consume_oauth_state(db, "old")


def test_build_authorize_url_has_required_params(monkeypatch):
    # Pin env locally — other test files set different GOOGLE_HEALTH_* values at
    # import time, which would otherwise leak across the suite and break these asserts.
    monkeypatch.setenv("GOOGLE_HEALTH_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("GOOGLE_HEALTH_REDIRECT_URI", "https://helm.example/api/health/oauth/callback")
    from urllib.parse import urlparse, parse_qs
    url = ghs.build_authorize_url("the-state", "the-challenge")
    q = parse_qs(urlparse(url).query)
    assert q["client_id"] == ["test-client-id"]
    assert q["redirect_uri"] == ["https://helm.example/api/health/oauth/callback"]
    assert q["response_type"] == ["code"]
    assert q["access_type"] == ["offline"]
    assert q["prompt"] == ["consent"]
    assert q["code_challenge"] == ["the-challenge"]
    assert q["code_challenge_method"] == ["S256"]
    assert q["state"] == ["the-state"]
    assert q["include_granted_scopes"] == ["false"]
    assert "googlehealth.health_metrics_and_measurements.readonly" in q["scope"][0]


from unittest.mock import patch, MagicMock


def _mock_resp(status_code, json_data):
    r = MagicMock()
    r.status_code = status_code
    r.json.return_value = json_data
    r.text = str(json_data)
    return r


@patch("backend.services.google_health_service.httpx.post")
def test_exchange_code_stores_encrypted_credential(mock_post, db):
    from backend.models import User
    u = User(jellyfin_id="jf-x", username="t", role="admin")
    db.add(u)
    db.commit()
    mock_post.return_value = _mock_resp(200, {
        "access_token": "acc-1",
        "refresh_token": "ref-1",
        "expires_in": 3600,
        "scope": "health.heart.read",
    })
    cred = ghs.exchange_code(db, code="auth-code", code_verifier="v", user_id=u.id)
    assert cred.status == "connected"
    assert cred.user_id == u.id
    assert cred.refresh_token_enc != "ref-1"            # stored encrypted
    assert ghs.decrypt(cred.refresh_token_enc) == "ref-1"
    assert ghs.decrypt(cred.access_token_enc) == "acc-1"
    assert cred.access_token_expires_at is not None


@patch("backend.services.google_health_service.httpx.post")
def test_exchange_code_failure_raises(mock_post, db):
    import pytest
    mock_post.return_value = _mock_resp(400, {"error": "invalid_grant"})
    with pytest.raises(ValueError):
        ghs.exchange_code(db, code="bad", code_verifier="v", user_id=1)


def _seed_connected(db, *, expired: bool):
    from datetime import datetime, timedelta
    from backend.models import OAuthCredential, User
    user = User(jellyfin_id="jf-seed", username="seed", role="admin")
    db.add(user)
    db.commit()
    cred = OAuthCredential(
        provider="google_health",
        user_id=user.id,
        refresh_token_enc=ghs.encrypt("ref-old"),
        access_token_enc=ghs.encrypt("acc-old"),
        access_token_expires_at=datetime.utcnow() + (timedelta(minutes=-1) if expired else timedelta(hours=1)),
        status="connected",
    )
    db.add(cred)
    db.commit()
    db.refresh(cred)
    return cred


def test_get_valid_access_token_returns_cached_when_fresh(db):
    _seed_connected(db, expired=False)
    assert ghs.get_valid_access_token(db) == "acc-old"


@patch("backend.services.google_health_service.httpx.post")
def test_get_valid_access_token_refreshes_when_stale(mock_post, db):
    _seed_connected(db, expired=True)
    mock_post.return_value = _mock_resp(200, {"access_token": "acc-new", "expires_in": 3600})
    assert ghs.get_valid_access_token(db) == "acc-new"


@patch("backend.services.google_health_service.httpx.post")
def test_refresh_invalid_grant_flips_status(mock_post, db):
    import pytest
    cred = _seed_connected(db, expired=True)
    mock_post.return_value = _mock_resp(400, {"error": "invalid_grant"})
    with pytest.raises(ghs.ReconsentRequired):
        ghs.get_valid_access_token(db)
    db.refresh(cred)
    assert cred.status == "needs_reconsent"
    assert cred.last_error


def test_get_valid_access_token_not_connected_raises(db):
    import pytest
    with pytest.raises(ValueError, match="Not connected"):
        ghs.get_valid_access_token(db)


def test_run_sync_no_op_when_not_connected(db):
    result = ghs.run_sync(db)
    assert result["status"] == "not_connected"


@patch("backend.services.google_health_service.httpx.post")
def test_run_sync_happy_path_updates_last_sync(mock_post, db, monkeypatch):
    from datetime import datetime, date
    today = datetime.utcnow().date()
    today_iso = today.isoformat()
    monkeypatch.setenv("GOOGLE_HEALTH_START_DATE", today_iso)
    today_key = today.strftime("%Y-%m-%d")
    _seed_connected(db, expired=False)  # fresh access token, no refresh call
    # _fetch_step_rollup (called from _ingest_range) keys a 1-day rollup by its
    # civilStartTime (the START day), per the off-by-one fix — so the mock must
    # supply civilStartTime, not civilEndTime, for the steps to land on today.
    mock_post.return_value = _mock_resp(200, {"rollupDataPoints": [{"civilStartTime": {"date": {"year": today.year, "month": today.month, "day": today.day}}, "steps": {"countSum": "8421"}}]})
    result = ghs.run_sync(db)
    assert result["status"] == "connected"
    assert result["steps_today"] == 8421
    assert result["last_sync_at"] is not None


@patch("backend.services.google_health_service.httpx.post")
def test_run_sync_reconsent_returns_status(mock_post, db):
    _seed_connected(db, expired=True)
    mock_post.return_value = _mock_resp(400, {"error": "invalid_grant"})
    result = ghs.run_sync(db)
    assert result["status"] == "needs_reconsent"


# ------------------------------------------------------------- session dedup
def _dup_ws(db, gid, raw, dur, start="12:09", kcal=None, cat="strength", platform=None):
    from backend.models import WorkoutSession
    s = WorkoutSession(google_id=gid, date="2026-07-14", exercise_type="Weightlifting",
                       exercise_type_raw=raw, category=cat,
                       start_time=f"2026-07-14T{start}:00", end_time=f"2026-07-14T{start}:59",
                       duration_min=dur, calories_kcal=kcal, source="google", platform=platform)
    db.add(s); db.flush()
    return s


def test_dedupe_fitbit_copy_wins_over_richer_health_connect(db):
    from backend.models import Activity
    from backend.services.google_health_service import dedupe_sessions
    from backend.services import activity_service as acts
    # The HEALTH_CONNECT copy has MORE data (kcal + longer), but FITBIT is the real
    # watch — the hollow HC mirror must never win.
    fitbit = _dup_ws(db, "fb", "WORKOUT", 60.0, kcal=None, platform="FITBIT")
    hc = _dup_ws(db, "hc", "WEIGHTLIFTING", 61.0, kcal=999.0, platform="HEALTH_CONNECT")
    acts.link_google_session(db, fitbit); acts.link_google_session(db, hc)
    db.commit()
    dedupe_sessions(db)
    db.refresh(fitbit); db.refresh(hc)
    assert fitbit.is_duplicate is False and hc.is_duplicate is True
    assert db.query(Activity).count() == 1
    assert db.query(Activity).first().google_session_id == fitbit.id


def test_dedupe_flags_duplicate_and_prunes_orphan_activity(db):
    from backend.models import Activity
    from backend.services.google_health_service import dedupe_sessions
    from backend.services import activity_service as acts
    # two Google copies of one strength workout (WORKOUT + WEIGHTLIFTING, same start)
    rich = _dup_ws(db, "wA", "WORKOUT", 60.0, kcal=300.0)        # has kcal -> canonical
    lean = _dup_ws(db, "wB", "WEIGHTLIFTING", 60.1, kcal=None)   # slightly longer, no kcal
    acts.link_google_session(db, rich); acts.link_google_session(db, lean)
    db.commit()
    assert db.query(Activity).count() == 2

    assert dedupe_sessions(db) == 1
    db.refresh(rich); db.refresh(lean)
    assert rich.is_duplicate is False and lean.is_duplicate is True     # kcal outranks duration
    assert db.query(Activity).count() == 1                              # orphan dup activity pruned
    assert db.query(Activity).first().google_session_id == rich.id


def test_dedupe_logged_copy_wins_over_richer_data(db):
    from backend.models import Activity, Workout
    from backend.services.google_health_service import dedupe_sessions
    from backend.services import activity_service as acts
    rich = _dup_ws(db, "wA", "WORKOUT", 60.0, kcal=500.0)       # more watch data...
    logged = _dup_ws(db, "wB", "WEIGHTLIFTING", 60.0, kcal=None)
    acts.link_google_session(db, rich)
    act_logged = acts.link_google_session(db, logged)
    db.add(Workout(date="2026-07-14", category="Upper Body", equipment_type="Barbell",
                   exercise="Bench", weight_lbs="135", reps_sets="8", notes="",
                   targeted_muscle_group="Chest", activity_id=act_logged.id))
    db.commit()

    dedupe_sessions(db)
    db.refresh(rich); db.refresh(logged)
    assert logged.is_duplicate is False and rich.is_duplicate is True   # ...but the logged copy wins
    remaining = db.query(Activity).all()
    assert len(remaining) == 1 and remaining[0].id == act_logged.id     # user's logged activity survives


def test_link_skips_a_duplicate(db):
    from backend.models import Activity
    from backend.services import activity_service as acts
    s = _dup_ws(db, "dup", "RUNNING", 33.0, start="17:14", kcal=400.0, cat="cardio")
    s.is_duplicate = True
    db.commit()
    # A duplicate never gets an Activity, so it can never be locked in and thus never
    # contributes to the derived est_active_burn.
    assert acts.link_google_session(db, s) is None
    assert db.query(Activity).count() == 0
