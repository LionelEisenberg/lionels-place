"""Tests for OAuthCredential / OAuthState models."""
from datetime import datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError

from backend.models import OAuthCredential, OAuthState, User


def test_oauth_credential_defaults(db):
    cred = OAuthCredential(refresh_token_enc="enc-token")
    db.add(cred)
    db.commit()
    db.refresh(cred)
    assert cred.id is not None
    assert cred.provider == "google_health"
    assert cred.status == "connected"
    assert cred.created_at is not None


def test_oauth_credential_unique_provider_user(db):
    user = User(jellyfin_id="jf-1", username="testuser", role="admin")
    db.add(user)
    db.commit()
    db.add(OAuthCredential(provider="google_health", user_id=user.id, refresh_token_enc="a"))
    db.commit()
    db.add(OAuthCredential(provider="google_health", user_id=user.id, refresh_token_enc="b"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_oauth_state_roundtrip(db):
    st = OAuthState(
        state="abc",
        code_verifier="verifier",
        user_id=1,
        expires_at=datetime.utcnow() + timedelta(minutes=10),
    )
    db.add(st)
    db.commit()
    fetched = db.query(OAuthState).filter(OAuthState.state == "abc").first()
    assert fetched.code_verifier == "verifier"
