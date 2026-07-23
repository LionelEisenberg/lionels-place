"""Shopping list router — CRUD for shopping list items."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import ShoppingListItem, Recipe, RecipeIngredient, User
from ..schemas import ShoppingListItemCreate, ShoppingListItemUpdate, ShoppingListItemResponse
from ..services.ingredient_classifier import classify_ingredients, normalize_name
from ..dependencies import get_current_user

router = APIRouter(prefix="/api/shopping-list", tags=["shopping-list"])


@router.post("/classify/async")
def classify_names_async(body: dict, db: Session = Depends(get_db)):
    """Cache-first batch classify. Returns cached results immediately; if any
    names miss the cache, also enqueues a job (context='ingredient_classify')
    for the misses and returns its job_id so the caller can poll for the rest.

    The LLM returns categories keyed by NORMALIZED name; the '_apply_ingredient_classify'
    result hook remaps them back to the original names (via context_key) and writes
    cache-miss results into IngredientCategory, mirroring the sync path's cache-write."""
    import json
    from ..models import IngredientCategory
    from ..services.ingredient_classifier import IngredientClassifierService, classify_prompt

    names: list[str] = body.get("names", [])
    if not names:
        return {"cached": {}, "job_id": None}

    normalized = {name: normalize_name(name) for name in names}
    unique_normalized = set(normalized.values())

    cached_by_norm = {}
    if unique_normalized:
        rows = db.query(IngredientCategory).filter(
            IngredientCategory.name.in_(unique_normalized)
        ).all()
        for row in rows:
            cached_by_norm[row.name] = row.category

    cached = {name: cached_by_norm[norm] for name, norm in normalized.items() if norm in cached_by_norm}
    unknowns = sorted({norm for norm in unique_normalized if norm not in cached_by_norm and norm})

    job_id = None
    if unknowns:
        # original names whose normalized form is a cache miss — lets the result
        # hook remap the LLM's normalized-name keys back to original names.
        miss_originals = sorted({name for name, norm in normalized.items() if norm in unknowns})
        service = IngredientClassifierService()
        prompt, config = classify_prompt(unknowns)
        job_id = service._enqueue(
            contents=prompt, config=config, task_type="ingredient_classify",
            context="ingredient_classify", method="classify",
            context_key=json.dumps(miss_originals),
        )

    return {"cached": cached, "job_id": job_id}


@router.get("", response_model=list[ShoppingListItemResponse])
def list_items(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(ShoppingListItem).filter(
        ShoppingListItem.user_id == current_user.id
    ).order_by(
        ShoppingListItem.sort_order, ShoppingListItem.created_at
    ).all()


@router.post("", response_model=ShoppingListItemResponse)
def add_item(item: ShoppingListItemCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Auto-classify if no category provided (or default "Other")
    category = item.category
    if not category or category == "Other":
        classified = classify_ingredients([item.name], db)
        category = classified.get(item.name, "Other")

    row = ShoppingListItem(
        name=item.name, amount=item.amount, unit=item.unit, category=category,
        recipe_id=item.recipe_id, recipe_name=item.recipe_name, exotic=item.exotic,
        user_id=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.post("/from-recipe/{recipe_id}", response_model=list[ShoppingListItemResponse])
def add_from_recipe(recipe_id: int, scale: float = Query(1.0), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")

    ingredients = db.query(RecipeIngredient).filter(
        RecipeIngredient.recipe_id == recipe_id
    ).order_by(RecipeIngredient.sort_order).all()

    # Batch classify all ingredient names
    names = [ing.name for ing in ingredients]
    categories = classify_ingredients(names, db)

    items = []
    for ing in ingredients:
        row = ShoppingListItem(
            name=ing.name,
            amount=round(ing.amount * scale, 2) if ing.amount else None,
            unit=ing.unit,
            category=categories.get(ing.name, "Other"),
            recipe_id=recipe.id,
            recipe_name=recipe.name,
            exotic=ing.exotic,
            sort_order=ing.sort_order,
            user_id=current_user.id,
        )
        db.add(row)
        items.append(row)

    db.commit()
    for item in items:
        db.refresh(item)
    return items


@router.put("/{item_id}", response_model=ShoppingListItemResponse)
def update_item(item_id: int, update: ShoppingListItemUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    row = db.query(ShoppingListItem).filter(ShoppingListItem.id == item_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Item not found")
    if current_user.role != "admin" and row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Item not found")
    for field, value in update.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


# These MUST be before /{item_id} DELETE to avoid route conflict
@router.delete("/completed")
def clear_completed(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    count = db.query(ShoppingListItem).filter(
        ShoppingListItem.checked == True,
        ShoppingListItem.user_id == current_user.id,
    ).delete()
    db.commit()
    return {"deleted": count}


@router.delete("/all")
def clear_all(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    count = db.query(ShoppingListItem).filter(
        ShoppingListItem.user_id == current_user.id
    ).delete()
    db.commit()
    return {"deleted": count}


@router.delete("/{item_id}")
def delete_item(item_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    row = db.query(ShoppingListItem).filter(ShoppingListItem.id == item_id).first()
    if not row or (current_user.role != "admin" and row.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Item not found")
    db.delete(row)
    db.commit()
    return {"ok": True}
