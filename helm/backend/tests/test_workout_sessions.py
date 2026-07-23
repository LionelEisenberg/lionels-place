"""Google exercise-session ingestion: parsing, upsert, HR slicing, ingest, endpoints.

Payloads mirror the live Google Health API `exercise` data type (pinned via a
read-only discovery dump from the connected Fitbit account).
"""
from datetime import date

from backend.services import google_health_service as ghs


# --------------------------------------------------------------------------- helpers
def test_parse_seconds():
    assert ghs._parse_seconds("4174.615s") == 4174.615
    assert ghs._parse_seconds("1260s") == 1260.0
    assert ghs._parse_seconds(None) is None
    assert ghs._parse_seconds("") is None


# Real-shaped data points (trimmed of fields we don't consume).
_STRENGTH = {
    "name": "users/8040271502745719769/dataTypes/exercise/dataPoints/83544448949145416",
    "exercise": {
        "interval": {
            "startTime": "2026-06-17T21:48:44Z", "startUtcOffset": "-25200s",
            "endTime": "2026-06-17T22:58:19Z", "endUtcOffset": "-25200s",
        },
        "exerciseType": "WORKOUT",
        "metricsSummary": {"caloriesKcal": 516, "averageHeartRateBeatsPerMinute": "119"},
        "displayName": "Weightlifting",
        "activeDuration": "4174.615s",
    },
}

_SWIM = {
    "name": "users/x/dataTypes/exercise/dataPoints/swim1",
    "exercise": {
        "interval": {
            "startTime": "2026-06-17T23:00:00Z", "startUtcOffset": "-25200s",
            "endTime": "2026-06-17T23:21:00Z", "endUtcOffset": "-25200s",
        },
        "exerciseType": "SWIMMING_POOL",
        "metricsSummary": {
            "caloriesKcal": 231, "distanceMillimeters": 750000000,
            "averageHeartRateBeatsPerMinute": "133", "totalSwimLengths": 0,
        },
        "displayName": "Pool swim",
        "activeDuration": "1260s",
    },
}

_WALK = {
    "name": "users/x/dataTypes/exercise/dataPoints/walk1",
    "exercise": {
        "interval": {
            "startTime": "2026-06-15T22:36:02.158Z", "startUtcOffset": "-25200s",
            "endTime": "2026-06-15T23:05:04.147Z", "endUtcOffset": "-25200s",
        },
        "exerciseType": "WALKING",
        "metricsSummary": {
            "caloriesKcal": 214, "distanceMillimeters": 1766600,
            "averageHeartRateBeatsPerMinute": "101",
        },
        "displayName": "Walk",
        "activeDuration": "1741.989s",
    },
}

_EBIKE = {
    "name": "users/x/dataTypes/exercise/dataPoints/eb1",
    "exercise": {
        "interval": {
            "startTime": "2026-06-17T23:50:03.967Z", "startUtcOffset": "-25200s",
            "endTime": "2026-06-18T00:09:53.288Z", "endUtcOffset": "-25200s",
        },
        "exerciseType": "ELECTRIC_BIKE",
        "metricsSummary": {"caloriesKcal": 114, "averageHeartRateBeatsPerMinute": "116"},
        "displayName": "Electric bike",
        "activeDuration": "1189.321s",
    },
}


def test_parse_strength_session():
    p = ghs._parse_exercise_session(_STRENGTH)
    assert p["google_id"] == "users/8040271502745719769/dataTypes/exercise/dataPoints/83544448949145416"
    assert p["exercise_type_raw"] == "WORKOUT"
    assert p["exercise_type"] == "Weightlifting"      # displayName wins
    assert p["category"] == "strength"
    assert p["date"] == "2026-06-17"                   # local (21:48Z - 7h = 14:48)
    assert p["start_time"] == "2026-06-17T14:48:44"
    assert p["end_time"] == "2026-06-17T15:58:19"
    assert p["duration_min"] == 69.58                  # 4174.615s / 60
    assert p["distance_m"] is None                     # strength: never distance
    assert p["avg_hr"] == 119
    assert p["max_hr"] is None                          # derived at read time, not from Google
    assert p["start_utc"] == "2026-06-17T21:48:44Z"     # raw UTC kept for windowed HR fetch
    assert p["end_utc"] == "2026-06-17T22:58:19Z"


def test_parse_swim_excludes_garbage_distance():
    p = ghs._parse_exercise_session(_SWIM)
    assert p["category"] == "cardio"
    assert p["exercise_type"] == "Pool swim"
    assert p["avg_hr"] == 133
    assert p["duration_min"] == 21.0
    # Fitbit pool-swim distance is unreliable (needs pool length); excluded.
    assert p["distance_m"] is None


def test_parse_walk_keeps_distance_in_meters():
    p = ghs._parse_exercise_session(_WALK)
    assert p["category"] == "cardio"
    assert p["distance_m"] == 1766.6                    # 1766600 mm / 1000
    assert p["avg_hr"] == 101
    assert p["start_time"] == "2026-06-15T15:36:02"     # microseconds truncated


def test_parse_skips_ebike():
    assert ghs._parse_exercise_session(_EBIKE) is None


def test_parse_local_date_across_utc_midnight():
    point = {
        "name": "users/x/dataTypes/exercise/dataPoints/late",
        "exercise": {
            "interval": {
                "startTime": "2026-06-18T04:00:00Z", "startUtcOffset": "-25200s",
                "endTime": "2026-06-18T04:45:00Z", "endUtcOffset": "-25200s",
            },
            "exerciseType": "RUNNING", "displayName": "Run",
            "metricsSummary": {"averageHeartRateBeatsPerMinute": "150"},
            "activeDuration": "2700s",
        },
    }
    p = ghs._parse_exercise_session(point)
    assert p["date"] == "2026-06-17"                    # 04:00Z - 7h = 21:00 prev local day
    assert p["start_time"] == "2026-06-17T21:00:00"


def test_parse_unknown_type_defaults_to_other():
    point = {
        "name": "users/x/dataTypes/exercise/dataPoints/u1",
        "exercise": {
            "interval": {
                "startTime": "2026-06-15T20:00:00Z", "startUtcOffset": "-25200s",
                "endTime": "2026-06-15T20:30:00Z", "endUtcOffset": "-25200s",
            },
            "exerciseType": "UNICYCLING",
            "metricsSummary": {"distanceMillimeters": 5000000},
            "activeDuration": "1800s",
        },
    }
    p = ghs._parse_exercise_session(point)
    assert p["category"] == "other"
    assert p["exercise_type"] == "Unicycling"          # title-cased fallback (no displayName)
    assert p["distance_m"] is None                      # distance only for non-swim cardio


# ------------------------------------------------------------------------- upsert
from backend.models import WorkoutSession


def _row(**over):
    base = {
        "google_id": "gid-1", "date": "2026-06-17", "exercise_type": "Weightlifting",
        "exercise_type_raw": "WORKOUT", "category": "strength",
        "start_time": "2026-06-17T14:48:44", "end_time": "2026-06-17T15:58:19",
        "duration_min": 69.58, "distance_m": None, "avg_hr": 119, "max_hr": None,
    }
    base.update(over)
    return base


def test_upsert_workout_session_idempotent(db):
    ghs._upsert_workout_session(db, _row())
    ghs._upsert_workout_session(db, _row(avg_hr=120, exercise_type="Weights"))
    rows = db.query(WorkoutSession).filter_by(google_id="gid-1").all()
    assert len(rows) == 1                                # same datapoint id → updated, not duplicated
    assert rows[0].avg_hr == 120 and rows[0].exercise_type == "Weights"


def test_upsert_workout_session_fallback_composite_key(db):
    # No stable google_id → identity falls back to (date, type, start_time).
    ghs._upsert_workout_session(db, _row(google_id=None))
    ghs._upsert_workout_session(db, _row(google_id=None, distance_m=5.0))
    rows = db.query(WorkoutSession).filter_by(date="2026-06-17").all()
    assert len(rows) == 1
    assert rows[0].distance_m == 5.0


# ----------------------------------------------------------------- HR window slice
def test_slice_hr_window():
    points = [{"t": "14:00", "bpm": 80}, {"t": "14:48", "bpm": 120},
              {"t": "15:00", "bpm": 130}, {"t": "15:58", "bpm": 110},
              {"t": "16:30", "bpm": 70}]
    out = ghs.slice_hr_window(points, "14:48", "15:58")
    assert [p["t"] for p in out["points"]] == ["14:48", "15:00", "15:58"]  # inclusive bounds
    assert out["min_bpm"] == 110 and out["max_bpm"] == 130
    assert out["avg_bpm"] == 120                          # (120+130+110)/3


def test_slice_hr_window_empty_when_no_overlap():
    assert ghs.slice_hr_window([{"t": "08:00", "bpm": 60}], "14:00", "15:00") is None


# ---------------------------------------------------------------- fetch + ingest
from backend.models import DailyHealth

_OLD_RUN = {
    "name": "users/x/dataTypes/exercise/dataPoints/old",
    "exercise": {
        "interval": {"startTime": "2026-06-01T20:00:00Z", "startUtcOffset": "-25200s",
                     "endTime": "2026-06-01T20:30:00Z", "endUtcOffset": "-25200s"},
        "exerciseType": "RUNNING", "displayName": "Run",
        "metricsSummary": {}, "activeDuration": "1800s",
    },
}


def test_fetch_exercise_sessions_filters_parses_and_skips_ebike(monkeypatch):
    page = {"dataPoints": [_STRENGTH, _EBIKE, _SWIM, _OLD_RUN]}
    monkeypatch.setattr(ghs, "_get", lambda *a, **k: page)
    out = ghs._fetch_exercise_sessions("tok", date(2026, 6, 10), date(2026, 6, 18))
    # ebike dropped; 2026-06-01 run is before the range; strength + swim kept.
    assert sorted(p["exercise_type_raw"] for p in out) == ["SWIMMING_POOL", "WORKOUT"]


def test_fetch_exercise_sessions_stops_when_page_predates_range(monkeypatch):
    pages = {
        None: {"dataPoints": [_STRENGTH], "nextPageToken": "p2"},
        "p2": {"dataPoints": [_OLD_RUN], "nextPageToken": "p3"},
        "p3": {"dataPoints": [_STRENGTH], "nextPageToken": None},  # must never be fetched
    }
    seen = []
    def fake_get(tok, path, params=None):
        token = (params or {}).get("pageToken")
        seen.append(token)
        return pages[token]
    monkeypatch.setattr(ghs, "_get", fake_get)
    out = ghs._fetch_exercise_sessions("tok", date(2026, 6, 10), date(2026, 6, 18))
    assert seen == [None, "p2"]                          # reverse-chron early-stop
    assert [p["exercise_type_raw"] for p in out] == ["WORKOUT"]


def test_ingest_range_upserts_sessions(db, monkeypatch):
    monkeypatch.setattr(ghs, "_fetch_step_rollup", lambda t, s, e: {})
    monkeypatch.setattr(ghs, "_fetch_daily_points", lambda t, dt, s, e: {})
    monkeypatch.setattr(ghs, "_fetch_sleep", lambda t, s, e: {})
    monkeypatch.setattr(ghs, "_fetch_intraday_hr", lambda t, d: None)
    monkeypatch.setattr(ghs, "_fetch_exercise_sessions",
                        lambda t, s, e: [ghs._parse_exercise_session(_STRENGTH)])
    ghs._ingest_range(db, "tok", date(2026, 6, 17), date(2026, 6, 17))
    rows = db.query(WorkoutSession).all()
    assert len(rows) == 1 and rows[0].exercise_type_raw == "WORKOUT"


def test_ingest_range_isolates_session_failure(db, monkeypatch):
    monkeypatch.setattr(ghs, "_fetch_step_rollup", lambda t, s, e: {"2026-06-17": 5000})
    monkeypatch.setattr(ghs, "_fetch_daily_points", lambda t, dt, s, e: {})
    monkeypatch.setattr(ghs, "_fetch_sleep", lambda t, s, e: {})
    monkeypatch.setattr(ghs, "_fetch_intraday_hr", lambda t, d: None)
    def boom(*a, **k): raise RuntimeError("exercise endpoint 500")
    monkeypatch.setattr(ghs, "_fetch_exercise_sessions", boom)
    ghs._ingest_range(db, "tok", date(2026, 6, 17), date(2026, 6, 17))
    # daily metric still landed; session failure isolated.
    assert db.query(DailyHealth).filter_by(date="2026-06-17").one().steps == 5000
    assert db.query(WorkoutSession).count() == 0


from backend.models import Activity, DailySummary


def _quiet_ingest(monkeypatch):
    """No-op every non-session fetch so _ingest_range only exercises the sessions block."""
    monkeypatch.setattr(ghs, "_fetch_step_rollup", lambda t, s, e: {})
    monkeypatch.setattr(ghs, "_fetch_daily_points", lambda t, dt, s, e: {})
    monkeypatch.setattr(ghs, "_fetch_sleep", lambda t, s, e: {})
    monkeypatch.setattr(ghs, "_fetch_intraday_hr", lambda t, d: None)
    monkeypatch.setattr(ghs, "fetch_session_hr_window", lambda *a, **k: None)


def test_ingest_range_links_sessions_to_activities(db, monkeypatch):
    _quiet_ingest(monkeypatch)
    monkeypatch.setattr(ghs, "_fetch_exercise_sessions",
                        lambda t, s, e: [ghs._parse_exercise_session(_STRENGTH),
                                         ghs._parse_exercise_session(_SWIM)])
    ghs._ingest_range(db, "tok", date(2026, 6, 17), date(2026, 6, 17))
    sessions = db.query(WorkoutSession).all()
    activities = db.query(Activity).all()
    assert len(sessions) == 2 and len(activities) == 2
    # every session committed AND linked to its own activity
    assert {a.google_session_id for a in activities} == {s.id for s in sessions}
    assert {a.activity for a in activities} == {"strength", "swim"}


def test_ingest_range_link_failure_rolls_back_and_skips_burn(db, monkeypatch):
    # A committed-but-unlinked run (earlier partial sync) must NOT get its burn
    # applied while the sessions block is failing: unlinked reads as Google-only
    # and burn_applied is irreversible. The guard defers to the next clean sync.
    prior = WorkoutSession(google_id="g-prior", date="2026-06-18", exercise_type="Run",
                           exercise_type_raw="RUNNING", category="cardio",
                           start_time="2026-06-18T07:00:00", end_time="2026-06-18T07:30:00",
                           duration_min=30.0, calories_kcal=400.0, source="google")
    db.add(prior); db.commit()
    _quiet_ingest(monkeypatch)
    monkeypatch.setattr(ghs, "_fetch_exercise_sessions",
                        lambda t, s, e: [_row(google_id="g-new", date="2026-06-18",
                                              exercise_type="Run", exercise_type_raw="RUNNING",
                                              category="cardio", duration_min=30.0,
                                              start_time="2026-06-18T18:00:00",
                                              end_time="2026-06-18T18:30:00")])
    def boom(*a, **k): raise RuntimeError("link exploded")
    monkeypatch.setattr(ghs.activity_service, "link_google_session", boom)
    ghs._ingest_range(db, "tok", date(2026, 6, 18), date(2026, 6, 18))
    db.expire_all()
    assert db.query(WorkoutSession).count() == 1        # failed batch rolled back
    assert prior.burn_applied is False                   # burn pass skipped, not misapplied
    assert db.query(DailySummary).filter_by(date="2026-06-18").first() is None


# ------------------------------------------------------- session HR window fetch
def test_fetch_session_hr_window(monkeypatch):
    page = {"dataPoints": [
        {"heartRate": {"beatsPerMinute": "120", "sampleTime": {"physicalTime": "2026-06-17T21:50:02Z", "civilTime": {"time": {"hours": 14, "minutes": 50, "seconds": 2}}}}},
        {"heartRate": {"beatsPerMinute": "160", "sampleTime": {"physicalTime": "2026-06-17T21:51:05Z", "civilTime": {"time": {"hours": 14, "minutes": 51, "seconds": 5}}}}},
        {"heartRate": {"beatsPerMinute": "110", "sampleTime": {"physicalTime": "2026-06-17T21:52:09Z", "civilTime": {"time": {"hours": 14, "minutes": 52, "seconds": 9}}}}},
    ]}
    captured = {}
    def fake_get(tok, path, params=None):
        captured["path"] = path
        captured["filter"] = (params or {}).get("filter")
        return page
    monkeypatch.setattr(ghs, "_get", fake_get)
    out = ghs.fetch_session_hr_window("tok", "2026-06-17T21:48:44Z", "2026-06-17T22:58:19Z")
    assert out["min_bpm"] == 110 and out["max_bpm"] == 160 and out["avg_bpm"] == 130
    assert [p["bpm"] for p in out["points"]] == [120, 160, 110]   # native — every raw sample kept
    assert out["points"][0]["t"] == "14:50:02"                   # HH:MM:SS resolution (seconds preserved)
    assert captured["path"] == "heart-rate/dataPoints"
    assert 'heart_rate.sample_time.physical_time' in captured["filter"]


def test_fetch_session_hr_window_keeps_native_resolution(monkeypatch):
    # 400 in-window samples must all survive — the curve is no longer downsampled to ~180.
    dps = [{"heartRate": {"beatsPerMinute": str(100 + (i % 30)),
            "sampleTime": {"physicalTime": f"2026-06-17T21:{(i // 60) % 60:02d}:{i % 60:02d}Z",
                           "civilTime": {"time": {"hours": 14, "minutes": (i // 60) % 60, "seconds": i % 60}}}}}
           for i in range(400)]
    monkeypatch.setattr(ghs, "_get", lambda *a, **k: {"dataPoints": dps})
    out = ghs.fetch_session_hr_window("tok", "2026-06-17T21:00:00Z", "2026-06-17T23:00:00Z")
    assert len(out["points"]) == 400


def test_fetch_session_hr_window_empty(monkeypatch):
    monkeypatch.setattr(ghs, "_get", lambda *a, **k: {"dataPoints": []})
    assert ghs.fetch_session_hr_window("tok", "2026-06-17T21:48:00Z", "2026-06-17T22:00:00Z") is None


def test_derive_zones_floors_from_azm_join():
    azm = {"14:50": "FAT_BURN", "14:51": "CARDIO", "14:52": "CARDIO", "14:53": "PEAK"}
    per_minute = {"14:50": 105.0, "14:51": 143.0, "14:52": 148.0, "14:53": 162.0}
    assert ghs.derive_zones(azm, per_minute) == {"fat_burn": 105, "cardio": 143, "peak": 162}


def test_derive_zones_none_when_no_overlap():
    assert ghs.derive_zones({"14:50": "CARDIO"}, {"09:00": 120.0}) is None
    assert ghs.derive_zones({}, {}) is None
