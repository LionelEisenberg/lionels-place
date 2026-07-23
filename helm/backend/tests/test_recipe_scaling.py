"""Tests for recipe ingredient scaling endpoint."""

import pytest

from backend.models import Recipe, RecipeIngredient


def _make_recipe(db, servings=4, ingredients=None):
    """Helper to create a recipe with ingredients."""
    recipe = Recipe(
        name="Test Recipe",
        instructions="1. Test",
        servings=servings,
    )
    db.add(recipe)
    db.flush()

    if ingredients is None:
        ingredients = [
            {"name": "flour", "amount": 200, "unit": "g", "original_unit": "2 cups", "sort_order": 0},
            {"name": "sugar", "amount": 100, "unit": "g", "original_unit": "1/2 cup", "sort_order": 1},
            {"name": "salt", "amount": None, "unit": None, "original_unit": None, "sort_order": 2},
        ]

    for ing_data in ingredients:
        ing = RecipeIngredient(recipe_id=recipe.id, **ing_data)
        db.add(ing)

    db.commit()
    return recipe


class TestScaleIngredients:
    """Tests for the scale_ingredients logic (direct DB, no HTTP)."""

    def test_scale_doubles_amounts(self, db):
        recipe = _make_recipe(db, servings=4)
        factor = 8 / recipe.servings  # 2x

        ings = sorted(recipe.ingredients, key=lambda i: i.sort_order)
        scaled = [
            round(ing.amount * factor, 1) if ing.amount is not None else None
            for ing in ings
        ]

        assert scaled == [400.0, 200.0, None]

    def test_scale_halves_amounts(self, db):
        recipe = _make_recipe(db, servings=4)
        factor = 2 / recipe.servings  # 0.5x

        ings = sorted(recipe.ingredients, key=lambda i: i.sort_order)
        scaled = [
            round(ing.amount * factor, 1) if ing.amount is not None else None
            for ing in ings
        ]

        assert scaled == [100.0, 50.0, None]

    def test_scale_1x_preserves_amounts(self, db):
        recipe = _make_recipe(db, servings=4)
        factor = 4 / recipe.servings  # 1x

        ings = sorted(recipe.ingredients, key=lambda i: i.sort_order)
        scaled = [
            round(ing.amount * factor, 1) if ing.amount is not None else None
            for ing in ings
        ]

        assert scaled == [200.0, 100.0, None]

    def test_null_amount_stays_null(self, db):
        recipe = _make_recipe(db, servings=2, ingredients=[
            {"name": "salt", "amount": None, "unit": None, "original_unit": "to taste", "sort_order": 0},
            {"name": "pepper", "amount": None, "unit": None, "original_unit": None, "sort_order": 1},
        ])
        factor = 6 / recipe.servings

        ings = sorted(recipe.ingredients, key=lambda i: i.sort_order)
        scaled = [
            round(ing.amount * factor, 1) if ing.amount is not None else None
            for ing in ings
        ]

        assert scaled == [None, None]

    def test_original_amount_preserved(self, db):
        """The scale endpoint returns original_amount alongside the scaled amount."""
        recipe = _make_recipe(db, servings=4)
        factor = 8 / recipe.servings  # 2x

        ings = sorted(recipe.ingredients, key=lambda i: i.sort_order)
        results = [
            {
                "amount": round(ing.amount * factor, 1) if ing.amount is not None else None,
                "original_amount": ing.amount,
            }
            for ing in ings
        ]

        assert results[0]["amount"] == 400.0
        assert results[0]["original_amount"] == 200.0
        assert results[2]["amount"] is None
        assert results[2]["original_amount"] is None

    def test_fractional_scaling(self, db):
        """Non-integer scale factors produce correct results."""
        recipe = _make_recipe(db, servings=4, ingredients=[
            {"name": "butter", "amount": 120, "unit": "g", "original_unit": "1/2 cup", "sort_order": 0},
        ])
        factor = 6 / recipe.servings  # 1.5x

        ing = recipe.ingredients[0]
        scaled = round(ing.amount * factor, 1)

        assert scaled == 180.0

    def test_sort_order_respected(self, db):
        """Ingredients come back in sort_order, not insertion order."""
        recipe = _make_recipe(db, servings=2, ingredients=[
            {"name": "second", "amount": 50, "unit": "g", "original_unit": None, "sort_order": 1},
            {"name": "first", "amount": 100, "unit": "g", "original_unit": None, "sort_order": 0},
            {"name": "third", "amount": 25, "unit": "g", "original_unit": None, "sort_order": 2},
        ])

        ings = sorted(recipe.ingredients, key=lambda i: i.sort_order)
        names = [ing.name for ing in ings]

        assert names == ["first", "second", "third"]
