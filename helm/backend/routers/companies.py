"""
Companies router — CRUD + AI research + chat advisor for job search target companies.
"""

import json
import os
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from ..database import get_db
from ..models import Company, ChatMessage
from ..schemas import CompanyCreate, CompanyUpdate, CompanyResponse

router = APIRouter(prefix="/api/companies", tags=["companies"])

TIER_ORDER = ["gaming_t1", "gaming_t2", "tech_t1", "tech_t2", "adjacent"]

# ==========================================
# Seed Data
# ==========================================

# Private, gitignored — a personal job-search target list. Not present in
# fresh/public deployments, which fall back to COMPANY_SEED_FALLBACK below.
_SEED_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "company_seed.json")

# Generic fallback used when no private seed file exists (fresh/public deployments).
COMPANY_SEED_FALLBACK: list[dict] = [
    {"name": "Example Corp", "tier": "tech_t1", "location": "Remote", "role_types": "Software Engineer", "notes": "Add your own targets in data/company_seed.json."},
    {"name": "Sample Studio", "tier": "gaming_t2", "location": "Remote", "role_types": "Software Engineer", "notes": ""},
]


def _load_company_seed() -> list[dict]:
    """Load the company seed list from the private JSON file if present, else the fallback."""
    if os.path.exists(_SEED_PATH):
        with open(_SEED_PATH, encoding="utf-8") as f:
            return json.load(f)
    return COMPANY_SEED_FALLBACK


def seed_companies(db: Session) -> None:
    """Populate companies table from the seed list if empty."""
    if db.query(Company).count() > 0:
        return
    for data in _load_company_seed():
        db.add(Company(**data))
    db.commit()


# ==========================================
# Endpoints
# ==========================================

@router.get("", response_model=list[CompanyResponse])
async def list_companies(db: Session = Depends(get_db)):
    """List all companies, ordered by tier then name."""
    companies = db.query(Company).all()
    companies.sort(key=lambda c: (TIER_ORDER.index(c.tier) if c.tier in TIER_ORDER else 99, c.name))
    return companies


@router.post("", response_model=CompanyResponse)
async def create_company(data: CompanyCreate, db: Session = Depends(get_db)):
    """Add a new target company."""
    company = Company(**data.model_dump())
    db.add(company)
    db.commit()
    db.refresh(company)
    return company


@router.put("/{company_id}", response_model=CompanyResponse)
async def update_company(company_id: int, data: CompanyUpdate, db: Session = Depends(get_db)):
    """Update a company's details."""
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(company, key, value)
    db.commit()
    db.refresh(company)
    return company


@router.delete("/{company_id}")
async def delete_company(company_id: int, db: Session = Depends(get_db)):
    """Remove a company from the list."""
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    db.delete(company)
    db.commit()
    return {"ok": True}


# ==========================================
# Company Advisor Chat
# ==========================================

VALID_TIERS = {"gaming_t1", "gaming_t2", "tech_t1", "tech_t2", "adjacent"}


def _build_company_context(db: Session) -> str:
    """Build plain-text context of all companies for the advisor."""
    companies = db.query(Company).all()
    companies.sort(key=lambda c: (TIER_ORDER.index(c.tier) if c.tier in TIER_ORDER else 99, c.name))

    lines = [f"Companies List ({len(companies)} total):"]
    for c in companies:
        parts = [f"  [id={c.id}] {c.name} (tier: {c.tier}"]
        if c.location:
            parts.append(f", location: {c.location}")
        if c.role_types:
            parts.append(f", roles: {c.role_types}")
        parts.append(")")
        if c.notes:
            parts.append(f" — {c.notes}")
        lines.append("".join(parts))
    return "\n".join(lines)


def apply_company_actions(db: Session, response_text: str) -> tuple[str, list[Company], list[Company], list[int]]:
    """Parse [ADD_COMPANY]/[UPDATE_COMPANY]/[REMOVE_COMPANY] markers from an
    advisor response, apply the corresponding Company mutations, commit, and
    return (markers-stripped text, added, updated, removed_ids)."""
    # Parse action markers
    added: list[Company] = []
    updated: list[Company] = []
    removed_ids: list[int] = []

    # [ADD_COMPANY: name="...", tier="...", ...]
    add_pattern = r'\[ADD_COMPANY:\s*([^\]]+)\]'
    kv_pattern = r'(\w+)="([^"]*)"'
    for match in re.finditer(add_pattern, response_text):
        kvs = dict(re.findall(kv_pattern, match.group(1)))
        if "name" not in kvs:
            continue
        tier = kvs.get("tier", "adjacent")
        if tier not in VALID_TIERS:
            tier = "adjacent"
        company = Company(
            name=kvs["name"],
            tier=tier,
            location=kvs.get("location"),
            role_types=kvs.get("role_types"),
            notes=kvs.get("notes"),
        )
        db.add(company)
        db.flush()
        db.refresh(company)
        added.append(company)

    # [UPDATE_COMPANY: id=5, tier="...", notes="...", ...]
    update_pattern = r'\[UPDATE_COMPANY:\s*([^\]]+)\]'
    for match in re.finditer(update_pattern, response_text):
        kv_str = match.group(1)
        kvs = dict(re.findall(kv_pattern, kv_str))
        # id can be bare (id=5) or quoted (id="5")
        id_match = re.search(r'id=(\d+)', kv_str)
        if not id_match:
            continue
        cid = int(id_match.group(1))
        company = db.query(Company).filter(Company.id == cid).first()
        if not company:
            continue
        if "tier" in kvs and kvs["tier"] in VALID_TIERS:
            company.tier = kvs["tier"]
        if "name" in kvs:
            company.name = kvs["name"]
        if "location" in kvs:
            company.location = kvs["location"]
        if "notes" in kvs:
            company.notes = kvs["notes"]
        if "role_types" in kvs:
            company.role_types = kvs["role_types"]
        db.flush()
        db.refresh(company)
        updated.append(company)

    # [REMOVE_COMPANY: id=5]
    remove_pattern = r'\[REMOVE_COMPANY:\s*id=(\d+)\s*\]'
    for match in re.finditer(remove_pattern, response_text):
        cid = int(match.group(1))
        company = db.query(Company).filter(Company.id == cid).first()
        if company:
            removed_ids.append(cid)
            db.delete(company)

    if added or updated or removed_ids:
        db.commit()

    # Strip markers from displayed response
    clean = response_text
    for pat in [add_pattern, update_pattern, r'\[REMOVE_COMPANY:\s*id=\d+\s*\]']:
        clean = re.sub(pat, '', clean)
    clean = clean.strip()
    return clean, added, updated, removed_ids


@router.get("/chat/history")
async def company_chat_history(
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Return recent company advisor chat messages."""
    msgs = (
        db.query(ChatMessage)
        .filter(ChatMessage.context == "companies")
        .order_by(desc(ChatMessage.id))
        .limit(limit)
        .all()
    )
    msgs.reverse()
    return [{"role": m.role, "content": m.content, "created_at": m.created_at} for m in msgs]
