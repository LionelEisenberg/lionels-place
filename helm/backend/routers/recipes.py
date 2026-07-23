"""
Recipe Bank CRUD router — personal cookbook with ingredients, cook logs,
photo upload, ingredient scaling, and tag listing.
"""

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import desc
from sqlalchemy.orm import Session, joinedload

from ..database import DATA_DIR, get_db
from ..dependencies import get_current_user
from ..models import CookLog, CookLogPhoto, CookLogReaction, CookLogComment, Recipe, RecipeIngredient, User
from ..schemas import (
    RecipeCreate, RecipeUpdate, RecipeResponse, RecipeListResponse,
    RecipeIngredientCreate,
    CookLogCreate, CookLogUpdate, CookLogResponse,
    ScaledIngredientResponse,
    ParseUrlRequest, ParseTextRequest,
    FeedResponse, ReactionAggregate, CommentResponse,
    ReactionCreate, CommentCreate,
)

router = APIRouter(prefix="/api/recipes", tags=["recipes"])

# Photos stored on persistent L: drive, mounted at /app/photos
_PHOTOS_BASE = Path(os.getenv("HELM_PHOTOS_DIR", os.path.join(DATA_DIR, "photos_fallback")))
RECIPE_PHOTOS_DIR = _PHOTOS_BASE / "recipe_photos"
RECIPE_PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

COOKLOG_PHOTOS_DIR = _PHOTOS_BASE / "cooklog_photos"
COOKLOG_PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

NOTES_ONLY_FIELDS = {"notes"}

PRESET_EMOJIS = {"🔥", "😋", "👨‍🍳", "💯", "🤤", "👎"}


def _build_cook_log_response(log: CookLog, recipe_name: str | None = None) -> CookLogResponse:
    """Build a CookLogResponse with aggregated reactions and comments."""
    reaction_map: dict[str, list[str]] = {}
    for r in log.reactions:
        username = r.user.username if r.user else "Unknown"
        reaction_map.setdefault(r.emoji, []).append(username)
    reactions = [
        ReactionAggregate(emoji=emoji, count=len(users), users=users)
        for emoji, users in reaction_map.items()
    ]

    comments = [
        CommentResponse(
            id=c.id,
            text=c.text,
            username=c.user.username if c.user else None,
            created_at=c.created_at,
        )
        for c in sorted(log.comments, key=lambda c: c.created_at or datetime.min)
    ]

    return CookLogResponse(
        id=log.id,
        recipe_id=log.recipe_id,
        date=log.date,
        guests=log.guests,
        scale_factor=log.scale_factor,
        notes=log.notes,
        rating=log.rating,
        rating_comment=log.rating_comment,
        cooked_by=log.cooked_by,
        photo_filenames=log.photo_filenames,
        reactions=reactions,
        comments=comments,
        recipe_name=recipe_name,
        created_at=log.created_at,
    )


# ==========================================
# Recipe CRUD
# ==========================================

@router.get("", response_model=list[RecipeListResponse])
async def list_recipes(
    search: Optional[str] = None,
    tags: Optional[str] = None,
    min_rating: Optional[float] = None,
    sort_by: str = Query(default="created_at", pattern="^(name|rating|created_at|updated_at)$"),
    db: Session = Depends(get_db),
):
    """List all recipes with optional filtering and sorting."""
    query = db.query(Recipe).options(joinedload(Recipe.cook_logs).joinedload(CookLog.photos), joinedload(Recipe.user))

    if search:
        search_term = f"%{search}%"
        query = query.outerjoin(RecipeIngredient).filter(
            (Recipe.name.ilike(search_term)) |
            (Recipe.tags.ilike(search_term)) |
            (RecipeIngredient.name.ilike(search_term))
        ).distinct()

    if tags:
        for tag in tags.split(","):
            query = query.filter(Recipe.tags.ilike(f"%{tag.strip()}%"))

    sort_map = {
        "name": Recipe.name,
        "created_at": desc(Recipe.created_at),
        "updated_at": desc(Recipe.updated_at),
    }
    query = query.order_by(sort_map.get(sort_by, desc(Recipe.created_at)))

    recipes = query.all()

    # Filter by min_rating (computed from cook logs, can't do in SQL)
    if min_rating is not None:
        recipes = [r for r in recipes if r.rating is not None and r.rating >= min_rating]

    # Sort by rating in Python if requested (rating is now a computed property)
    if sort_by == "rating":
        recipes.sort(key=lambda r: (r.rating is not None, r.rating or 0), reverse=True)
    return [
        RecipeListResponse(
            id=r.id,
            name=r.name,
            rating=r.rating,
            tags=r.tags,
            servings=r.servings,
            prep_ahead=r.prep_ahead,
            image_filename=r.image_filename,
            created_at=r.created_at,
            updated_at=r.updated_at,
            added_by=r.added_by,
            cook_count=len(r.cook_logs),
            last_cooked=max((cl.date for cl in r.cook_logs), default=None) if r.cook_logs else None,
            cook_photos=[p.filename for cl in r.cook_logs for p in cl.photos],
        )
        for r in recipes
    ]


@router.get("/tags")
async def list_tags(db: Session = Depends(get_db)):
    """List all unique tags across recipes."""
    recipes = db.query(Recipe.tags).filter(Recipe.tags.isnot(None)).all()
    tag_set: set[str] = set()
    for (tags_str,) in recipes:
        for tag in tags_str.split(","):
            tag = tag.strip()
            if tag:
                tag_set.add(tag)
    return sorted(tag_set)


@router.get("/feed", response_model=FeedResponse)
async def get_feed(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Global cooking activity feed — all cook logs, newest first."""
    offset = (page - 1) * limit
    query = (
        db.query(CookLog)
        .options(
            joinedload(CookLog.user),
            joinedload(CookLog.recipe),
            joinedload(CookLog.photos),
            joinedload(CookLog.reactions).joinedload(CookLogReaction.user),
            joinedload(CookLog.comments).joinedload(CookLogComment.user),
        )
        .order_by(desc(CookLog.created_at))
    )
    # +1 to check if there are more
    logs = query.offset(offset).limit(limit + 1).all()
    has_more = len(logs) > limit
    logs = logs[:limit]

    items = [
        _build_cook_log_response(log, recipe_name=log.recipe.name if log.recipe else None)
        for log in logs
    ]
    return FeedResponse(items=items, has_more=has_more)


@router.get("/{recipe_id}", response_model=RecipeResponse)
async def get_recipe(recipe_id: int, db: Session = Depends(get_db)):
    """Get a single recipe with ingredients and cook logs."""
    recipe = (
        db.query(Recipe)
        .options(
            joinedload(Recipe.ingredients),
            joinedload(Recipe.cook_logs).joinedload(CookLog.user),
            joinedload(Recipe.cook_logs).joinedload(CookLog.photos),
            joinedload(Recipe.cook_logs).joinedload(CookLog.reactions).joinedload(CookLogReaction.user),
            joinedload(Recipe.cook_logs).joinedload(CookLog.comments).joinedload(CookLogComment.user),
            joinedload(Recipe.user),
        )
        .filter(Recipe.id == recipe_id)
        .first()
    )
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return RecipeResponse(
        id=recipe.id,
        name=recipe.name,
        source_url=recipe.source_url,
        instructions=recipe.instructions,
        notes=recipe.notes,
        rating=recipe.rating,
        servings=recipe.servings,
        feeds=recipe.feeds,
        prep_ahead=recipe.prep_ahead,
        tags=recipe.tags,
        image_filename=recipe.image_filename,
        created_at=recipe.created_at,
        updated_at=recipe.updated_at,
        added_by=recipe.user.username if recipe.user else None,
        ingredients=recipe.ingredients,
        cook_logs=[_build_cook_log_response(log) for log in recipe.cook_logs],
    )


@router.post("", response_model=RecipeResponse)
async def create_recipe(recipe_in: RecipeCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Create a new recipe with ingredients."""
    ingredients_data = recipe_in.ingredients
    recipe_dict = recipe_in.model_dump(exclude={"ingredients"})
    recipe = Recipe(**recipe_dict)
    recipe.user_id = current_user.id
    db.add(recipe)
    db.flush()

    for ing_data in ingredients_data:
        ingredient = RecipeIngredient(recipe_id=recipe.id, **ing_data.model_dump())
        db.add(ingredient)

    db.commit()
    db.refresh(recipe)
    return await get_recipe(recipe.id, db)


@router.put("/{recipe_id}", response_model=RecipeResponse)
async def update_recipe(recipe_id: int, recipe_in: RecipeUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Update a recipe. If ingredients are provided, they fully replace the existing list."""
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")

    update_data = recipe_in.model_dump(exclude_unset=True)

    # Ownership check: non-owner friends can only edit notes
    if current_user.role != "admin" and recipe.user_id != current_user.id:
        if update_data.keys() - NOTES_ONLY_FIELDS:
            raise HTTPException(status_code=403, detail="You can only edit your own recipes")

    ingredients_data = update_data.pop("ingredients", None)

    for key, value in update_data.items():
        setattr(recipe, key, value)

    if ingredients_data is not None:
        db.query(RecipeIngredient).filter(RecipeIngredient.recipe_id == recipe_id).delete()
        for ing_data in ingredients_data:
            ingredient = RecipeIngredient(
                recipe_id=recipe_id,
                **RecipeIngredientCreate(**ing_data).model_dump(),
            )
            db.add(ingredient)

    db.commit()
    return await get_recipe(recipe_id, db)


@router.delete("/{recipe_id}")
async def delete_recipe(recipe_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete a recipe and cascade to ingredients, cook logs, and photo."""
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")

    if current_user.role != "admin" and recipe.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own recipes")

    if recipe.image_filename:
        photo_path = RECIPE_PHOTOS_DIR / recipe.image_filename
        if photo_path.exists():
            photo_path.unlink()

    db.delete(recipe)
    db.commit()
    return {"status": "deleted", "id": recipe_id}


# ==========================================
# Recipe Photos
# ==========================================

@router.post("/{recipe_id}/photo")
async def upload_recipe_photo(
    recipe_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a hero image for a recipe."""
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")

    if current_user.role != "admin" and recipe.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only manage photos for your own recipes")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Allowed types: jpg, jpeg, png, webp")

    filename = f"recipe_{recipe_id}{ext}"
    file_path = RECIPE_PHOTOS_DIR / filename

    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    # Generate thumbnail
    from ..services.thumbnail import generate_thumbnail, get_thumbnail_path
    generate_thumbnail(file_path)

    if recipe.image_filename and recipe.image_filename != filename:
        old_path = RECIPE_PHOTOS_DIR / recipe.image_filename
        if old_path.exists():
            old_path.unlink()
        old_thumb = get_thumbnail_path(old_path)
        if old_thumb.exists():
            old_thumb.unlink()

    recipe.image_filename = filename
    db.commit()
    return {"ok": True, "filename": filename}


@router.get("/{recipe_id}/photo")
async def get_recipe_photo(recipe_id: int, thumb: bool = False, db: Session = Depends(get_db)):
    """Serve the recipe photo. Pass ?thumb=1 for a smaller thumbnail."""
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe or not recipe.image_filename:
        raise HTTPException(status_code=404, detail="Photo not found")
    file_path = RECIPE_PHOTOS_DIR / recipe.image_filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Photo file missing from disk")
    if thumb:
        from ..services.thumbnail import ensure_thumbnail
        thumb_path = ensure_thumbnail(file_path)
        if thumb_path.exists():
            return FileResponse(str(thumb_path), media_type="image/webp")
    return FileResponse(str(file_path))


@router.delete("/{recipe_id}/photo")
async def delete_recipe_photo(recipe_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete the recipe photo."""
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe or not recipe.image_filename:
        raise HTTPException(status_code=404, detail="Photo not found")

    if current_user.role != "admin" and recipe.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only manage photos for your own recipes")

    file_path = RECIPE_PHOTOS_DIR / recipe.image_filename
    if file_path.exists():
        file_path.unlink()
    from ..services.thumbnail import get_thumbnail_path
    thumb_path = get_thumbnail_path(file_path)
    if thumb_path.exists():
        thumb_path.unlink()
    recipe.image_filename = None
    db.commit()
    return {"ok": True}


# ==========================================
# Cook Logs
# ==========================================

@router.post("/{recipe_id}/cook", response_model=CookLogResponse)
async def create_cook_log(recipe_id: int, log_in: CookLogCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Log a new cook attempt."""
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    log = CookLog(recipe_id=recipe_id, **log_in.model_dump())
    log.user_id = current_user.id
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


@router.put("/{recipe_id}/cook/{cook_id}", response_model=CookLogResponse)
async def update_cook_log(recipe_id: int, cook_id: int, log_in: CookLogUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Update a cook log entry."""
    log = db.query(CookLog).filter(CookLog.id == cook_id, CookLog.recipe_id == recipe_id).first()
    if not log:
        raise HTTPException(status_code=404, detail="Cook log not found")

    if current_user.role != "admin" and log.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only edit your own cook logs")

    update_data = log_in.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(log, key, value)
    db.commit()
    db.refresh(log)
    return log


@router.delete("/{recipe_id}/cook/{cook_id}")
async def delete_cook_log(recipe_id: int, cook_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete a cook log entry."""
    log = db.query(CookLog).filter(CookLog.id == cook_id, CookLog.recipe_id == recipe_id).first()
    if not log:
        raise HTTPException(status_code=404, detail="Cook log not found")

    if current_user.role != "admin" and log.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own cook logs")

    # Delete associated photos from disk
    for photo in log.photos:
        photo_path = COOKLOG_PHOTOS_DIR / photo.filename
        if photo_path.exists():
            photo_path.unlink()

    db.delete(log)
    db.commit()
    return {"status": "deleted", "id": cook_id}


# ==========================================
# Cook Log Photos
# ==========================================

@router.post("/{recipe_id}/cook/{cook_id}/photos")
async def upload_cook_log_photo(
    recipe_id: int,
    cook_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a photo to a cook log. Multiple photos allowed."""
    log = db.query(CookLog).filter(CookLog.id == cook_id, CookLog.recipe_id == recipe_id).first()
    if not log:
        raise HTTPException(status_code=404, detail="Cook log not found")

    if current_user.role != "admin" and log.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only add photos to your own cook logs")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Allowed types: jpg, jpeg, png, webp")

    # Generate unique filename
    import uuid
    filename = f"cooklog_{cook_id}_{uuid.uuid4().hex[:8]}{ext}"
    file_path = COOKLOG_PHOTOS_DIR / filename

    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    # Generate thumbnail
    from ..services.thumbnail import generate_thumbnail
    generate_thumbnail(file_path)

    photo = CookLogPhoto(cook_log_id=cook_id, filename=filename)
    db.add(photo)
    db.commit()
    return {"ok": True, "filename": filename}


@router.get("/cook-photos/{filename}")
async def get_cook_log_photo(filename: str, thumb: bool = False):
    """Serve a cook log photo by filename. Pass ?thumb=1 for thumbnail."""
    file_path = COOKLOG_PHOTOS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Photo not found")
    if thumb:
        from ..services.thumbnail import ensure_thumbnail
        thumb_path = ensure_thumbnail(file_path)
        if thumb_path.exists():
            return FileResponse(str(thumb_path), media_type="image/webp")
    return FileResponse(str(file_path))


@router.delete("/{recipe_id}/cook/{cook_id}/photos/{filename}")
async def delete_cook_log_photo(
    recipe_id: int,
    cook_id: int,
    filename: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a specific cook log photo."""
    photo = db.query(CookLogPhoto).filter(
        CookLogPhoto.cook_log_id == cook_id,
        CookLogPhoto.filename == filename,
    ).first()
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")

    log = db.query(CookLog).filter(CookLog.id == cook_id).first()
    if current_user.role != "admin" and (not log or log.user_id != current_user.id):
        raise HTTPException(status_code=403, detail="You can only delete photos from your own cook logs")

    file_path = COOKLOG_PHOTOS_DIR / filename
    if file_path.exists():
        file_path.unlink()
    from ..services.thumbnail import get_thumbnail_path
    thumb_path = get_thumbnail_path(file_path)
    if thumb_path.exists():
        thumb_path.unlink()

    db.delete(photo)
    db.commit()
    return {"ok": True}


# ==========================================
# Thumbnail Backfill
# ==========================================

@router.post("/backfill-thumbnails")
async def backfill_thumbnails(current_user: User = Depends(get_current_user)):
    """Generate thumbnails for all existing photos that don't have one. Admin only."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    from ..services.thumbnail import generate_thumbnail, get_thumbnail_path
    generated = 0
    skipped = 0
    for photo_dir in [RECIPE_PHOTOS_DIR, COOKLOG_PHOTOS_DIR]:
        for f in photo_dir.iterdir():
            if f.suffix.lower() in ALLOWED_EXTENSIONS and "_thumb" not in f.stem:
                thumb = get_thumbnail_path(f)
                if thumb.exists():
                    skipped += 1
                else:
                    if generate_thumbnail(f):
                        generated += 1
    return {"generated": generated, "skipped": skipped}


# ==========================================
# Cook Log Reactions
# ==========================================

@router.post("/{recipe_id}/cook/{cook_id}/reactions", response_model=CookLogResponse)
async def toggle_reaction(
    recipe_id: int,
    cook_id: int,
    body: ReactionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Toggle an emoji reaction on a cook log. Adds if not exists, removes if exists."""
    if body.emoji not in PRESET_EMOJIS:
        raise HTTPException(status_code=400, detail=f"Emoji must be one of: {', '.join(PRESET_EMOJIS)}")

    log = (
        db.query(CookLog)
        .options(
            joinedload(CookLog.user),
            joinedload(CookLog.recipe),
            joinedload(CookLog.photos),
            joinedload(CookLog.reactions).joinedload(CookLogReaction.user),
            joinedload(CookLog.comments).joinedload(CookLogComment.user),
        )
        .filter(CookLog.id == cook_id, CookLog.recipe_id == recipe_id)
        .first()
    )
    if not log:
        raise HTTPException(status_code=404, detail="Cook log not found")

    existing = db.query(CookLogReaction).filter(
        CookLogReaction.cook_log_id == cook_id,
        CookLogReaction.user_id == current_user.id,
        CookLogReaction.emoji == body.emoji,
    ).first()

    if existing:
        db.delete(existing)
    else:
        db.add(CookLogReaction(cook_log_id=cook_id, user_id=current_user.id, emoji=body.emoji))
    db.commit()

    # Refresh to get updated reactions
    db.refresh(log)
    return _build_cook_log_response(log, recipe_name=log.recipe.name if log.recipe else None)


# ==========================================
# Cook Log Comments
# ==========================================

@router.post("/{recipe_id}/cook/{cook_id}/comments", response_model=CookLogResponse)
async def add_comment(
    recipe_id: int,
    cook_id: int,
    body: CommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a comment to a cook log."""
    log = (
        db.query(CookLog)
        .options(
            joinedload(CookLog.user),
            joinedload(CookLog.recipe),
            joinedload(CookLog.photos),
            joinedload(CookLog.reactions).joinedload(CookLogReaction.user),
            joinedload(CookLog.comments).joinedload(CookLogComment.user),
        )
        .filter(CookLog.id == cook_id, CookLog.recipe_id == recipe_id)
        .first()
    )
    if not log:
        raise HTTPException(status_code=404, detail="Cook log not found")

    comment = CookLogComment(cook_log_id=cook_id, user_id=current_user.id, text=body.text.strip())
    db.add(comment)
    db.commit()
    db.refresh(log)
    return _build_cook_log_response(log, recipe_name=log.recipe.name if log.recipe else None)


@router.delete("/{recipe_id}/cook/{cook_id}/comments/{comment_id}")
async def delete_comment(
    recipe_id: int,
    cook_id: int,
    comment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a comment. Owner or admin can delete."""
    comment = db.query(CookLogComment).filter(
        CookLogComment.id == comment_id,
        CookLogComment.cook_log_id == cook_id,
    ).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    if current_user.role != "admin" and comment.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own comments")

    db.delete(comment)
    db.commit()
    return {"status": "deleted", "id": comment_id}


# ==========================================
# Ingredient Scaling
# ==========================================

@router.get("/{recipe_id}/scale", response_model=list[ScaledIngredientResponse])
async def scale_ingredients(
    recipe_id: int,
    servings: int = Query(..., ge=1),
    db: Session = Depends(get_db),
):
    """Return ingredients scaled to the requested number of servings."""
    recipe = (
        db.query(Recipe)
        .options(joinedload(Recipe.ingredients))
        .filter(Recipe.id == recipe_id)
        .first()
    )
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    if not recipe.servings:
        raise HTTPException(status_code=400, detail="Recipe has no base servings set — scaling unavailable")

    factor = servings / recipe.servings
    return [
        ScaledIngredientResponse(
            name=ing.name,
            amount=round(ing.amount * factor, 1) if ing.amount is not None else None,
            unit=ing.unit,
            original_unit=ing.original_unit,
            category=ing.category,
            exotic=ing.exotic,
            sort_order=ing.sort_order,
            original_amount=ing.amount,
        )
        for ing in sorted(recipe.ingredients, key=lambda i: i.sort_order)
    ]


# ==========================================
# AI URL Import
# ==========================================

