"""Activity model: the spine of the workout domain."""
import pytest
from sqlalchemy.exc import IntegrityError

from backend.models import Activity, Workout, WorkoutSession


def test_activity_round_trip(db):
    a = Activity(date="2026-07-13", activity="strength")
    db.add(a)
    db.commit()
    got = db.query(Activity).one()
    assert got.activity == "strength" and got.label is None
    assert got.google_session_id is None and got.created_at is not None


def test_google_session_link_is_unique(db):
    s = WorkoutSession(google_id="g1", date="2026-07-13", exercise_type="Run",
                       exercise_type_raw="RUNNING", category="cardio",
                       start_time="2026-07-13T18:00:00", end_time="2026-07-13T18:30:00",
                       source="google")
    db.add(s)
    db.commit()
    db.add(Activity(date="2026-07-13", activity="run", google_session_id=s.id))
    db.commit()
    db.add(Activity(date="2026-07-13", activity="run", google_session_id=s.id))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_workout_activity_fk_nullable(db):
    w = Workout(date="2026-07-13", category="Upper Body", equipment_type="Barbell",
                exercise="Bench Press", weight_lbs="135", reps_sets="8, 8",
                notes="", targeted_muscle_group="Chest")
    db.add(w)
    db.commit()
    assert w.activity_id is None
    a = Activity(date="2026-07-13", activity="strength")
    db.add(a)
    db.commit()
    w.activity_id = a.id
    db.commit()
    assert db.query(Workout).one().activity_id == a.id


def test_activity_finalized_defaults_false(db):
    from backend.models import Activity
    a = Activity(date="2026-07-14", activity="run")
    db.add(a); db.commit(); db.refresh(a)
    assert a.finalized is False
