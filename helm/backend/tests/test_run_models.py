"""RunDetail model + new WorkoutSession run columns."""
import pytest
from sqlalchemy.exc import IntegrityError

from backend.models import WorkoutSession, RunDetail


def _run_session(**kw):
    base = dict(google_id="gr1", date="2026-07-10", exercise_type="Run",
                exercise_type_raw="RUNNING", category="cardio",
                start_time="2026-07-10T18:04:00", end_time="2026-07-10T18:33:00",
                duration_min=28.7, avg_hr=152, source="google")
    base.update(kw)
    return WorkoutSession(**base)


def test_workout_session_run_columns_default_null(db):
    s = _run_session()
    db.add(s)
    db.commit()
    assert s.calories_kcal is None
    assert s.elevation_gain_m is None
    assert s.avg_cadence_spm is None
    assert s.avg_pace_s_per_km is None
    assert s.burn_applied is False


def test_run_detail_round_trip(db):
    s = _run_session()
    db.add(s)
    db.commit()
    rd = RunDetail(workout_session_id=s.id, route='[[37.77,-122.41]]',
                   splits='[{"distance_m":1000,"seconds":331}]', route_status="ok")
    db.add(rd)
    db.commit()
    got = db.query(RunDetail).filter(RunDetail.workout_session_id == s.id).one()
    assert got.route_status == "ok"
    assert got.fetched_at is not None


def test_run_detail_unique_per_session(db):
    s = _run_session()
    db.add(s)
    db.commit()
    db.add(RunDetail(workout_session_id=s.id, route_status="ok"))
    db.commit()
    db.add(RunDetail(workout_session_id=s.id, route_status="error"))
    with pytest.raises(IntegrityError):
        db.commit()
