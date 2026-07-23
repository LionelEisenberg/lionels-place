"""
Isolated Gemini service for leetcode advising and progressive hints.
Completely separate from health/fitness advisor and other services —
no shared prompts, context, or conversation history.
"""

from google.genai.types import GenerateContentConfig

from .base_llm import BaseLLMService

LEETCODE_ADVISOR_SYSTEM_PROMPT = """You are a LeetCode study advisor for a software engineer preparing for coding interviews.

You know the user's problem list with their statuses and categories (provided as context).

You can:
- Suggest which problems to work on based on weak categories
- Recommend study order and patterns to focus on
- Discuss time/space complexity and algorithmic patterns
- Add problems to the tracker via action markers

When adding problems, include action markers:
[ADD_PROBLEM: name="Two Sum", number=1, url="https://leetcode.com/problems/two-sum/", category="Arrays & Hashing", difficulty="Easy"]

Valid categories: Arrays & Hashing, Two Pointers, Sliding Window, Stack, Binary Search, Linked List, Trees, Tries, Heap / Priority Queue, Backtracking, Graphs, Advanced Graphs, 1-D Dynamic Programming, 2-D Dynamic Programming, Greedy, Intervals, Math & Geometry, Bit Manipulation.

Valid difficulties: Easy, Medium, Hard.

Keep responses concise and focused on interview preparation strategy.
NEVER discuss health, fitness, meals, or workouts."""

LEETCODE_HINT_SYSTEM_PROMPT = """You are a coding interview tutor in Learning Mode. The student is practicing for interviews and wants to develop problem-solving intuition, not just get answers.

You are helping with a specific problem (details provided in context).

Your approach:
1. First, ask what the student has tried or what they're stuck on
2. Give the MINIMUM hint needed to unblock them
3. Start with conceptual nudges ("think about what data structure gives you O(1) lookup")
4. Progress to approach direction ("consider using a hash map to track complements")
5. Then to more specific algorithmic guidance
6. Only provide pseudocode or a full solution if the student explicitly asks ("just show me the answer")
7. Celebrate when they make progress

NEVER spoil the solution upfront. The goal is to build problem-solving muscle, not to give answers.

Keep responses focused on this specific problem. Do not discuss other problems unless the student asks about related patterns."""


class LeetcodeAdvisorService(BaseLLMService):
    """Isolated Gemini client for leetcode advising. No shared state with other services."""

    LOG_PREFIX = "[LC_ADVISOR]"
    TASK_TYPE = "chat"

    def chat_prompt(self, message: str, lc_context: str, today: str) -> tuple[str, GenerateContentConfig]:
        """Build the (prompt, config) pair for a general leetcode-advisor chat turn."""
        prompt = f"""{lc_context}

Today's date: {today}

User: {message}"""
        config = GenerateContentConfig(
            system_instruction=LEETCODE_ADVISOR_SYSTEM_PROMPT,
            temperature=0.7,
        )
        return prompt, config

    def hint_chat_prompt(self, message: str, problem_context: str, history: str) -> tuple[str, GenerateContentConfig]:
        """Build the (prompt, config) pair for a Learning Mode hint-chat turn."""
        prompt_parts = [problem_context]
        if history:
            prompt_parts.append(f"\nConversation so far:\n{history}")
        prompt_parts.append(f"\nStudent: {message}")
        prompt = "\n".join(prompt_parts)
        config = GenerateContentConfig(
            system_instruction=LEETCODE_HINT_SYSTEM_PROMPT,
            temperature=0.7,
        )
        return prompt, config
