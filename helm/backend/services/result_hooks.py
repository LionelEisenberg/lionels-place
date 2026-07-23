"""Post-result hooks — server-side actions to run when a queued LLM job succeeds.
Keyed by job.context. Invoked from the internal /result handler."""

import logging
logger = logging.getLogger(__name__)


def _save_advisor_reply(db, job) -> None:
    from ..models import ChatMessage
    if job.response_text:
        db.add(ChatMessage(role="assistant", content=job.response_text))
        db.commit()


def _apply_tasks(db, job) -> None:
    from ..routers.tasks import apply_task_actions
    if job.response_text:
        job.response_text = apply_task_actions(db, job.response_text)  # creates tasks + returns cleaned text
        db.commit()


def _apply_companies(db, job) -> None:
    from ..routers.companies import apply_company_actions
    if job.response_text:
        clean, _added, _updated, _removed_ids = apply_company_actions(db, job.response_text)
        job.response_text = clean  # mutates companies + returns cleaned text
        db.commit()


def _apply_applications(db, job) -> None:
    from ..routers.applications import apply_application_actions
    if job.response_text:
        clean, _created, _updated = apply_application_actions(db, job.response_text)
        job.response_text = clean  # mutates applications + returns cleaned text
        db.commit()


def _apply_leetcode(db, job) -> None:
    import json
    from ..models import ChatMessage
    from ..routers.leetcode import apply_leetcode_actions
    if job.response_text:
        # General mode may contain [ADD_PROBLEM] markers; Learning Mode hints never do
        # (apply_leetcode_actions is a safe no-op on plain hint text).
        clean, _created = apply_leetcode_actions(db, job.response_text)
        job.response_text = clean  # creates problems + returns cleaned text

        try:
            context_key = json.loads(job.request_payload or "{}").get("context_key", "leetcode")
        except (ValueError, TypeError):
            context_key = "leetcode"
        db.add(ChatMessage(role="assistant", content=clean, context=context_key))
        db.commit()


def _apply_company_research(db, job) -> None:
    """Company research has no markers — the job's JSON result IS the research
    payload. Persist it onto the researched Company (keyed by context_key, the
    company id stashed at enqueue) so the UI reflects it across reconnects."""
    import json
    from datetime import datetime
    from ..models import Company
    if not job.response_text:
        return
    try:
        company_id = int(json.loads(job.request_payload or "{}").get("context_key", ""))
    except (ValueError, TypeError):
        return
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        return
    company.market_info = job.response_text
    company.market_info_updated_at = datetime.now()
    db.commit()


def _apply_ingredient_classify(db, job) -> None:
    """Ingredient classify has no markers — the job's JSON result IS the payload,
    but it's keyed by NORMALIZED ingredient name (the prompt is built from
    normalized names so distinct original spellings can share one LLM lookup).
    Two things the sync path (classify_ingredients) does that the queue path
    must replicate:
      1. Persist cache misses into IngredientCategory (else every future request
         for the same ingredient re-enqueues instead of hitting the cache).
      2. Remap normalized-name keys back to the ORIGINAL names the frontend
         looks up by (RecipeBank.tsx keys `categories[ing.name]`)."""
    import json
    from ..models import IngredientCategory
    from .ingredient_classifier import VALID_CATEGORIES, normalize_name
    if not job.response_text:
        return
    try:
        classified: dict = json.loads(job.response_text)
    except (ValueError, TypeError):
        logger.warning("ingredient_classify job %s: response_text was not valid JSON", job.job_id)
        return
    if not isinstance(classified, dict):
        return

    # Result keys may already be normalized (classify_prompt sends normalized
    # unknowns) but re-normalize defensively in case the LLM echoes input verbatim.
    by_norm = {}
    for name, category in classified.items():
        norm = normalize_name(str(name))
        by_norm[norm] = category if category in VALID_CATEGORIES else "Other"

    # Persist cache misses (mirrors classify_ingredients' cache-write).
    saved = 0
    for norm, category in by_norm.items():
        existing = db.query(IngredientCategory).filter(IngredientCategory.name == norm).first()
        if not existing:
            db.add(IngredientCategory(name=norm, category=category))
            saved += 1
    if saved:
        db.commit()

    # Remap normalized keys -> original names via the context_key stashed at enqueue.
    try:
        original_names = json.loads(job.request_payload or "{}").get("context_key")
        original_names = json.loads(original_names) if original_names else []
    except (ValueError, TypeError):
        original_names = []

    if original_names:
        remapped = {name: by_norm.get(normalize_name(name), "Other") for name in original_names}
        job.response_text = json.dumps(remapped)
        db.commit()


_HOOKS = {
    "advisor_chat": _save_advisor_reply,
    "tasks_chat": _apply_tasks,
    "companies_chat": _apply_companies,
    "applications_chat": _apply_applications,
    "leetcode_chat": _apply_leetcode,
    "company_research": _apply_company_research,
    "ingredient_classify": _apply_ingredient_classify,
}


def run_hook(db, job) -> None:
    """Run the registered hook for job.context, if any. Never raises into the caller."""
    fn = _HOOKS.get(getattr(job, "context", None))
    if not fn:
        return
    try:
        fn(db, job)
    except Exception:  # noqa: BLE001
        logger.exception("result hook failed for job %s (context=%s)", job.job_id, job.context)
