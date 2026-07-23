"""Provider-agnostic LLM base service.

All LLM calls are executed out-of-process by the worker: subclasses call
self._enqueue(...) to submit a prepared-prompt job to the queue and return a
job_id; the caller/router polls get_job_status. There is no in-process
generation path.
"""

import base64
import logging

from ..database import SessionLocal
from .settings_service import get_setting
from .providers.content import flatten_contents
from . import job_queue

logger = logging.getLogger(__name__)


class BaseLLMService:
    """Base for all LLM-powered services."""

    LOG_PREFIX = "[LLM]"
    TASK_TYPE = "chat"  # subclasses override

    def _image_base64(self, contents) -> str | None:
        """Extract base64 of the first image Part, if any (for the queue payload)."""
        if isinstance(contents, list):
            for item in contents:
                data = getattr(item, "data", None) or getattr(getattr(item, "inline_data", None), "data", None)
                if data is not None:
                    return data if isinstance(data, str) else base64.b64encode(data).decode()
        return None

    def _enqueue(self, contents, config, *, task_type, context, method=None, context_key=None) -> str:
        """Enqueue a prepared-prompt job instead of executing inline. Returns job_id.

        Derives the worker payload from the already-built contents/config, so the
        caller's prompt-building is unchanged. Helm owns the DB, so enqueue in-process.

        `context_key`, if given, is stashed in the payload for result-hooks that need a
        finer-grained key than `context` (e.g. per-problem leetcode chat history).
        """
        payload = {
            "system_prompt": getattr(config, "system_instruction", None) or "",
            "prompt": flatten_contents(contents),
            "want_json": getattr(config, "response_mime_type", None) == "application/json",
            "image_base64": self._image_base64(contents),
        }
        if context_key is not None:
            payload["context_key"] = context_key
        db = SessionLocal()
        try:
            job = job_queue.enqueue(
                db, context=context, task_type=task_type, request_payload=payload,
                provider=get_setting("llm_provider", "claude").lower(),
                model=get_setting("llm_model", None),
                effort=get_setting("llm_effort", None),
                json_requested=payload["want_json"],
                service=self.LOG_PREFIX.strip("[]"), method=method or task_type,
            )
            return job.job_id
        finally:
            db.close()
