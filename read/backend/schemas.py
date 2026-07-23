"""Pydantic request/response schemas for the subscribe API."""
from pydantic import BaseModel, Field


class SubscribeRequest(BaseModel):
    """Body of POST /api/subscribe.

    Length and format are validated in the route handler so that malformed
    input returns a controlled 400 with our error payload (Pydantic would
    otherwise return 422 and pre-empt our handler).
    """
    email: str
    hp: str = Field(default="")  # honeypot — must be empty


class ErrorResponse(BaseModel):
    error: str
