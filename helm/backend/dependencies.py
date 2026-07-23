"""Shared FastAPI dependencies for authenticated endpoints."""

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .database import get_db
from .models import User


def resolve_current_user(jellyfin_id: str, db: Session) -> User | None:
    """Look up User by jellyfin_id. Returns None if not found."""
    return db.query(User).filter(User.jellyfin_id == jellyfin_id).first()


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """FastAPI dependency — resolve the authenticated user from request state.
    Use as: current_user: User = Depends(get_current_user)"""
    user_info = getattr(request.state, "user", None)
    if not user_info:
        raise HTTPException(status_code=401, detail="Authentication required")
    user = resolve_current_user(user_info["jellyfin_id"], db)
    if not user:
        raise HTTPException(status_code=401, detail="User not found, please log in again")
    return user
