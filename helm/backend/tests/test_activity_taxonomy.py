"""Activity taxonomy: the single vocabulary for the workout domain."""
from backend.services import activity_taxonomy as tax


def test_activity_of():
    assert tax.activity_of("Pool Swim") == "swim"
    assert tax.activity_of("Morning Run") == "run"
    assert tax.activity_of("Treadmill Jog") == "run"
    assert tax.activity_of("Peloton Bike") == "bike"
    assert tax.activity_of("Rowing Machine") == "row"
    assert tax.activity_of("Stair Master") == "stairs"
    assert tax.activity_of("Stairmaster") == "stairs"
    assert tax.activity_of("") == "cardio"
    assert tax.activity_of("Sled Push") == "sled push"   # unknown name falls through


def test_is_strength_member():
    assert tax.is_strength_member("Bench Press", "Upper Body")
    assert tax.is_strength_member("Backwards Walking", "Cardio")   # gym warmup rides with strength
    assert tax.is_strength_member("Incline Walk", "Cardio")
    assert not tax.is_strength_member("Stairmaster", "Cardio")
    assert not tax.is_strength_member("Pool Swim", "Cardio")
    assert not tax.is_strength_member("Morning Run", "Cardio")


def test_label_matches():
    assert tax.label_matches("Stair climber", tax.LABEL_RESERVED)
    assert not tax.label_matches("Weightlifting", tax.LABEL_RESERVED)
    assert not tax.label_matches(None, tax.LABEL_RESERVED)


def test_google_session_activity_label_beats_raw_type():
    # Fitbit exports the stair machine as generic WORKOUT with only a display label —
    # the label must win so it can never masquerade as the lift session.
    assert tax.google_session_activity("WORKOUT", "Stair climber") == "stairs"
    assert tax.google_session_activity("WORKOUT", "Weightlifting") == "strength"
    assert tax.google_session_activity("STRENGTH_TRAINING", None) == "strength"
    assert tax.google_session_activity("RUNNING", "Run") == "run"
    assert tax.google_session_activity("TREADMILL_RUNNING", None) == "run"
    assert tax.google_session_activity("SWIMMING_POOL", "Pool swim") == "swim"
    assert tax.google_session_activity("SPINNING", None) == "bike"
    assert tax.google_session_activity("WALKING", "Walk") == "cardio"   # unknown → other-cardio


def test_run_types_moved_here():
    assert tax.RUN_TYPES == {"RUNNING", "TREADMILL_RUNNING"}
    assert tax.RUN_TYPES == tax.ACTIVITY_GOOGLE_TYPES["run"]


def test_google_type_sets_are_disjoint():
    # google_session_activity's raw-type resolution is deterministic only because
    # no raw type appears in two activities' sets.
    all_types = [t for types in tax.ACTIVITY_GOOGLE_TYPES.values() for t in types]
    assert len(all_types) == len(set(all_types))
