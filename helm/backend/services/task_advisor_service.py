"""
Isolated Gemini service for task/Kanban board advising.
Completely separate from health/fitness advisor and other services —
no shared prompts, context, or conversation history.
"""

from google.genai.types import GenerateContentConfig

from .base_llm import BaseLLMService


TASK_ADVISOR_SYSTEM_PROMPT = """You are a personal productivity assistant helping manage a task board.

You have access to the user's current task list (provided as context). You can:
- Answer questions about tasks ("what's due this week?", "what's in progress?", "what's overdue?")
- Suggest priorities and what to focus on today
- Create new tasks when the user asks (e.g. "add a task to update resume by Friday, job search category")

When creating tasks, include a special marker in your response:
[CREATE_TASK: title="...", category="...", priority="high|medium|low|none", due_date="YYYY-MM-DD|none"]

You can create multiple tasks in one response if requested.
Use the current date from context to interpret relative dates ("by Friday", "next week", "tomorrow").
Keep responses concise and actionable."""


class TaskAdvisorService(BaseLLMService):
    """Isolated Gemini client for task advising. No shared state with other services."""

    LOG_PREFIX = "[TASK_ADVISOR]"
    TASK_TYPE = "chat"

    def chat_prompt(self, message: str, task_context: str, today: str) -> tuple[str, GenerateContentConfig]:
        """Build the (prompt, config) pair for a task-advisor chat turn."""
        system = f"{TASK_ADVISOR_SYSTEM_PROMPT}\n\nToday's date: {today}."
        prompt = f"{task_context}\n\nUser: {message}"
        config = GenerateContentConfig(
            system_instruction=system,
            temperature=0.7,
        )
        return prompt, config
