"""calibration.coverage: how often the stored one-year bands held the realised growth (SPEC Part 2 §6.11 P3;
AMENDMENTS K17, H12)."""
from datetime import date, timedelta

import pytest

from tracker.analytics.calibration import MIN_MATURED, TARGET_PCT, coverage

TODAY = date(2026, 11, 14)


def snap(ds, p10=0.9, p50=1.1, p90=1.3, **extra):
    data = {"total": 100000, "projection_1y": {"p10": p10, "p50": p50, "p90": p90}, **extra}
    return {"date": ds, "data": data}


def daily_index(start, end, rate_for):
    """One index point per calendar day; `rate_for(day)` is that day's growth multiplier."""
    pts, ix, day = [], 1.0, start
    while day <= end:
        pts.append((day.isoformat(), round(ix, 6)))
        ix *= rate_for(day)
        day += timedelta(days=1)
    return pts


def test_coverage_maths_on_monthly_snapshots():
    # an index that is flat, so every realised g is exactly 1.0 …
    pts = [(f"{y}-{m:02d}-01", 1.0) for y in (2024, 2025, 2026) for m in range(1, 13)]
    # … and eight first-of-month snapshots that matured by 2026-11-14 (2024-11-01 … 2025-06-01, each + 365 ≤ today);
    # five bands hold 1.0, three sit above it
    dates = ["2024-11-01", "2024-12-01", "2025-01-01", "2025-02-01", "2025-03-01", "2025-04-01", "2025-05-01",
             "2025-06-01"]
    snaps = [snap(ds) if i < 5 else snap(ds, p10=1.05, p50=1.2, p90=1.4) for i, ds in enumerate(dates)]
    snaps.append(snap("2026-01-01"))                    # not matured: + 365 is after today
    out = coverage(snaps, pts, TODAY)
    assert out["matured"] == 8 and out["inside"] == 5
    assert out["coverage_pct"] == 62.5 and out["target"] == TARGET_PCT == 80 and out["show"] is True
    assert [r["date"] for r in out["rows"]] == sorted(dates, reverse=True)       # newest first
    assert set(out["rows"][0]) == {"date", "p10", "p50", "p90", "realised", "inside"}
    assert all(r["realised"] == 1.0 for r in out["rows"])
    assert [r["inside"] for r in out["rows"]] == [False, False, False, True, True, True, True, True]
    assert out["rows"][-1] == {"date": "2024-11-01", "p10": 0.9, "p50": 1.1, "p90": 1.3, "realised": 1.0,
                               "inside": True}


def test_realised_growth_is_index_ratio_and_the_band_edges_count_as_inside():
    pts = [("2025-01-10", 100.0), ("2026-01-10", 112.0), ("2025-02-10", 100.0), ("2026-02-10", 90.0),
           ("2025-03-10", 200.0), ("2026-03-10", 260.0)]
    snaps = [snap("2025-01-10", p10=0.95, p50=1.05, p90=1.12),      # g 1.12 on p90 → inside
             snap("2025-02-10", p10=0.9, p50=1.0, p90=1.1),         # g 0.90 on p10 → inside
             snap("2025-03-10", p10=0.9, p50=1.1, p90=1.25)]        # g 1.30 above p90 → outside
    out = coverage(snaps, pts, TODAY)
    by = {r["date"]: r for r in out["rows"]}
    assert by["2025-01-10"]["realised"] == 1.12 and by["2025-01-10"]["inside"] is True
    assert by["2025-02-10"]["realised"] == 0.9 and by["2025-02-10"]["inside"] is True
    assert by["2025-03-10"]["realised"] == 1.3 and by["2025-03-10"]["inside"] is False
    assert out["coverage_pct"] == 66.7 and out["show"] is False


def test_show_is_false_below_six_matured():
    pts = daily_index(date(2024, 1, 1), TODAY, lambda d: 1.0003)
    for n in (1, MIN_MATURED - 1, MIN_MATURED):
        snaps = [snap(f"2025-{m:02d}-05", p10=0.8, p90=1.5) for m in range(1, n + 1)]
        out = coverage(snaps, pts, TODAY)
        assert out["matured"] == n and out["coverage_pct"] == 100.0
        assert out["show"] is (n >= MIN_MATURED)


def test_one_snapshot_per_month_the_earliest_with_a_projection():
    pts = daily_index(date(2024, 1, 1), TODAY, lambda d: 1.0)
    snaps = [
        {"date": "2025-03-01", "data": {"total": 1}},                   # earliest in March, but no projection
        snap("2025-03-20", p10=1.2, p50=1.3, p90=1.4),                   # later the same month: never used
        snap("2025-03-04", p10=0.9, p50=1.0, p90=1.1),                   # earliest with a projection: used
        snap("2025-03-11", p10=0.9, p50=1.0, p90=1.1),
        {"date": "2025-04-02", "data": {"projection_1y": {"p10": None, "p50": 1, "p90": 1.2}}},   # unusable band
        snap("2025-04-09", p10=1.2, p50=1.3, p90=1.4),                   # April's only usable one
        {"date": "2025-05-01", "data": "not a dict"},
    ]
    out = coverage(snaps, pts, TODAY)
    assert [r["date"] for r in out["rows"]] == ["2025-04-09", "2025-03-04"]
    assert out["matured"] == 2 and out["inside"] == 1 and out["coverage_pct"] == 50.0
    # input order does not matter
    assert coverage(list(reversed(snaps)), pts, TODAY) == out


def test_nearest_index_point_within_seven_days_ties_to_the_earlier():
    # the snapshot is on 2025-01-15, so its end date is 2026-01-15
    snaps = [snap("2025-01-15", p10=0.5, p50=1.0, p90=2.0)]
    start = [("2025-01-12", 100.0), ("2025-01-18", 400.0)]          # both 3 days away: the earlier wins
    end = [("2026-01-10", 150.0), ("2026-01-20", 999.0)]            # 5 days before beats 5 days after (tie → earlier)
    out = coverage(snaps, start + end, TODAY)
    assert out["matured"] == 1 and out["rows"][0]["realised"] == 1.5

    # a strictly nearer point wins even when it is later
    out = coverage(snaps, [("2025-01-08", 50.0), ("2025-01-16", 100.0), ("2026-01-15", 120.0)], TODAY)
    assert out["rows"][0]["realised"] == 1.2

    # exactly 7 days away still counts; 8 days does not
    assert coverage(snaps, [("2025-01-08", 100.0), ("2026-01-22", 110.0)], TODAY)["rows"][0]["realised"] == 1.1
    out = coverage(snaps, [("2025-01-07", 100.0), ("2026-01-15", 110.0)], TODAY)
    assert out["matured"] == 0 and out["coverage_pct"] is None and out["rows"] == []
    assert coverage(snaps, [("2025-01-15", 100.0), ("2026-01-23", 110.0)], TODAY)["matured"] == 0


def test_maturity_needs_a_full_year_and_accepts_series_rows():
    rows = [{"date": "2025-11-14", "index": 1.0, "value": 10}, {"date": "2026-11-14", "index": 1.08, "value": 11}]
    snaps = [snap("2025-11-14")]
    out = coverage(snaps, rows, TODAY)                      # 2025-11-14 + 365 == today: matured
    assert out["matured"] == 1 and out["rows"][0]["realised"] == 1.08
    assert coverage(snaps, rows, TODAY - timedelta(days=1))["matured"] == 0
    assert coverage(snaps, rows, "2026-11-14") == out       # an ISO string works as today
    # zero, negative or missing index points are ignored
    bad = [{"date": "2025-11-14", "index": 0}, {"date": "2026-11-14", "index": 1.1}]
    assert coverage(snaps, bad, TODAY)["matured"] == 0


def test_empty_case():
    empty = {"matured": 0, "inside": 0, "coverage_pct": None, "target": 80, "show": False, "rows": []}
    assert coverage([], [], TODAY) == empty
    assert coverage(None, None, TODAY) == empty
    assert coverage([snap("2025-01-01")], [], TODAY) == empty               # no index at all
    assert coverage([{"date": "2025-01-01", "data": {}}], [("2025-01-01", 1.0), ("2026-01-01", 1.1)], TODAY) == empty


def test_bad_today_raises():
    with pytest.raises(ValueError):
        coverage([], [], "soon")
