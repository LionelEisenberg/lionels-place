"""
Async jobs router — fire-and-forget LLM endpoints with polling.

Wraps parse, parse/continue, advisor/chat, and advisor/plan-workout so the
client can submit a request, get a job_id immediately, and poll for the result.
This prevents network errors (and Cloudflare 524 origin timeouts) when an LLM
call runs long or the user locks their phone / switches tabs mid-request.
"""

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..schemas import (
    AsyncJobSubmitResponse, AsyncJobStatusResponse,
    ParseRequest, ContinueRequest, AdvisorChatRequest, WorkoutPlanRequest,
    TaskAdvisorChatRequest, CompanyAdvisorChatRequest, ApplicationAdvisorChatRequest,
    LeetcodeAdvisorChatRequest, ParseUrlRequest, ParseTextRequest,
)

router = APIRouter(prefix="/api", tags=["async-jobs"])


# ==========================================
# Async submit endpoints
# ==========================================

@router.post("/parse/async", response_model=AsyncJobSubmitResponse)
def parse_async(req: ParseRequest, db: Session = Depends(get_db)):
    """Submit a parse request to the LLM queue."""
    import base64
    from .parse import _build_context, _today_str
    from ..services.advisor_service import GeminiAdvisor
    advisor = GeminiAdvisor()
    img = base64.b64decode(req.image_base64) if req.image_base64 else None
    contents, config = advisor.parse_input_prompt(req.message, context=_build_context(db),
                                                  current_date=req.date or _today_str(), image_bytes=img)
    job_id = advisor._enqueue(contents=contents, config=config, task_type="parse_input", context="dashboard_parse", method="parse_input")
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/parse/continue/async", response_model=AsyncJobSubmitResponse)
def continue_async(req: ContinueRequest, db: Session = Depends(get_db)):
    """Submit a continue request to the LLM queue."""
    from .parse import _build_context
    from ..services.advisor_service import GeminiAdvisor
    advisor = GeminiAdvisor()
    context = _build_context(db)

    staged_text = ""
    if req.pending_intents:
        staged_items = []
        for intent in req.pending_intents:
            if intent.type == "meal" and intent.meal_data:
                staged_items.append(
                    f"[STAGED MEAL] {intent.meal_data.description}: "
                    f"{intent.meal_data.calories} cal"
                )
            elif intent.type == "workout" and intent.workout_data:
                for ex in intent.workout_data.exercises:
                    staged_items.append(f"[STAGED EXERCISE] {ex.exercise}: W:{ex.weight_lbs} R:{ex.reps_sets}")
        staged_text = "\n--- CURRENTLY STAGED ---\n" + "\n".join(staged_items) + "\n--- END STAGED ---\n"

    full_context = context + "\n" + staged_text if staged_text else context
    message = f"The user wants to add to their current staging. Their follow-up: {req.message}"

    contents, config = advisor.parse_input_prompt(message, context=full_context)
    job_id = advisor._enqueue(contents=contents, config=config, task_type="parse_input", context="dashboard_parse", method="parse_input")
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/advisor/chat/async", response_model=AsyncJobSubmitResponse)
def advisor_chat_async(req: AdvisorChatRequest, db: Session = Depends(get_db)):
    """Submit an advisor chat request to the LLM queue."""
    from sqlalchemy import desc
    from ..models import ChatMessage, DailySummary
    from ..services.advisor_service import GeminiAdvisor
    advisor = GeminiAdvisor()
    recent = db.query(DailySummary).order_by(desc(DailySummary.date)).limit(7).all()
    context = GeminiAdvisor.build_daily_context(recent, db=db)
    db.add(ChatMessage(role="user", content=req.message)); db.commit()
    prompt, config = advisor.chat_prompt(req.message, context=context)
    job_id = advisor._enqueue(contents=prompt, config=config, task_type="chat", context="advisor_chat", method="chat")
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/advisor/plan-workout/async", response_model=AsyncJobSubmitResponse)
def plan_workout_async(req: WorkoutPlanRequest, db: Session = Depends(get_db)):
    """Submit a workout-plan request to the LLM queue."""
    from sqlalchemy import desc
    from ..models import Workout
    from ..services.advisor_service import GeminiAdvisor
    from ..services.base_llm import BaseLLMService
    advisor = GeminiAdvisor()
    recent = db.query(Workout).order_by(desc(Workout.date), desc(Workout.id)).limit(80).all()
    prompt, config = advisor.plan_workout_prompt(
        recent_exercises_text=GeminiAdvisor.build_workout_context(recent),
        day_type=req.day_type or "", notes=req.notes,
    )
    job_id = advisor._enqueue(contents=prompt, config=config, task_type="plan_workout", context="workout_log", method="plan_workout")
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/tasks/chat/async", response_model=AsyncJobSubmitResponse)
def tasks_chat_async(req: TaskAdvisorChatRequest, db: Session = Depends(get_db)):
    """Submit a task-advisor chat request to the LLM queue."""
    from .tasks import _build_task_context
    from ..services.task_advisor_service import TaskAdvisorService
    advisor = TaskAdvisorService()
    task_context, today = _build_task_context(db)
    prompt, config = advisor.chat_prompt(req.message, task_context, today)
    job_id = advisor._enqueue(contents=prompt, config=config, task_type="chat", context="tasks_chat", method="tasks_chat")
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/companies/chat/async", response_model=AsyncJobSubmitResponse)
def companies_chat_async(req: CompanyAdvisorChatRequest, db: Session = Depends(get_db)):
    """Submit a company-advisor chat request to the LLM queue."""
    from datetime import datetime as _datetime
    from .companies import _build_company_context
    from ..services.company_research_service import CompanyResearchService
    advisor = CompanyResearchService()
    company_context = _build_company_context(db)
    today = _datetime.utcnow().date().isoformat()
    prompt, config = advisor.chat_prompt(req.message, company_context, today)
    job_id = advisor._enqueue(contents=prompt, config=config, task_type="chat", context="companies_chat", method="companies_chat")
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/applications/chat/async", response_model=AsyncJobSubmitResponse)
def applications_chat_async(req: ApplicationAdvisorChatRequest, db: Session = Depends(get_db)):
    """Submit an application-advisor chat request to the LLM queue."""
    from datetime import datetime as _datetime
    from .applications import _build_application_context, _build_company_list_context
    from ..services.application_service import ApplicationAdvisorService
    advisor = ApplicationAdvisorService()
    app_context = _build_application_context(db)
    company_context = _build_company_list_context(db)
    today = _datetime.utcnow().date().isoformat()
    prompt, config = advisor.chat_prompt(req.message, app_context, company_context, today)
    job_id = advisor._enqueue(contents=prompt, config=config, task_type="chat", context="applications_chat", method="applications_chat")
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/leetcode/chat/async", response_model=AsyncJobSubmitResponse)
def leetcode_chat_async(req: LeetcodeAdvisorChatRequest, db: Session = Depends(get_db)):
    """Submit a leetcode-advisor chat request (general or Learning Mode hint) to the LLM queue."""
    from datetime import datetime as _datetime
    from ..models import LeetcodeProblem, ChatMessage
    from .leetcode import _build_leetcode_context, _build_problem_context
    from ..services.leetcode_service import LeetcodeAdvisorService

    advisor = LeetcodeAdvisorService()
    is_learning_mode = req.problem_id is not None
    context_key = f"leetcode:{req.problem_id}" if is_learning_mode else "leetcode"

    if is_learning_mode:
        problem = db.query(LeetcodeProblem).filter(LeetcodeProblem.id == req.problem_id).first()
        if not problem:
            raise HTTPException(status_code=404, detail="Problem not found")
        problem_context = _build_problem_context(problem)
        history = (
            db.query(ChatMessage)
            .filter(ChatMessage.context == context_key)
            .order_by(ChatMessage.id)
            .limit(20)
            .all()
        )
        history_text = "\n".join([f"{m.role}: {m.content}" for m in history])
        prompt, config = advisor.hint_chat_prompt(req.message, problem_context, history_text)
    else:
        lc_context = _build_leetcode_context(db)
        today = _datetime.utcnow().date().isoformat()
        prompt, config = advisor.chat_prompt(req.message, lc_context, today)

    db.add(ChatMessage(role="user", content=req.message, context=context_key)); db.commit()
    job_id = advisor._enqueue(
        contents=prompt, config=config, task_type="leetcode_hint" if is_learning_mode else "chat",
        context="leetcode_chat", method="leetcode_chat", context_key=context_key,
    )
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/recipes/parse-url/async", response_model=AsyncJobSubmitResponse)
def recipe_parse_url_async(req: ParseUrlRequest, db: Session = Depends(get_db)):
    """Fetch the recipe URL server-side, then enqueue the extraction prompt."""
    import re as _re
    from fastapi import HTTPException as _HTTPException
    from ..services.recipe_parser import RecipeParserService

    url = req.url.strip()
    if not _re.match(r"https?://", url):
        raise _HTTPException(status_code=400, detail="Invalid URL format")

    parser = RecipeParserService()
    try:
        page_text = parser._fetch_page(url)
    except Exception as e:
        raise _HTTPException(status_code=400, detail=f"Failed to fetch URL: {e}")

    prompt, config = parser.parse_url_prompt(url, page_text, instructions=req.instructions)
    job_id = parser._enqueue(contents=prompt, config=config, task_type="recipe_parse", context="recipe_parse", method="parse_url")
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/recipes/parse-text/async", response_model=AsyncJobSubmitResponse)
def recipe_parse_text_async(req: ParseTextRequest, db: Session = Depends(get_db)):
    """Submit a pasted-text recipe parse to the LLM queue."""
    from fastapi import HTTPException as _HTTPException
    from ..services.recipe_parser import RecipeParserService

    text = req.text.strip()
    if len(text) < 20:
        raise _HTTPException(status_code=400, detail="Text too short to extract a recipe from")

    parser = RecipeParserService()
    prompt, config = parser.parse_text_prompt(text, instructions=req.instructions)
    job_id = parser._enqueue(contents=prompt, config=config, task_type="recipe_parse", context="recipe_parse", method="parse_text")
    return AsyncJobSubmitResponse(job_id=job_id)


@router.post("/companies/{company_id}/research/async", response_model=AsyncJobSubmitResponse)
def company_research_async(company_id: int, db: Session = Depends(get_db)):
    """Submit a company-research request to the LLM queue."""
    from fastapi import HTTPException as _HTTPException
    from ..models import Company
    from ..services.company_research_service import CompanyResearchService

    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise _HTTPException(status_code=404, detail="Company not found")

    service = CompanyResearchService()
    prompt, config = service.research_prompt(
        name=company.name,
        tier=company.tier,
        location=company.location or "",
        role_types=company.role_types or "",
        notes=company.notes or "",
    )
    job_id = service._enqueue(
        contents=prompt, config=config, task_type="company_research",
        context="company_research", method="research_company",
        context_key=str(company_id),
    )
    return AsyncJobSubmitResponse(job_id=job_id)


# ==========================================
# Polling endpoint
# ==========================================

_LLM_STATUS = {"queued": "pending", "running": "processing", "succeeded": "completed", "failed": "failed"}


def _build_parse_result(job) -> dict:
    """Shape a completed parse job's response_text into a ParseResponse dict."""
    import json
    from ..schemas import ParseResponse
    from ..services.confidence import compute_meal_confidence
    try:
        parsed = json.loads(job.response_text or "{}")
    except json.JSONDecodeError:
        return ParseResponse(advice_response=job.response_text or "Failed to parse").model_dump()
    _CONF = {"high": 0.8, "medium": 0.5, "low": 0.3}
    for it in parsed.get("intents", []):
        if isinstance(it.get("confidence"), str):
            it["confidence"] = _CONF.get(it["confidence"], 0.7)
    resp = ParseResponse(**parsed)
    resp.request_log_id = job.job_id
    for intent in resp.intents:
        if intent.type == "meal" and intent.meal_data and intent.meal_data.items:
            intent.confidence = compute_meal_confidence(intent.meal_data.items)
    return resp.model_dump()


@router.get("/jobs/{job_id}", response_model=AsyncJobStatusResponse)
def get_job_status(job_id: str, db: Session = Depends(get_db)):
    """Poll for async job result."""
    from ..services import job_queue
    lj = job_queue.get_job(db, job_id)
    if lj is not None:
        result = None
        if lj.status == "succeeded" and lj.response_text:
            if lj.task_type == "parse_input":
                result = _build_parse_result(lj)
            else:
                try:
                    result = json.loads(lj.response_text)
                except json.JSONDecodeError:
                    result = {"response": lj.response_text}
        from ..routers.llm_jobs import _last_error
        return AsyncJobStatusResponse(job_id=lj.job_id, status=_LLM_STATUS.get(lj.status, lj.status),
                                      result=result, error=_last_error(lj))
    raise HTTPException(status_code=404, detail="Job not found")
