"""
Leetcode router — CRUD + stats + AI advisor/hint chat for leetcode problem tracking.
"""

import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from ..database import get_db
from ..models import LeetcodeProblem, ChatMessage, LEETCODE_CATEGORIES
from ..schemas import (
    LeetcodeProblemCreate, LeetcodeProblemUpdate, LeetcodeProblemResponse,
    LeetcodeStatsResponse,
    UpNextRecommendation, UpNextResponse,
)
from ..data.neetcode150 import NEETCODE_150

router = APIRouter(prefix="/api/leetcode", tags=["leetcode"])

DIFFICULTY_ORDER = {"Easy": 0, "Medium": 1, "Hard": 2}


def parse_leetcode_url(url: str) -> tuple[Optional[str], Optional[int]]:
    """Extract problem name from a leetcode.com URL."""
    match = re.match(r'https?://leetcode\.com/problems/([^/]+)', url)
    if match:
        slug = match.group(1)
        name = slug.replace('-', ' ').title()
        return name, None  # Number requires API call; leave null
    return None, None


def _compute_streak(db: Session) -> int:
    """Compute consecutive days with at least one solved problem, counting back from today."""
    problems = (
        db.query(LeetcodeProblem)
        .filter(LeetcodeProblem.solved_at.isnot(None))
        .all()
    )
    if not problems:
        return 0

    # Get distinct dates (as date objects)
    solved_dates = set()
    for p in problems:
        if p.solved_at:
            solved_dates.add(p.solved_at.date())

    if not solved_dates:
        return 0

    today = datetime.utcnow().date()
    # Start from today (or yesterday if nothing solved today)
    check_date = today
    if check_date not in solved_dates:
        check_date = today - timedelta(days=1)
        if check_date not in solved_dates:
            return 0

    streak = 0
    while check_date in solved_dates:
        streak += 1
        check_date -= timedelta(days=1)

    return streak


# ==========================================
# Endpoints — /stats and /chat BEFORE /{id}
# ==========================================

@router.get("/stats", response_model=LeetcodeStatsResponse)
async def leetcode_stats(db: Session = Depends(get_db)):
    """Problem statistics with category/difficulty breakdowns and streak."""
    problems = db.query(LeetcodeProblem).all()

    total = len(problems)
    solved = sum(1 for p in problems if p.status == "solved")
    attempted = sum(1 for p in problems if p.status == "attempted")
    solved_solo = sum(1 for p in problems if p.solved_without_help)

    by_category: dict[str, dict[str, int]] = {}
    for p in problems:
        cat = p.category
        if cat not in by_category:
            by_category[cat] = {"total": 0, "solved": 0, "attempted": 0}
        by_category[cat]["total"] += 1
        if p.status == "solved":
            by_category[cat]["solved"] += 1
        elif p.status == "attempted":
            by_category[cat]["attempted"] += 1

    by_difficulty: dict[str, dict[str, int]] = {}
    for p in problems:
        diff = p.difficulty
        if diff not in by_difficulty:
            by_difficulty[diff] = {"total": 0, "solved": 0}
        by_difficulty[diff]["total"] += 1
        if p.status == "solved":
            by_difficulty[diff]["solved"] += 1

    streak = _compute_streak(db)

    return LeetcodeStatsResponse(
        total=total, solved=solved, attempted=attempted,
        solved_without_help=solved_solo,
        by_category=by_category, by_difficulty=by_difficulty,
        streak=streak,
    )


@router.post("/seed")
async def seed_neetcode150(db: Session = Depends(get_db)):
    """Bulk-import the NeetCode 150 problem set. Idempotent — safe to run multiple times."""
    created = 0
    updated = 0

    for entry in NEETCODE_150:
        # Match by number first, then case-insensitive name
        existing = None
        if entry["number"]:
            existing = db.query(LeetcodeProblem).filter(
                LeetcodeProblem.number == entry["number"]
            ).first()
        if not existing:
            existing = db.query(LeetcodeProblem).filter(
                LeetcodeProblem.name.ilike(entry["name"])
            ).first()

        if existing:
            existing.neetcode_order = entry["neetcode_order"]
            if not existing.url and entry.get("url"):
                existing.url = entry["url"]
            if not existing.number and entry.get("number"):
                existing.number = entry["number"]
            if not existing.category or existing.category not in LEETCODE_CATEGORIES:
                existing.category = entry["category"]
            if not existing.difficulty:
                existing.difficulty = entry["difficulty"]
            updated += 1
        else:
            problem = LeetcodeProblem(
                name=entry["name"],
                number=entry["number"],
                url=entry["url"],
                category=entry["category"],
                difficulty=entry["difficulty"],
                status="todo",
                neetcode_order=entry["neetcode_order"],
            )
            db.add(problem)
            created += 1

    db.commit()
    return {"seeded": created, "updated": updated}


@router.get("/up-next", response_model=UpNextResponse)
async def up_next(
    focus: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Algorithmic 'what to do next' — returns up to 3 recommendations."""
    nc_problems = (
        db.query(LeetcodeProblem)
        .filter(LeetcodeProblem.neetcode_order.isnot(None))
        .all()
    )

    unsolved = [p for p in nc_problems if p.status != "solved"]
    if not unsolved:
        return UpNextResponse(recommendations=[])

    def sort_key(p: LeetcodeProblem) -> tuple:
        """Sort: attempted before todo, then Easy>Med>Hard, then neetcode_order."""
        status_rank = 0 if p.status == "attempted" else 1
        diff_rank = DIFFICULTY_ORDER.get(p.difficulty, 99)
        return (status_rank, diff_rank, p.neetcode_order or 999)

    recommendations: list[UpNextRecommendation] = []
    seen_ids: set[int] = set()

    # 1. Focus pick
    if focus:
        focus_unsolved = [p for p in unsolved if p.category == focus]
        if focus_unsolved:
            pick = min(focus_unsolved, key=sort_key)
            recommendations.append(UpNextRecommendation(
                problem=LeetcodeProblemResponse.model_validate(pick),
                reason=f"Next in {focus} (your focus)",
            ))
            seen_ids.add(pick.id)

    # 2. Primary pick — first topic in LEETCODE_CATEGORIES order with unsolved problems
    for cat in LEETCODE_CATEGORIES:
        cat_unsolved = [p for p in unsolved if p.category == cat and p.id not in seen_ids]
        if cat_unsolved:
            pick = min(cat_unsolved, key=sort_key)
            recommendations.append(UpNextRecommendation(
                problem=LeetcodeProblemResponse.model_validate(pick),
                reason=f"Next in {cat}",
            ))
            seen_ids.add(pick.id)
            break

    # 3. Variety pick — weakest category (lowest solve %)
    cat_stats: dict[str, tuple[int, int]] = {}
    for p in nc_problems:
        s, t = cat_stats.get(p.category, (0, 0))
        cat_stats[p.category] = (s + (1 if p.status == "solved" else 0), t + 1)

    cat_order = {c: i for i, c in enumerate(LEETCODE_CATEGORIES)}
    sorted_cats = sorted(
        cat_stats.items(),
        key=lambda x: (x[1][0] / max(x[1][1], 1), cat_order.get(x[0], 99)),
    )

    for cat_name, (solved, total) in sorted_cats:
        if solved == total:
            continue
        cat_unsolved = [p for p in unsolved if p.category == cat_name and p.id not in seen_ids]
        if cat_unsolved:
            pick = min(cat_unsolved, key=sort_key)
            recommendations.append(UpNextRecommendation(
                problem=LeetcodeProblemResponse.model_validate(pick),
                reason=f"Weakest category: {cat_name} ({solved}/{total} solved)",
            ))
            seen_ids.add(pick.id)
            break

    return UpNextResponse(recommendations=recommendations)


@router.get("", response_model=list[LeetcodeProblemResponse])
async def list_problems(
    category: Optional[str] = Query(None),
    difficulty: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """List all problems with optional filters."""
    q = db.query(LeetcodeProblem)
    if category:
        q = q.filter(LeetcodeProblem.category == category)
    if difficulty:
        q = q.filter(LeetcodeProblem.difficulty == difficulty)
    if status:
        q = q.filter(LeetcodeProblem.status == status)
    problems = q.all()

    # Sort: category alphabetical, difficulty order, then name
    problems.sort(key=lambda p: (
        p.category,
        DIFFICULTY_ORDER.get(p.difficulty, 99),
        p.name,
    ))
    return problems


@router.get("/{problem_id}", response_model=LeetcodeProblemResponse)
async def get_problem(problem_id: int, db: Session = Depends(get_db)):
    """Get a single problem."""
    p = db.query(LeetcodeProblem).filter(LeetcodeProblem.id == problem_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Problem not found")
    return p


@router.post("", response_model=LeetcodeProblemResponse)
async def create_problem(data: LeetcodeProblemCreate, db: Session = Depends(get_db)):
    """Create a new problem. Auto-parses name from URL if provided."""
    name = data.name
    number = data.number

    # Auto-parse from URL if name is empty/generic
    if data.url and (not name or name.strip() == ""):
        parsed_name, parsed_number = parse_leetcode_url(data.url)
        if parsed_name:
            name = parsed_name
        if parsed_number and not number:
            number = parsed_number

    problem = LeetcodeProblem(
        name=name,
        number=number,
        url=data.url,
        category=data.category,
        difficulty=data.difficulty,
        status=data.status,
        solved_without_help=data.solved_without_help,
        notes=data.notes,
    )

    if data.status == "solved":
        problem.solved_at = datetime.utcnow()

    db.add(problem)
    db.commit()
    db.refresh(problem)
    return problem


@router.put("/{problem_id}", response_model=LeetcodeProblemResponse)
async def update_problem(problem_id: int, data: LeetcodeProblemUpdate, db: Session = Depends(get_db)):
    """Update a problem. Auto-manages solved_at on status transitions."""
    problem = db.query(LeetcodeProblem).filter(LeetcodeProblem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    old_status = problem.status

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(problem, key, value)

    # Auto-manage solved_at
    if data.status:
        if data.status == "solved" and old_status != "solved":
            problem.solved_at = datetime.utcnow()
        elif data.status != "solved" and old_status == "solved":
            problem.solved_at = None

    db.commit()
    db.refresh(problem)
    return problem


@router.delete("/{problem_id}")
async def delete_problem(problem_id: int, db: Session = Depends(get_db)):
    """Delete a problem."""
    problem = db.query(LeetcodeProblem).filter(LeetcodeProblem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")
    db.delete(problem)
    db.commit()
    return {"ok": True}


# ==========================================
# Leetcode Advisor / Hint Chat
# ==========================================

def _build_leetcode_context(db: Session) -> str:
    """Build plain-text context of all problems for the advisor."""
    problems = db.query(LeetcodeProblem).all()
    problems.sort(key=lambda p: (p.category, DIFFICULTY_ORDER.get(p.difficulty, 99), p.name))

    lines = [f"Leetcode Problems ({len(problems)} total):"]
    for p in problems:
        status_marker = {"todo": "[ ]", "attempted": "[~]", "solved": "[x]"}.get(p.status, "[ ]")
        solo = " (solo)" if p.solved_without_help else ""
        num = f" #{p.number}" if p.number else ""
        lines.append(f"  {status_marker} [id={p.id}] {p.name}{num} ({p.category}, {p.difficulty}){solo}")
    return "\n".join(lines)


def _build_problem_context(problem: LeetcodeProblem) -> str:
    """Build context for a specific problem in Learning Mode."""
    lines = [
        f"Problem: {problem.name}",
        f"Category: {problem.category}",
        f"Difficulty: {problem.difficulty}",
    ]
    if problem.number:
        lines.append(f"LeetCode #{problem.number}")
    if problem.url:
        lines.append(f"URL: {problem.url}")
    if problem.notes:
        lines.append(f"Student's notes: {problem.notes}")
    return "\n".join(lines)


def apply_leetcode_actions(db: Session, response_text: str) -> tuple[str, list[LeetcodeProblem]]:
    """Parse [ADD_PROBLEM] markers from a general-advisor response, create the
    corresponding LeetcodeProblem rows, commit, and return (markers-stripped
    text, created problems). General mode only — Learning Mode hints have no
    markers."""
    created_problems: list[LeetcodeProblem] = []
    add_pattern = r'\[ADD_PROBLEM:\s*([^\]]+)\]'
    kv_pattern = r'(\w+)="([^"]*)"'
    for match in re.finditer(add_pattern, response_text):
        kv_str = match.group(1)
        kvs = dict(re.findall(kv_pattern, kv_str))
        if "name" not in kvs:
            continue
        difficulty = kvs.get("difficulty", "Medium")
        if difficulty not in DIFFICULTY_ORDER:
            difficulty = "Medium"
        category = kvs.get("category", "Arrays & Hashing")

        problem = LeetcodeProblem(
            name=kvs["name"],
            number=int(kvs["number"]) if kvs.get("number", "").isdigit() else None,
            url=kvs.get("url"),
            category=category,
            difficulty=difficulty,
            status="todo",
        )
        db.add(problem)
        db.flush()
        db.refresh(problem)
        created_problems.append(problem)

    if created_problems:
        db.commit()

    # Strip markers
    response_text_clean = re.sub(add_pattern, '', response_text).strip()
    return response_text_clean, created_problems


@router.get("/chat/history")
async def leetcode_chat_history(
    limit: int = Query(50, ge=1, le=200),
    problem_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
):
    """Return chat history. If problem_id provided, return per-problem hint history."""
    context_key = f"leetcode:{problem_id}" if problem_id else "leetcode"
    msgs = (
        db.query(ChatMessage)
        .filter(ChatMessage.context == context_key)
        .order_by(desc(ChatMessage.id))
        .limit(limit)
        .all()
    )
    msgs.reverse()
    return [{"role": m.role, "content": m.content, "created_at": m.created_at} for m in msgs]
