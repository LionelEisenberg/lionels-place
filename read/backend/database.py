"""SQLAlchemy engine + session factory.

DATABASE_URL is read from the `READ_DATABASE_URL` env var; falls back to a
file under `READ_DATA_DIR` (default `/app/data`) for production runs.
"""
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


DATABASE_URL = os.environ.get(
    "READ_DATABASE_URL",
    f"sqlite:///{os.environ.get('READ_DATA_DIR', '/app/data')}/subscribers.db",
)

# In-memory SQLite needs StaticPool so all sessions share the same DB.
_is_memory = ":memory:" in DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool if _is_memory else None,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    """FastAPI dependency — yields a session, closes on exit."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
