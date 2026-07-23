"""Parse Google Health exportExerciseTcx output into a route polyline + per-km splits.

TCX is Garmin Training Center XML. Tags are matched by local name (namespace-
agnostic) so any TCX namespace version parses. Pure functions — no I/O."""
from __future__ import annotations

from datetime import datetime
from xml.etree import ElementTree


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_tcx(xml_text: str) -> list[dict]:
    """All trackpoints as {t: datetime, lat, lng, alt_m, dist_m, hr} (None when absent).
    Returns [] for header-only TCX (indoor sessions without partial data)."""
    root = ElementTree.fromstring(xml_text)
    out: list[dict] = []
    for tp in root.iter():
        if _local(tp.tag) != "Trackpoint":
            continue
        t_raw = None
        lat = lng = alt = dist = None
        hr = None
        for el in tp.iter():
            txt = (el.text or "").strip()
            if not txt:
                continue
            name = _local(el.tag)
            if name == "Time":
                t_raw = txt
            elif name == "LatitudeDegrees":
                lat = float(txt)
            elif name == "LongitudeDegrees":
                lng = float(txt)
            elif name == "AltitudeMeters":
                alt = float(txt)
            elif name == "DistanceMeters":
                dist = float(txt)
            elif name == "Value":   # HeartRateBpm/Value is the only <Value> in a Trackpoint
                hr = int(round(float(txt)))
        if t_raw is None:
            continue
        out.append({
            "t": datetime.fromisoformat(t_raw.replace("Z", "+00:00")),
            "lat": lat, "lng": lng, "alt_m": alt, "dist_m": dist, "hr": hr,
        })
    return out


def derive_route(points: list[dict], max_points: int = 500) -> list[list[float]] | None:
    """[[lat, lng], ...] from GPS trackpoints, uniform-stride downsampled to
    max_points with the first/last points always kept. None without >=2 GPS fixes."""
    coords = [[p["lat"], p["lng"]] for p in points
              if p["lat"] is not None and p["lng"] is not None]
    if len(coords) < 2:
        return None
    if len(coords) <= max_points:
        return coords
    stride = (len(coords) - 1) / (max_points - 1)
    sampled = [coords[round(i * stride)] for i in range(max_points)]
    sampled[-1] = coords[-1]
    return sampled


def derive_splits(points: list[dict], split_m: float = 1000.0,
                  min_tail_m: float = 100.0) -> list[dict] | None:
    """Per-km splits from cumulative distance + timestamps.

    Each km-crossing time is linearly interpolated between the bracketing
    trackpoints; avg_hr averages the HR samples inside the split; marker is the
    GPS fix at the crossing (None without GPS, e.g. treadmill). The trailing
    partial split is kept when >= min_tail_m. None when distance never moves."""
    pts = [p for p in points if p["dist_m"] is not None]
    if len(pts) < 2 or (pts[-1]["dist_m"] or 0) <= 0:
        return None
    splits: list[dict] = []
    boundary = split_m
    prev_cross_t = pts[0]["t"]
    hrs: list[int] = []
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        if b["hr"] is not None:
            hrs.append(b["hr"])
        while b["dist_m"] >= boundary and b["dist_m"] > a["dist_m"]:
            frac = (boundary - a["dist_m"]) / (b["dist_m"] - a["dist_m"])
            cross_t = a["t"] + (b["t"] - a["t"]) * frac
            splits.append({
                "distance_m": split_m,
                "seconds": round((cross_t - prev_cross_t).total_seconds(), 1),
                "avg_hr": int(round(sum(hrs) / len(hrs))) if hrs else None,
                "marker": ([b["lat"], b["lng"]]
                           if b["lat"] is not None and b["lng"] is not None else None),
            })
            prev_cross_t = cross_t
            hrs = []
            boundary += split_m
    tail_m = pts[-1]["dist_m"] - (boundary - split_m)
    if tail_m >= min_tail_m:
        splits.append({
            "distance_m": round(tail_m, 1),
            "seconds": round((pts[-1]["t"] - prev_cross_t).total_seconds(), 1),
            "avg_hr": int(round(sum(hrs) / len(hrs))) if hrs else None,
            "marker": None,
        })
    return splits or None
