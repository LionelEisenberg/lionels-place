"""ORM model for the subscribers table."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, Index, Integer, String
from sqlalchemy.orm import declarative_base


Base = declarative_base()


def utc_now_iso() -> str:
    """Current UTC timestamp as ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


def new_token() -> str:
    """Fresh uuid4 hex string for unsubscribe tokens."""
    return uuid.uuid4().hex


class Subscriber(Base):
    """An email subscriber to the Read blog.

    Soft-delete: `unsubscribed_at` set to ISO timestamp when they unsubscribe.
    Row is never hard-deleted, so re-subscribes don't fail the unique constraint.
    """
    __tablename__ = "subscribers"

    id = Column(Integer, primary_key=True)
    email = Column(String, nullable=False, unique=True)
    subscribed_at = Column(String, nullable=False, default=utc_now_iso)
    unsubscribe_token = Column(String, nullable=False, unique=True, default=new_token)
    unsubscribed_at = Column(String, nullable=True)


Index("idx_subscribers_unsubscribed_at", Subscriber.unsubscribed_at)
