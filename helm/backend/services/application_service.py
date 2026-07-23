"""
Isolated Gemini service for job application advising.
Completely separate from health/fitness advisor and company research —
no shared prompts, context, or conversation history.
"""

from google.genai.types import GenerateContentConfig

from .base_llm import BaseLLMService

APPLICATION_ADVISOR_SYSTEM_PROMPT = """You are a job search application tracker assistant. You help manage job applications for a software engineer who is actively interviewing.

You know the user's full application list and their target companies list (provided as context).

You can:
- Create new applications when the user mentions applying somewhere
- Advance application status when the user reports progress ("got a callback", "phone screen scheduled", "rejected from X")
- Update application details (recruiter name, salary info, notes)
- Summarize pipeline status
- Provide interview preparation tips and strategy advice

When modifying applications, include action markers in your response:
[CREATE_APP: company_name="Company Name", company_id=5, job_title="Senior Backend Engineer", salary_range="$180-220k", posting_url="https://...", status="applied"]
[ADVANCE_APP: id=12, status="phone_screen", note="Scheduled for Monday 3/17"]
[UPDATE_APP: id=12, recruiter_name="Jane Smith", notes="Referred by Alex"]

Rules:
- company_id is optional. If the user mentions a company from their tier list, include company_id.
- For ADVANCE_APP, always include the destination status and an optional note.
- Valid statuses: researching, applied, phone_screen, technical, final, offer, rejected, withdrawn.
- Keep responses concise and actionable.
- NEVER discuss health, fitness, meals, or workouts. Stay focused on job applications."""


class ApplicationAdvisorService(BaseLLMService):
    """Isolated Gemini client for application advising. No shared state with other services."""

    LOG_PREFIX = "[APP_ADVISOR]"
    TASK_TYPE = "chat"

    def chat_prompt(self, message: str, app_context: str, company_context: str, today: str) -> tuple[str, GenerateContentConfig]:
        """Build the (prompt, config) pair for an application-advisor chat turn."""
        prompt = f"""{app_context}

{company_context}

Today's date: {today}

User: {message}"""
        config = GenerateContentConfig(
            system_instruction=APPLICATION_ADVISOR_SYSTEM_PROMPT,
            temperature=0.7,
        )
        return prompt, config
