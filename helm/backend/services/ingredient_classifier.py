"""
Ingredient classifier — maps ingredient names to grocery aisle categories.
Uses a local DB cache (IngredientCategory table), routing cache misses through
the LLM job queue (see `services/job_queue.enqueue_and_wait`).
"""

import json
import re
from sqlalchemy.orm import Session

from .base_llm import BaseLLMService
from .settings_service import get_setting
from . import job_queue
from ..models import IngredientCategory

from google.genai.types import GenerateContentConfig

VALID_CATEGORIES = {"Produce", "Dairy", "Meat", "Seafood", "Pantry", "Spices", "Bakery", "Frozen", "Beverages", "Other"}


def normalize_name(name: str) -> str:
    """Normalize ingredient name for consistent lookups.
    Lowercases, strips quantities/parentheticals, collapses whitespace."""
    s = name.lower().strip()
    # Remove parenthetical notes: "chicken breast (boneless)" → "chicken breast"
    s = re.sub(r'\(.*?\)', '', s)
    # Remove leading quantity words: "fresh basil" stays, but "2 cloves garlic" shouldn't reach here
    # (amounts are separate fields, but some recipe parsers embed them)
    s = re.sub(r'^\d+[\d./]*\s*(oz|g|kg|lb|lbs|ml|l|cups?|tbsp|tsp|bunch|head|cloves?|pieces?|slices?|stalks?)\s+', '', s)
    # Collapse whitespace
    s = re.sub(r'\s+', ' ', s).strip()
    # Remove trailing commas/periods
    s = s.rstrip(',.')
    return s


def classify_ingredients(names: list[str], db: Session) -> dict[str, str]:
    """Classify ingredient names into grocery aisle categories.

    Returns a dict mapping each input name to a category.
    Uses cached lookups first, then routes unknowns through the LLM job queue
    (blocking on the worker via enqueue_and_wait — behavior-preserving vs the
    old in-request Gemini call, which also blocked). Falls back to 'Other' on
    timeout/failure.
    """
    if not names:
        return {}

    LOG = "[INGREDIENT_CLASSIFIER]"
    print(f"{LOG} Classifying {len(names)} ingredient(s)", flush=True)

    # Normalize all names
    normalized = {name: normalize_name(name) for name in names}
    unique_normalized = set(normalized.values())

    # Batch lookup from cache
    cached = {}
    if unique_normalized:
        rows = db.query(IngredientCategory).filter(
            IngredientCategory.name.in_(unique_normalized)
        ).all()
        for row in rows:
            cached[row.name] = row.category

    cache_hits = len(cached)
    if cache_hits:
        print(f"{LOG} Cache hits: {cache_hits} — {', '.join(f'{k}→{v}' for k, v in cached.items())}", flush=True)

    # Find unknowns
    unknowns = [n for n in unique_normalized if n not in cached and n]

    # Route unknowns through the queue for LLM classification
    if unknowns:
        print(f"{LOG} Cache misses: {len(unknowns)} — {', '.join(unknowns)} — enqueuing", flush=True)
        # original names whose normalized form is a cache miss — lets the
        # remap step recover the result hook's normalized-name keys.
        miss_originals = sorted({name for name, norm in normalized.items() if norm in unknowns})

        prompt, config = classify_prompt(unknowns)
        payload = {
            "system_prompt": getattr(config, "system_instruction", None) or "",
            "prompt": prompt,
            "want_json": getattr(config, "response_mime_type", None) == "application/json",
            "image_base64": None,
            "context_key": json.dumps(miss_originals),
        }
        job = job_queue.enqueue_and_wait(
            db, context="ingredient_classify", task_type="ingredient_classify",
            request_payload=payload,
            provider=get_setting("llm_provider", "claude").lower(),
            service=IngredientClassifierService.LOG_PREFIX.strip("[]"), method="classify",
            timeout_s=45,
        )

        if job is not None and job.status == "succeeded":
            # The ingredient_classify result hook (services/result_hooks.py) has
            # already remapped normalized-name keys back to originals, validated
            # categories, and persisted cache misses into IngredientCategory.
            # Re-read the cache so the sync and async paths share one code path.
            rows = db.query(IngredientCategory).filter(
                IngredientCategory.name.in_(unknowns)
            ).all()
            for row in rows:
                cached[row.name] = row.category
            print(f"{LOG} Queue classification complete", flush=True)
        else:
            print(f"{LOG} Queue classification failed or timed out — falling back to 'Other'", flush=True)

        # Anything still missing (timeout/failure/hook miss) falls back to "Other"
        for n in unknowns:
            if n not in cached:
                cached[n] = "Other"
    else:
        print(f"{LOG} All {len(unique_normalized)} ingredients found in cache — no queue call needed", flush=True)

    # Map original names back to categories
    result = {}
    for original_name in names:
        norm = normalized[original_name]
        result[original_name] = cached.get(norm, "Other")

    return result


class IngredientClassifierService(BaseLLMService):
    LOG_PREFIX = "[INGREDIENT_CLASSIFIER]"
    TASK_TYPE = "ingredient_classify"


def classify_prompt(ingredient_names: list[str]) -> tuple[str, GenerateContentConfig]:
    """Build the (prompt, config) pair for a batch ingredient-classify request."""
    prompt = f"""Classify each ingredient into exactly ONE grocery store aisle category.

Valid categories: {', '.join(sorted(VALID_CATEGORIES))}

Ingredients to classify:
{chr(10).join(f'- {name}' for name in ingredient_names)}

Return ONLY valid JSON — a single object mapping each ingredient name (exactly as given) to its category.
Example: {{"garlic": "Produce", "mozzarella": "Dairy", "soy sauce": "Pantry"}}"""

    config = GenerateContentConfig(
        response_mime_type="application/json",
        temperature=0.1,
    )
    return prompt, config
