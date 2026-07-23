"""Tests for cook feed models — reactions, comments, cascade behavior."""

import pytest
from sqlalchemy.exc import IntegrityError

from backend.models import User, Recipe, CookLog, CookLogReaction, CookLogComment


def _make_user(db, username="testuser", role="admin"):
    u = User(jellyfin_id=f"jf-{username}", username=username, role=role)
    db.add(u)
    db.flush()
    return u


def _make_recipe(db, user, name="Test Recipe"):
    r = Recipe(name=name, instructions="Do the thing", user_id=user.id)
    db.add(r)
    db.flush()
    return r


def _make_cook_log(db, recipe, user, notes="Tasty"):
    cl = CookLog(recipe_id=recipe.id, date="2026-03-31", user_id=user.id, notes=notes)
    db.add(cl)
    db.flush()
    return cl


def test_reaction_unique_constraint(db):
    user = _make_user(db)
    recipe = _make_recipe(db, user)
    log = _make_cook_log(db, recipe, user)

    r1 = CookLogReaction(cook_log_id=log.id, user_id=user.id, emoji="🔥")
    db.add(r1)
    db.flush()

    r2 = CookLogReaction(cook_log_id=log.id, user_id=user.id, emoji="🔥")
    db.add(r2)
    with pytest.raises(IntegrityError):
        db.flush()


def test_reaction_different_emojis_same_user(db):
    user = _make_user(db)
    recipe = _make_recipe(db, user)
    log = _make_cook_log(db, recipe, user)

    db.add(CookLogReaction(cook_log_id=log.id, user_id=user.id, emoji="🔥"))
    db.add(CookLogReaction(cook_log_id=log.id, user_id=user.id, emoji="😋"))
    db.flush()

    assert len(log.reactions) == 2


def test_comment_creation(db):
    user = _make_user(db)
    recipe = _make_recipe(db, user)
    log = _make_cook_log(db, recipe, user)

    c = CookLogComment(cook_log_id=log.id, user_id=user.id, text="Looks great!")
    db.add(c)
    db.flush()

    assert log.comments[0].text == "Looks great!"
    assert log.comments[0].user.username == "testuser"


def test_cook_log_cascade_deletes_reactions_and_comments(db):
    user = _make_user(db)
    recipe = _make_recipe(db, user)
    log = _make_cook_log(db, recipe, user)

    db.add(CookLogReaction(cook_log_id=log.id, user_id=user.id, emoji="🔥"))
    db.add(CookLogComment(cook_log_id=log.id, user_id=user.id, text="Nice"))
    db.flush()

    db.delete(log)
    db.flush()

    assert db.query(CookLogReaction).count() == 0
    assert db.query(CookLogComment).count() == 0


def test_cook_log_reaction_user_set_null(db):
    user = _make_user(db)
    recipe = _make_recipe(db, user)
    log = _make_cook_log(db, recipe, user)

    db.add(CookLogReaction(cook_log_id=log.id, user_id=user.id, emoji="🔥"))
    db.flush()

    # Delete the user — reaction should remain with user_id=NULL
    db.delete(user)
    db.flush()

    reaction = db.query(CookLogReaction).first()
    assert reaction is not None
    assert reaction.user_id is None
