"""
AI-powered recipe extraction from URLs using Gemini.
Fetches page content, sends to Gemini for structured parsing.
"""

import re

import httpx
from google.genai.types import GenerateContentConfig

from .base_llm import BaseLLMService

RECIPE_PARSE_INSTRUCTIONS = """You are a recipe extraction assistant. Given the text content of a web page or YouTube video description, extract a structured recipe.

Return a JSON object with these fields:
{
  "name": "Recipe name — standardized format: 'Dish Name - Variant' (e.g., 'Babka - Chocolate', 'Risotto - Mushroom', 'Ribs - Cola Braised'). No superlatives ('The Best...', 'Amazing...', 'Perfect...'), no 'Recipe' suffix.",
  "instructions": "Numbered step-by-step instructions. IMPORTANT RULES:\\n1. Each step MUST be numbered ('1. ', '2. ', etc.)\\n2. Every step that uses an ingredient MUST include the exact amount — e.g., 'Add 50 g (2 tbsp) of butter to the mixer' NOT 'Add butter to the mixer'\\n3. Insert a blank line and a section divider '---' between steps separated by large time gaps (e.g., 'let rise overnight', 'refrigerate for 4 hours', 'the next day'). Label the new section (e.g., '--- Day 2 ---' or '--- After Resting ---')",
  "notes": "Any tips, variations, or serving suggestions mentioned (null if none)",
  "servings": <integer yield count — how many units/batches the recipe makes, or null>,
  "feeds": <integer — roughly how many people the recipe feeds, or null>,
  "prep_ahead": <true if recipe mentions advance prep/overnight/day before, false otherwise>,
  "tags": "comma-separated tags based on cuisine, course, technique (e.g. 'Italian,Dinner,Braised')",
  "ingredients": [
    {
      "name": "ingredient name (plain, no amounts)",
      "amount": <weight in grams as a number. Convert ALL measurable ingredients to grams. Use standard conversions: 1 cup flour = 125g, 1 cup sugar = 200g, 1 cup butter = 227g, 1 tbsp butter = 14g, 1 cup milk/water = 240g, 1 cup rice = 185g, 1 cup cheese = 113g, 1 egg = 50g, etc. If the ingredient is inherently uncountable by weight (e.g., 'to taste', 'a pinch'), set to null>,
      "unit": "g (always grams when amount is set, null when amount is null)",
      "original_unit": "the original measurement as written, e.g., '2 tbsp', '1 cup', '3 large'. Null if already in grams or if amount is null",
      "category": "grouping like 'Dough', 'Filling', 'Sauce' if recipe sections exist, else null",
      "exotic": <true if this is a specialty/uncommon ingredient that most home cooks wouldn't have (e.g., saffron, tahini, fish sauce, miso paste, harissa, cardamom pods, sumac, gochujang, phyllo dough, yeast, anchovy paste). false for pantry staples (butter, eggs, flour, sugar, salt, pepper, olive oil, garlic, onion, milk, common spices like cinnamon/paprika/cumin)>,
      "sort_order": <integer starting from 0>
    }
  ]
}

Rules:
- Extract ALL ingredients mentioned, even if amounts are vague
- ALWAYS convert ingredient amounts to grams. Keep original_unit for reference.
- For amounts like "a few" or "handful", set amount to null, unit to null
- Convert fractions to decimals (1/2 = 0.5, 1/4 = 0.25)
- Preserve the recipe's natural groupings (dough vs filling vs sauce)
- For YouTube videos, extract from whatever content is available (description, transcript text)
- Instructions must include ingredient amounts inline with each step
- Number every instruction step
- Add time-gap dividers between steps separated by hours or days
- Keep instructions faithful to the original — don't add steps that aren't mentioned
- Tags should be specific and useful: cuisine (Italian, Greek, American), course (Dinner, Dessert, Appetizer), technique (Braised, Baked, Quick)
- Return ONLY valid JSON, no markdown formatting"""


class RecipeParserService(BaseLLMService):
    """Extracts structured recipe data from web page content using Gemini."""

    LOG_PREFIX = "[RECIPE_PARSER]"
    TASK_TYPE = "recipe_parse"

    def _fetch_page(self, url: str) -> str:
        """Fetch page content, falling back to Google cache on 403."""
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            resp = client.get(url, headers=headers)
            if resp.status_code == 403:
                # Site blocks direct access — try Google cache
                cache_url = f"https://webcache.googleusercontent.com/search?q=cache:{url}"
                resp = client.get(cache_url, headers=headers)
                if resp.status_code != 200:
                    raise ValueError(f"Site blocked direct access (403) and Google cache unavailable for: {url}")
                return resp.text
            resp.raise_for_status()
            return resp.text

    def parse_url_prompt(self, url: str, page_text: str, instructions: str | None = None) -> tuple[str, GenerateContentConfig]:
        """Build the (prompt, config) pair for a URL-based recipe parse, given
        already-fetched page content."""
        # Strip HTML tags for a rough text extraction
        text_content = re.sub(r'<script[^>]*>.*?</script>', '', page_text, flags=re.DOTALL)
        text_content = re.sub(r'<style[^>]*>.*?</style>', '', text_content, flags=re.DOTALL)
        text_content = re.sub(r'<[^>]+>', ' ', text_content)
        text_content = re.sub(r'\s+', ' ', text_content).strip()

        if len(text_content) > 15000:
            text_content = text_content[:15000]

        prompt = f"""{RECIPE_PARSE_INSTRUCTIONS}

URL: {url}

Page content:
{text_content}"""

        if instructions and instructions.strip():
            prompt += f"\n\nUser instructions: {instructions.strip()}"

        config = GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.2,
        )
        return prompt, config

    def parse_text_prompt(self, text: str, instructions: str | None = None) -> tuple[str, GenerateContentConfig]:
        """Build the (prompt, config) pair for a pasted-text recipe parse."""
        if len(text) > 15000:
            text = text[:15000]

        prompt = f"""{RECIPE_PARSE_INSTRUCTIONS}

Pasted recipe text:
{text}"""

        if instructions and instructions.strip():
            prompt += f"\n\nUser instructions: {instructions.strip()}"

        config = GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.2,
        )
        return prompt, config
