"""SIP schedule and adherence engine (SPEC §7.6, AMENDMENTS A11 and E18)."""
from datetime import date

from tracker import domain as d
from tracker.analytics import plans as P

TODAY = date(2026, 11, 14)

INSTRUMENTS = [
    {"id": 7, "name": "Index Fund", "asset_class": d.MUTUAL_FUND},
    {"id": 8, "name": "Flexi Cap", "asset_class": d.MUTUAL_FUND},
    {"id": 9, "name": "EPF", "asset_class": d.EPF},
    {"id": 10, "name": "Infosys", "asset_class": d.EQUITY, "market": "NSE"},
]


def plan(pid=1, **kw):
    base = {"id": pid, "name": f"Plan {pid}", "instrument_id": 7, "segment": d.SEG_MF, "amount": 5000,
            "frequency": "monthly", "day_of_month": 5, "step_up_pct": None, "start_date": "2026-01-01",
            "end_date": None, "active": 1, "created_at": "2026-01-01T09:00:00"}
    base.update(kw)
    return base


def buy(tid, iid, day, amount, **kw):
    return {"id": tid, "instrument_id": iid, "type": d.BUY, "date": day, "amount": amount, **kw}


def row(result, pid):
    return next(p for p in result["plans"] if p["id"] == pid)


def inst(result, pid, due):
    return next(m for m in row(result, pid)["months"] if m["due"] == due)


# ── due dates ──

def test_weekly_due_dates_respect_start_and_end():
    p = plan(frequency="weekly", start_date="2026-01-05", end_date="2026-02-02")
    got = P.due_dates(p, date(2026, 1, 1), date(2026, 3, 31))
    assert [x.isoformat() for x in got] == ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02"]
    # a window that starts mid-cadence keeps the cadence anchored on start_date
    assert P.due_dates(p, date(2026, 1, 13), date(2026, 1, 31)) == [date(2026, 1, 19), date(2026, 1, 26)]


def test_weekly_without_start_date_anchors_on_created_at():
    p = plan(frequency="weekly", start_date=None, created_at="2026-03-04T18:22:01")
    assert P.due_dates(p, date(2026, 3, 1), date(2026, 3, 20)) == [date(2026, 3, 4), date(2026, 3, 11), date(2026, 3, 18)]


def test_quarterly_due_dates_count_from_start_month():
    p = plan(frequency="quarterly", start_date="2026-02-15", day_of_month=10)
    got = P.due_dates(p, date(2026, 1, 1), date(2026, 12, 31))
    # 10 Feb falls before start_date, so the first instalment is May
    assert got == [date(2026, 5, 10), date(2026, 8, 10), date(2026, 11, 10)]
    p2 = plan(frequency="quarterly", start_date=None, created_at="2026-03-01", day_of_month=1)
    assert P.due_dates(p2, date(2026, 1, 1), date(2026, 12, 31)) == [
        date(2026, 3, 1), date(2026, 6, 1), date(2026, 9, 1), date(2026, 12, 1)]


def test_yearly_due_dates_in_start_month_with_end_bound():
    p = plan(frequency="yearly", start_date="2024-03-01", day_of_month=31, end_date="2026-12-31")
    got = P.due_dates(p, date(2023, 1, 1), date(2028, 12, 31))
    assert got == [date(2024, 3, 31), date(2025, 3, 31), date(2026, 3, 31)]


def test_monthly_31st_clamps_to_month_end():
    p = plan(day_of_month=31, start_date="2026-01-01")
    got = P.due_dates(p, date(2026, 1, 1), date(2026, 4, 30))
    assert got == [date(2026, 1, 31), date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30)]
    leap = plan(day_of_month=31, start_date="2028-01-01")
    assert P.due_dates(leap, date(2028, 2, 1), date(2028, 2, 29)) == [date(2028, 2, 29)]


def test_inactive_plan_has_no_instalments():
    for flag in (0, "0", False):
        assert P.due_dates(plan(active=flag), date(2026, 1, 1), date(2026, 12, 31)) == []
    r = P.sip_adherence([plan(active=0)], [], INSTRUMENTS, TODAY)
    assert row(r, 1)["months"] == [] and row(r, 1)["adherence_pct"] is None and row(r, 1)["next_due"] is None


# ── matching and statuses ──

def test_output_shape():
    r = P.sip_adherence([plan()], [], INSTRUMENTS, TODAY)
    assert {"plans", "planned_this_month", "invested_this_month", "adherence_6m_pct", "next_due"} <= set(r)
    p = r["plans"][0]
    assert {"id", "name", "monthly_equiv", "months", "adherence_pct", "missed_count", "next_due"} <= set(p)
    assert set(p["months"][0]) == {"month", "due", "planned", "invested", "status"}
    # months=6 from 14 Nov: June to November, plus nothing extra (5 Dec is beyond today + 7)
    assert [m["due"] for m in p["months"]] == [f"2026-{m:02d}-05" for m in range(6, 12)]
    assert r["window"] == {"start": "2026-06-01", "end": "2026-11-30"}


def test_one_buy_cannot_satisfy_two_plans():
    sips = [plan(2, start_date="2026-11-01"), plan(1, start_date="2026-11-01")]
    r = P.sip_adherence(sips, [buy(100, 7, "2026-11-05", 5000)], INSTRUMENTS, TODAY)
    assert [p["id"] for p in r["plans"]] == [1, 2]   # iterated by id
    assert inst(r, 1, "2026-11-05")["status"] == "done"
    assert inst(r, 2, "2026-11-05")["status"] == "missed"
    assert inst(r, 2, "2026-11-05")["invested"] == 0
    assert r["planned_this_month"] == 10000 and r["invested_this_month"] == 5000


def test_instrument_plan_and_segment_plan_share_no_buy():
    sips = [plan(1, start_date="2026-11-01"),
            plan(2, instrument_id=None, segment=d.SEG_MF, start_date="2026-11-01")]
    r = P.sip_adherence(sips, [buy(100, 7, "2026-11-04", 5000), buy(101, 8, "2026-11-06", 5000)], INSTRUMENTS, TODAY)
    assert inst(r, 1, "2026-11-05")["status"] == "done"
    # the segment plan finds the Flexi Cap BUY, not the Index Fund one that plan 1 already took
    assert inst(r, 2, "2026-11-05")["status"] == "done"
    assert inst(r, 2, "2026-11-05")["invested"] == 5000
    # a BUY in another segment never counts
    r2 = P.sip_adherence([plan(2, instrument_id=None, segment=d.SEG_MF, start_date="2026-11-01")],
                         [buy(102, 10, "2026-11-05", 5000)], INSTRUMENTS, TODAY)
    assert inst(r2, 2, "2026-11-05")["status"] == "missed"


def test_partial_and_done_threshold():
    sips = [plan(1, start_date="2026-10-01")]
    r = P.sip_adherence(sips, [buy(1, 7, "2026-10-05", 3000), buy(2, 7, "2026-11-06", 4760)], INSTRUMENTS, TODAY)
    assert inst(r, 1, "2026-10-05") == {"month": "2026-10", "due": "2026-10-05", "planned": 5000, "invested": 3000,
                                        "status": "partial"}
    assert inst(r, 1, "2026-11-05")["status"] == "done"   # 4760 ≥ 95% of 5000
    assert row(r, 1)["adherence_pct"] == 75.0             # (1 + 0.5) / 2


def test_matching_window_bounds():
    sips = [plan(1, start_date="2026-09-01")]
    txns = [buy(1, 7, "2026-09-02", 5000),   # 3 days early: counts for 5 Sep
            buy(2, 7, "2026-10-26", 5000),   # 21 days late: outside 5 Oct's window
            buy(3, 7, "2026-11-05", 5000)]   # on the next due date: belongs to 5 Nov, not 5 Oct
    r = P.sip_adherence(sips, txns, INSTRUMENTS, TODAY)
    assert inst(r, 1, "2026-09-05")["status"] == "done"
    assert inst(r, 1, "2026-10-05")["status"] == "missed"
    assert inst(r, 1, "2026-11-05")["status"] == "done"


def test_weekly_window_stops_before_next_instalment():
    sips = [plan(1, frequency="weekly", start_date="2026-11-02")]
    # one double BUY on 3 Nov covers 2 Nov only (the 9 Nov window starts on 6 Nov)
    r = P.sip_adherence(sips, [buy(1, 7, "2026-11-03", 10000)], INSTRUMENTS, TODAY)
    assert inst(r, 1, "2026-11-02")["status"] == "done"
    assert inst(r, 1, "2026-11-09")["status"] == "missed"     # the leftover 5000 never reaches it
    assert inst(r, 1, "2026-11-16")["status"] == "upcoming"
    # one entry per instalment (E18), through the end of the month
    assert [m["due"] for m in row(r, 1)["months"]] == ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23",
                                                       "2026-11-30"]
    assert row(r, 1)["monthly_equiv"] == round(5000 * 52 / 12, 2)


def test_missed_quarterly_plan():
    sips = [plan(4, frequency="quarterly", start_date="2026-05-01", day_of_month=1, amount=15000)]
    r = P.sip_adherence(sips, [buy(1, 7, "2026-08-01", 15000)], INSTRUMENTS, TODAY)
    p = row(r, 4)
    assert [m["due"] for m in p["months"]] == ["2026-08-01", "2026-11-01"]
    assert inst(r, 4, "2026-08-01")["status"] == "done"
    assert inst(r, 4, "2026-11-01")["status"] == "missed"
    assert p["missed_count"] == 1 and p["adherence_pct"] == 50.0
    assert p["next_due"] == "2027-02-01"
    assert p["monthly_equiv"] == 5000


def test_grace_counts_as_upcoming():
    sips = [plan(1, day_of_month=10, start_date="2026-11-01")]
    r = P.sip_adherence(sips, [], INSTRUMENTS, TODAY)   # 14 Nov − 4 = 10 Nov
    assert inst(r, 1, "2026-11-10")["status"] == "upcoming"
    assert row(r, 1)["adherence_pct"] is None and r["adherence_6m_pct"] is None
    r2 = P.sip_adherence(sips, [], INSTRUMENTS, date(2026, 11, 15))
    assert inst(r2, 1, "2026-11-10")["status"] == "missed"


def test_skipped_via_kwarg():
    sips = [plan(3, start_date="2026-10-01")]
    txns = [buy(1, 7, "2026-10-05", 5000)]
    r = P.sip_adherence(sips, txns, INSTRUMENTS, TODAY, skipped={("3", "2026-11-05")})
    assert inst(r, 3, "2026-11-05")["status"] == "skipped"
    assert row(r, 3)["adherence_pct"] == 100.0 and row(r, 3)["missed_count"] == 0
    assert r["planned_this_month"] == 0
    # an int plan id works too, and a done instalment stays done even if marked skipped
    r2 = P.sip_adherence(sips, txns, INSTRUMENTS, TODAY, skipped={(3, "2026-10-05"), (3, "2026-11-05")})
    assert inst(r2, 3, "2026-10-05")["status"] == "done"
    assert inst(r2, 3, "2026-11-05")["status"] == "skipped"


def test_epf_plans_dropped_when_passbook_imported():
    sips = [plan(1, start_date="2026-10-01"),
            plan(2, instrument_id=9, segment=d.SEG_EPF, amount=3600, start_date="2026-10-01"),
            plan(3, instrument_id=None, segment=d.SEG_EPF, amount=1800, start_date="2026-10-01")]
    manual = [buy(1, 9, "2026-10-05", 3600, source=None)]
    r = P.sip_adherence(sips, manual, INSTRUMENTS, TODAY)
    assert [p["id"] for p in r["plans"]] == [1, 2, 3] and r["excluded_epf"] == []
    imported = manual + [buy(2, 9, "2026-09-30", 3600, source="import:epf")]
    r2 = P.sip_adherence(sips, imported, INSTRUMENTS, TODAY)
    assert [p["id"] for p in r2["plans"]] == [1]
    assert r2["excluded_epf"] == [2, 3]
    assert r2["planned_this_month"] == 5000                       # left out of every total
    assert all(e["plan_id"] == 1 for e in r2["next_due"])


def test_step_up_factor():
    p = plan(1, amount=10000, step_up_pct=10, start_date="2024-11-10", day_of_month=10)
    assert P.planned_amount(p, date(2024, 11, 10)) == 10000
    assert round(P.planned_amount(p, date(2025, 11, 9)), 2) == 10000      # not yet a whole year
    assert round(P.planned_amount(p, date(2025, 11, 10)), 2) == 11000
    assert round(P.planned_amount(p, date(2026, 11, 10)), 2) == 12100
    r = P.sip_adherence([p], [buy(1, 7, "2026-11-10", 11000)], INSTRUMENTS, TODAY)
    m = inst(r, 1, "2026-11-10")
    assert m["planned"] == 12100 and m["status"] == "partial"      # 11000 < 95% of 12100
    assert inst(r, 1, "2026-10-10")["planned"] == 11000
    no_start = plan(1, amount=10000, step_up_pct=10, start_date=None, created_at="2025-01-01T00:00:00")
    assert round(P.planned_amount(no_start, date(2026, 2, 1)), 2) == 11000


def test_upcoming_five_days_ahead_across_month_boundary():
    today = date(2026, 11, 27)
    r = P.sip_adherence([plan(1, day_of_month=2)], [], INSTRUMENTS, today)
    assert inst(r, 1, "2026-12-02")["status"] == "upcoming"
    assert r["window"]["end"] == "2026-12-04"
    assert r["planned_this_month"] == 5000                    # December's instalment is not this month's money
    assert row(r, 1)["next_due"] == "2026-12-02"


def test_adherence_6m_weighted_by_amount():
    sips = [plan(1, amount=10000, start_date="2026-11-01"),
            plan(2, instrument_id=8, amount=1000, start_date="2026-11-01")]
    r = P.sip_adherence(sips, [buy(1, 7, "2026-11-05", 10000)], INSTRUMENTS, TODAY)
    assert row(r, 1)["adherence_pct"] == 100.0 and row(r, 2)["adherence_pct"] == 0.0
    assert r["adherence_6m_pct"] == 90.9


def test_buys_before_window_stay_with_their_instalment():
    # weekly on Mondays: the 30 May BUY is in both 25 May's window [22 May, 31 May] and 1 June's [29 May, 7 Jun].
    # 25 May falls before the June window and is not reported, but it is matched first and keeps its BUY.
    sips = [plan(1, frequency="weekly", start_date="2026-05-04")]
    r = P.sip_adherence(sips, [buy(1, 7, "2026-05-30", 5000)], INSTRUMENTS, TODAY)
    assert row(r, 1)["months"][0]["due"] == "2026-06-01"
    assert inst(r, 1, "2026-06-01")["status"] == "missed"


def test_created_at_bounds_a_plan_without_start_date():
    sips = [plan(1, start_date=None, created_at="2026-09-20T08:00:00")]
    r = P.sip_adherence(sips, [], INSTRUMENTS, TODAY)
    assert [m["due"] for m in row(r, 1)["months"]] == ["2026-10-05", "2026-11-05"]


def test_empty_inputs():
    r = P.sip_adherence([], [], [], TODAY)
    assert r["plans"] == [] and r["adherence_6m_pct"] is None and r["next_due"] == []
    assert r["planned_this_month"] == 0 and r["invested_this_month"] == 0


# ── next due ──

def test_next_due_order_and_horizon():
    sips = [plan(2, day_of_month=20), plan(1, day_of_month=20, amount=2000),
            plan(3, frequency="weekly", start_date="2026-11-16", end_date="2026-11-30"),
            plan(4, day_of_month=1, active=0)]
    got = P.next_due(sips, TODAY, horizon=20)
    assert [(e["date"], e["plan_id"]) for e in got] == [
        ("2026-11-16", 3), ("2026-11-20", 1), ("2026-11-20", 2), ("2026-11-23", 3), ("2026-11-30", 3)]
    assert got[1] == {"date": "2026-11-20", "plan_id": 1, "name": "Plan 1", "amount": 2000}


def test_adherence_next_due_drops_paid_instalments():
    sips = [plan(1, day_of_month=20, start_date="2026-11-01")]
    r = P.sip_adherence(sips, [buy(1, 7, "2026-11-18", 5000)], INSTRUMENTS, TODAY)
    assert inst(r, 1, "2026-11-20")["status"] == "done"            # paid two days early
    assert r["next_due"][0]["date"] == "2026-12-20"
    assert row(r, 1)["next_due"] == "2026-12-20"


def test_sip_per_month_matches_forecast():
    from tracker.analytics import forecast
    assert P.SIP_PER_MONTH == forecast.SIP_PER_MONTH


def test_plans_imports_no_forecast():
    import ast
    import inspect
    tree = ast.parse(inspect.getsource(P))
    names = {n.module or "" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
    names |= {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    assert not any("forecast" in n for n in names)
