"""
Advisor router — dedicated AI chat for longer conversations and workout planning.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from ..database import get_db
from ..models import ChatMessage

router = APIRouter(prefix="/api/advisor", tags=["advisor"])


@router.get("/history")
async def chat_history(limit: int = Query(default=50, le=200), db: Session = Depends(get_db)):
    """Get recent chat messages."""
    messages = db.query(ChatMessage).filter(ChatMessage.context == "advisor").order_by(desc(ChatMessage.id)).limit(limit).all()
    messages.reverse()  # Chronological order
    return [{"role": m.role, "content": m.content, "created_at": m.created_at} for m in messages]
