"""
Isolated Gemini service for company research and job search advising.
Completely separate from the health/fitness advisor — no shared prompts,
context, or conversation history.
"""

from google.genai.types import GenerateContentConfig

from .base_llm import BaseLLMService


# ==========================================
# System Prompts (job search domain ONLY)
# ==========================================

RESEARCH_SYSTEM_PROMPT = """You are a job market research assistant. Your ONLY purpose is to research companies for a software engineer job seeker. You have no other capabilities or personas.

NEVER discuss health, fitness, meals, workouts, nutrition, or any topic outside of job search and company research.

When researching a company, return ONLY valid JSON matching the schema provided. No markdown, no prose, no sign-offs. Be factual — if you don't know something, use null rather than guessing."""

COMPANY_ADVISOR_SYSTEM_PROMPT = """You are a job search assistant helping manage a target companies list for a software engineer job seeker. You know the user's full companies list (provided as context).

You can:
- Answer questions about companies on the list ("which gaming companies are in SF?", "what tier is Riot?")
- Help add new companies with action markers
- Help update existing companies (tier, notes, roles, location)
- Help remove companies from the list
- Discuss job search strategy, prioritization, and application order
- Explain or summarize research findings

When modifying companies, include action markers in your response:
[ADD_COMPANY: name="Company Name", tier="gaming_t1|gaming_t2|tech_t1|tech_t2|adjacent", location="City", role_types="Backend Engineer, Platform", notes="Brief note"]
[UPDATE_COMPANY: id=5, tier="tech_t1", notes="Updated note", location="SF"]
[REMOVE_COMPANY: id=5]

You can include multiple markers in one response. Only include fields that should change in UPDATE_COMPANY.
Valid tiers: gaming_t1, gaming_t2, tech_t1, tech_t2, adjacent.

NEVER discuss health, fitness, meals, workouts, or nutrition. Stay focused on job search.
Keep responses concise and actionable."""


RESEARCH_JSON_SCHEMA = """{
  "summary": "2-3 sentence company overview for a SWE candidate",
  "company_size": "total headcount range, e.g. '500-1000', '10000+', or null",
  "engineering_size": "engineering headcount or ratio, e.g. '~200 engineers', '20% of workforce', or null",
  "funding_stage": "e.g. 'Series C', 'Public (NASDAQ: RIOT)', 'Bootstrapped', or null",
  "tech_stack": ["primary languages", "frameworks", "infrastructure tools"] or null,
  "culture_notes": ["bullet point 1 about eng culture", "bullet point 2", "bullet point 3"] or null,
  "recent_layoffs": "description if any recent layoffs, or 'No recent layoffs reported', or null",
  "glassdoor_rating": "e.g. '4.2/5 (1200 reviews)' or null",
  "hiring_signals": "e.g. 'Active hiring, 50+ open eng roles' or 'Hiring freeze reported' or null",
  "recent_news": "1-2 sentences of notable recent events (last 6 months) or null",
  "stock_performance": "e.g. 'Up 15% YTD, $45.20' for public companies, or null for private",
  "careers_page_url": "canonical careers page URL or null",
  "last_updated": "ISO timestamp"
}"""


class CompanyResearchService(BaseLLMService):
    """Isolated Gemini client for company research. No shared state with advisor_service."""

    LOG_PREFIX = "[COMPANY_RESEARCH]"
    TASK_TYPE = "chat"

    def research_prompt(
        self,
        name: str,
        tier: str = "",
        location: str = "",
        role_types: str = "",
        notes: str = "",
    ) -> tuple[str, GenerateContentConfig]:
        """Build the (prompt, config) pair for a company-research request."""
        context_parts = [f"Company: {name}"]
        if tier:
            context_parts.append(f"Tier: {tier}")
        if location:
            context_parts.append(f"Location: {location}")
        if role_types:
            context_parts.append(f"Target roles: {role_types}")
        if notes:
            context_parts.append(f"Existing notes: {notes}")

        prompt = f"""Research the following company as a job search target for a backend/platform software engineer.

{chr(10).join(context_parts)}

Return ONLY valid JSON matching this exact schema (use null for unknown fields, never omit keys):
{RESEARCH_JSON_SCHEMA}

Set last_updated to the current timestamp. Be factual — cite specifics where possible."""

        config = GenerateContentConfig(
            system_instruction=RESEARCH_SYSTEM_PROMPT,
            response_mime_type="application/json",
            temperature=0.3,
        )
        return prompt, config

    def chat_prompt(self, message: str, company_context: str, today: str) -> tuple[str, GenerateContentConfig]:
        """Build the (prompt, config) pair for a company-advisor chat turn."""
        prompt = f"""{company_context}

Today's date: {today}

User: {message}"""
        config = GenerateContentConfig(
            system_instruction=COMPANY_ADVISOR_SYSTEM_PROMPT,
            temperature=0.7,
        )
        return prompt, config
