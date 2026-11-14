"""Calibration of the one-year projection band (SPEC Part 2 §6.11 P3 evaluation; AMENDMENTS K17, H12).

Each day's KPI snapshot stores `projection_1y = {p10, p50, p90}`: growth factors (end value / today's value)
of a no-SIP one-year projection (H12). A year later the realised growth is known from the time-weighted
performance index, which ignores new money exactly as the no-SIP projection does. If the band is honest,
about 80% of matured snapshots land inside p10…p90.

Pure: no database, no clock. W7-B1 feeds it `ledger.kpi_snapshots(owner)` and the ALL performance series and
puts the result into `/assumptions` (K21).
"""
from __future__ import annotations

from bisect import bisect_left
from datetime import date, timedelta
from typing import Any, Iterable

TARGET_PCT = 80          # p10…p90 should hold the realised growth about 80% of the time
MIN_MATURED = 6          # below this the coverage is too noisy to show
HORIZON_DAYS = 365       # projection_1y looks one year ahead
TOLERANCE_DAYS = 7       # an index point counts for a date when it is at most this many calendar days away

__all__ = ["coverage", "TARGET_PCT", "MIN_MATURED", "HORIZON_DAYS", "TOLERANCE_DAYS"]


def _day(v: Any) -> date | None:
    """A date from a `date`/`datetime` or an ISO string (time part ignored); None when unreadable."""
    if isinstance(v, date):
        return date(v.year, v.month, v.day)
    if isinstance(v, str) and len(v) >= 10:
        try:
            return date.fromisoformat(v[:10])
        except ValueError:
            return None
    return None


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _band(data: Any) -> tuple[float, float, float] | None:
    """The snapshot's (p10, p50, p90) growth factors, or None when it has no usable projection_1y."""
    pj = data.get("projection_1y") if isinstance(data, dict) else None
    if not isinstance(pj, dict):
        return None
    vals = tuple(_num(pj.get(q)) for q in ("p10", "p50", "p90"))
    if any(v is None or v <= 0 for v in vals):
        return None
    return vals  # type: ignore[return-value]


def _points(perf_points: Iterable[Any] | None) -> list[tuple[date, float]]:
    """(date, index) pairs, sorted, from tuples or `{date, index, ...}` rows; unreadable or non-positive
    points are dropped. On a duplicate date the first one given is kept."""
    seen: dict[date, float] = {}
    for p in perf_points or []:
        if isinstance(p, dict):
            dt, ix = p.get("date"), p.get("index")
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            dt, ix = p[0], p[1]
        else:
            continue
        day, val = _day(dt), _num(ix)
        if day is not None and val is not None and val > 0 and day not in seen:
            seen[day] = val
    return sorted(seen.items())


def _nearest(points: list[tuple[date, float]], days: list[date], target: date) -> float | None:
    """The index at the point nearest `target` within TOLERANCE_DAYS calendar days; a tie goes to the
    earlier point. None when no point is close enough."""
    i = bisect_left(days, target)
    best: tuple[int, date, float] | None = None
    for j in (i - 1, i):                       # the neighbours on each side are the only candidates
        if 0 <= j < len(points):
            gap = abs((points[j][0] - target).days)
            if gap <= TOLERANCE_DAYS and (best is None or (gap, points[j][0]) < best[:2]):
                best = (gap, points[j][0], points[j][1])
    return best[2] if best else None


def coverage(snapshots: Iterable[dict] | None, perf_points: Iterable[Any] | None, today: date | str) -> dict:
    """How often the stored one-year bands held the growth that actually followed.

    * `snapshots`: `[{date, data}]` rows (as `ledger.kpi_snapshots` returns them); `data.projection_1y` holds
      the {p10, p50, p90} growth factors (H12). Rows without one are ignored.
    * `perf_points`: `[(date, index)]`, or the `/performance` ALL `series` rows `{date, index, ...}`.
    * `today`: a date or ISO string.

    One snapshot per calendar month is used, the earliest dated one with a projection_1y, so a run of daily
    snapshots cannot outvote a quiet month. A snapshot dated d has **matured** when d + 365 ≤ today and an
    index point exists within 7 calendar days of both d and d + 365 (nearest point, ties to the earlier).
    Realised growth g = index(d + 365) / index(d); it is **inside** when p10 ≤ g ≤ p90.

    Returns `{matured, inside, coverage_pct, target, show, rows}`: `coverage_pct` is inside/matured × 100 to
    1 dp (None when nothing has matured), `target` is 80, `show` is matured ≥ 6, and `rows` lists the matured
    snapshots `{date, p10, p50, p90, realised, inside}` newest first (`realised` to 4 dp). Snapshots that have
    not matured, or lack an index point, are left out of every count.
    """
    today_d = _day(today)
    if today_d is None:
        raise ValueError(f"today must be a date or ISO date string, got {today!r}")

    monthly: dict[tuple[int, int], tuple[date, tuple[float, float, float]]] = {}
    for s in snapshots or []:
        if not isinstance(s, dict):
            continue
        day, band = _day(s.get("date")), _band(s.get("data"))
        if day is None or band is None:
            continue
        key = (day.year, day.month)
        if key not in monthly or day < monthly[key][0]:
            monthly[key] = (day, band)

    points = _points(perf_points)
    days = [p[0] for p in points]
    rows = []
    for day, (p10, p50, p90) in monthly.values():
        end = day + timedelta(days=HORIZON_DAYS)
        if end > today_d:
            continue
        start_ix, end_ix = _nearest(points, days, day), _nearest(points, days, end)
        if start_ix is None or end_ix is None:
            continue
        g = end_ix / start_ix
        rows.append({"date": day.isoformat(), "p10": p10, "p50": p50, "p90": p90,
                     "realised": round(g, 4), "inside": p10 <= g <= p90})

    rows.sort(key=lambda r: r["date"], reverse=True)
    matured = len(rows)
    inside = sum(1 for r in rows if r["inside"])
    return {
        "matured": matured,
        "inside": inside,
        "coverage_pct": round(inside / matured * 100, 1) if matured else None,
        "target": TARGET_PCT,
        "show": matured >= MIN_MATURED,
        "rows": rows,
    }
