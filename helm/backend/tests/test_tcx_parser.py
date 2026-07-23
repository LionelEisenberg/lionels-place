"""TCX parsing + route/splits derivation (pure functions, no I/O)."""
from datetime import datetime, timedelta, timezone

from backend.services import tcx_parser


TCX_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <Activities><Activity Sport="Running"><Id>2026-07-10T01:04:00Z</Id>
  <Lap StartTime="2026-07-10T01:04:00Z"><Track>
   <Trackpoint><Time>2026-07-10T01:04:00Z</Time>
    <Position><LatitudeDegrees>37.7749</LatitudeDegrees><LongitudeDegrees>-122.4194</LongitudeDegrees></Position>
    <AltitudeMeters>12.0</AltitudeMeters><DistanceMeters>0.0</DistanceMeters>
    <HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>
   <Trackpoint><Time>2026-07-10T01:06:00Z</Time>
    <Position><LatitudeDegrees>37.7760</LatitudeDegrees><LongitudeDegrees>-122.4180</LongitudeDegrees></Position>
    <AltitudeMeters>14.0</AltitudeMeters><DistanceMeters>400.0</DistanceMeters>
    <HeartRateBpm><Value>145</Value></HeartRateBpm></Trackpoint>
   <Trackpoint><Time>2026-07-10T01:10:00Z</Time>
    <DistanceMeters>1200.0</DistanceMeters>
    <HeartRateBpm><Value>155</Value></HeartRateBpm></Trackpoint>
  </Track></Lap>
 </Activity></Activities>
</TrainingCenterDatabase>"""


def _pt(minutes, dist, lat=None, lng=None, hr=None):
    return {"t": datetime(2026, 7, 10, 1, 4, tzinfo=timezone.utc) + timedelta(minutes=minutes),
            "lat": lat, "lng": lng, "alt_m": None, "dist_m": dist, "hr": hr}


def test_parse_tcx_trackpoints():
    pts = tcx_parser.parse_tcx(TCX_SAMPLE)
    assert len(pts) == 3
    assert pts[0]["lat"] == 37.7749 and pts[0]["lng"] == -122.4194
    assert pts[0]["hr"] == 120 and pts[0]["dist_m"] == 0.0
    assert pts[2]["lat"] is None          # GPS dropout point still parsed
    assert pts[2]["dist_m"] == 1200.0
    assert (pts[1]["t"] - pts[0]["t"]).total_seconds() == 120


def test_parse_tcx_header_only():
    assert tcx_parser.parse_tcx(
        '<TrainingCenterDatabase xmlns="x"><Activities/></TrainingCenterDatabase>') == []


def test_derive_route_downsamples_and_keeps_ends():
    pts = [_pt(i, i * 10.0, lat=37.0 + i * 1e-4, lng=-122.0) for i in range(1000)]
    route = tcx_parser.derive_route(pts, max_points=500)
    assert len(route) == 500
    assert route[0] == [37.0, -122.0]
    assert route[-1] == [37.0 + 999 * 1e-4, -122.0]


def test_derive_route_none_without_gps():
    assert tcx_parser.derive_route([_pt(0, 0.0), _pt(1, 100.0)]) is None


def test_derive_splits_interpolates_km_crossings():
    # 200 m/min pace -> km crossing every 5 min exactly.
    pts = [_pt(i, i * 200.0, lat=37.0 + i * 1e-4, lng=-122.0, hr=140 + i) for i in range(13)]  # 2400 m
    splits = tcx_parser.derive_splits(pts)
    assert len(splits) == 3
    assert splits[0]["distance_m"] == 1000.0 and splits[0]["seconds"] == 300.0
    assert splits[1]["distance_m"] == 1000.0 and splits[1]["seconds"] == 300.0
    assert splits[0]["marker"] is not None
    assert splits[0]["avg_hr"] is not None
    assert splits[2]["distance_m"] == 400.0    # trailing partial kept (>=100 m)


def test_derive_splits_drops_tiny_tail_and_handles_no_distance():
    pts = [_pt(i, i * 500.0) for i in range(3)]   # exactly 1000 m
    splits = tcx_parser.derive_splits(pts)
    assert len(splits) == 1                        # no phantom 0 m tail
    assert tcx_parser.derive_splits([_pt(0, None), _pt(1, None)]) is None
