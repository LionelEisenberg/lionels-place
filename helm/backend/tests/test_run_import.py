"""Run import: metricsSummary scalars, TCX ingestion pass, calorie application."""
import json
from datetime import date

import httpx

from backend.services import google_health_service as ghs
from backend.models import Workout, WorkoutSession, RunDetail, DailySummary, Activity


RUN_POINT = {
    "name": "users/me/dataTypes/exercise/dataPoints/run-abc",
    "exercise": {
        "exerciseType": "RUNNING",
        "displayName": "Run",
        "interval": {"startTime": "2026-07-10T01:04:00Z", "startUtcOffset": "-25200s",
                     "endTime": "2026-07-10T01:33:00Z", "endUtcOffset": "-25200s"},
        "activeDuration": "1722.5s",
        "metricsSummary": {
            "averageHeartRateBeatsPerMinute": "152",
            "distanceMillimeters": 5210000,
            "caloriesKcal": 412.3,
            "elevationGainMillimeters": 38200,
            "averagePaceSecondsPerMeter": 0.3305,
            "mobilityMetrics": {"avgCadenceStepsPerMinute": 168.4},
        },
    },
}


def test_parse_exercise_session_run_scalars():
    parsed = ghs._parse_exercise_session(RUN_POINT)
    assert parsed["exercise_type_raw"] == "RUNNING"
    assert parsed["calories_kcal"] == 412.3
    assert parsed["elevation_gain_m"] == 38.2
    assert parsed["avg_cadence_spm"] == 168
    assert parsed["avg_pace_s_per_km"] == 330.5
    assert parsed["distance_m"] == 5210000.0 / 1000.0


def test_parse_exercise_session_scalars_absent():
    pt = json.loads(json.dumps(RUN_POINT))
    pt["exercise"]["metricsSummary"] = {"averageHeartRateBeatsPerMinute": "119"}
    parsed = ghs._parse_exercise_session(pt)
    assert parsed["calories_kcal"] is None
    assert parsed["elevation_gain_m"] is None
    assert parsed["avg_cadence_spm"] is None
    assert parsed["avg_pace_s_per_km"] is None


def test_upsert_persists_run_scalars(db):
    parsed = ghs._parse_exercise_session(RUN_POINT)
    ghs._upsert_workout_session(db, parsed)
    row = db.query(WorkoutSession).filter(WorkoutSession.google_id == RUN_POINT["name"]).one()
    assert row.calories_kcal == 412.3
    assert row.avg_pace_s_per_km == 330.5
    assert row.burn_applied is False   # upsert never touches the flag


TCX_WITH_GPS = """<?xml version="1.0"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <Activities><Activity Sport="Running"><Lap StartTime="2026-07-10T01:04:00Z"><Track>
  <Trackpoint><Time>2026-07-10T01:04:00Z</Time>
   <Position><LatitudeDegrees>37.7749</LatitudeDegrees><LongitudeDegrees>-122.4194</LongitudeDegrees></Position>
   <DistanceMeters>0.0</DistanceMeters><HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>
  <Trackpoint><Time>2026-07-10T01:14:00Z</Time>
   <Position><LatitudeDegrees>37.7800</LatitudeDegrees><LongitudeDegrees>-122.4100</LongitudeDegrees></Position>
   <DistanceMeters>2000.0</DistanceMeters><HeartRateBpm><Value>150</Value></HeartRateBpm></Trackpoint>
 </Track></Lap></Activity></Activities></TrainingCenterDatabase>"""

TCX_NO_GPS = """<?xml version="1.0"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <Activities><Activity Sport="Running"><Lap StartTime="2026-07-10T01:04:00Z"><Track>
  <Trackpoint><Time>2026-07-10T01:04:00Z</Time><DistanceMeters>0.0</DistanceMeters></Trackpoint>
  <Trackpoint><Time>2026-07-10T01:14:00Z</Time><DistanceMeters>2000.0</DistanceMeters></Trackpoint>
 </Track></Lap></Activity></Activities></TrainingCenterDatabase>"""


class _TcxResp:
    def __init__(self, text, status=200):
        self.text, self.status_code = text, status
    def raise_for_status(self):
        if self.status_code != 200:
            raise httpx.HTTPStatusError("boom", request=None, response=None)


def _seed_run(db, google_id="users/me/dataTypes/exercise/dataPoints/run-1",
              raw="RUNNING", date_="2026-07-10"):
    s = WorkoutSession(google_id=google_id, date=date_, exercise_type="Run",
                       exercise_type_raw=raw, category="cardio",
                       start_time=f"{date_}T18:04:00", end_time=f"{date_}T18:33:00",
                       duration_min=28.7, avg_hr=152, source="google")
    db.add(s)
    db.commit()
    return s


def test_ingest_run_details_gps(db, monkeypatch):
    s = _seed_run(db)
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _TcxResp(TCX_WITH_GPS))
    ghs._ingest_run_details(db, "tok", date(2026, 7, 10), date(2026, 7, 10))
    rd = db.query(RunDetail).filter(RunDetail.workout_session_id == s.id).one()
    assert rd.route_status == "ok"
    assert json.loads(rd.route)[0] == [37.7749, -122.4194]
    assert json.loads(rd.splits)[0]["distance_m"] == 1000.0


def test_ingest_run_details_treadmill_no_gps(db, monkeypatch):
    s = _seed_run(db, raw="TREADMILL_RUNNING")
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _TcxResp(TCX_NO_GPS))
    ghs._ingest_run_details(db, "tok", date(2026, 7, 10), date(2026, 7, 10))
    rd = db.query(RunDetail).filter(RunDetail.workout_session_id == s.id).one()
    assert rd.route_status == "none" and rd.route is None
    assert json.loads(rd.splits)[0]["seconds"] == 300.0


def test_ingest_run_details_error_then_retry(db, monkeypatch):
    s = _seed_run(db)
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _TcxResp("", status=500))
    ghs._ingest_run_details(db, "tok", date(2026, 7, 10), date(2026, 7, 10))
    rd = db.query(RunDetail).filter(RunDetail.workout_session_id == s.id).one()
    assert rd.route_status == "error"
    # A later pass retries error rows and overwrites in place (still one row).
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _TcxResp(TCX_WITH_GPS))
    ghs._ingest_run_details(db, "tok", date(2026, 7, 10), date(2026, 7, 10))
    assert db.query(RunDetail).count() == 1
    assert db.query(RunDetail).one().route_status == "ok"


def test_ingest_run_details_skips_terminal_and_non_runs(db, monkeypatch):
    done = _seed_run(db, google_id="gd")
    db.add(RunDetail(workout_session_id=done.id, route_status="ok"))
    swim = _seed_run(db, google_id="gs", raw="SWIMMING_POOL")
    db.commit()
    calls = []
    monkeypatch.setattr(httpx, "get", lambda *a, **k: calls.append(1) or _TcxResp(TCX_WITH_GPS))
    ghs._ingest_run_details(db, "tok", date(2026, 7, 10), date(2026, 7, 10))
    assert calls == []          # ok row skipped; swim never fetched


def test_ingest_run_details_cap(db, monkeypatch):
    for i in range(4):
        _seed_run(db, google_id=f"g{i}")
    calls = []
    monkeypatch.setattr(httpx, "get", lambda *a, **k: calls.append(1) or _TcxResp(TCX_WITH_GPS))
    ghs._ingest_run_details(db, "tok", date(2026, 7, 10), date(2026, 7, 10), cap=2)
    assert len(calls) == 2
    ghs._ingest_run_details(db, "tok", date(2026, 7, 10), date(2026, 7, 10), cap=None)
    assert len(calls) == 4      # uncapped pass finishes the rest


def test_has_location_scope():
    class C:
        scopes = "a b https://www.googleapis.com/auth/googlehealth.location.readonly"
    class C2:
        scopes = "a b"
    assert ghs.has_location_scope(C())
    assert not ghs.has_location_scope(C2())
    assert not ghs.has_location_scope(None)
