"""calendar.upcoming: the 90-day "Coming up" list with arriving and leaving money (SPEC Part 1 P1.5, §7.1;
AMENDMENTS G2, G13).

The inputs are built the way W4-B1 will build them: `build_calendar(..., horizon_days=90)`,
`forecast.cash_flow_forecast(..., months=4)`, `plans.next_due(sips, today, 90)` and `ipos` table rows.

The festivals tests at the end cover `data/festivals.json` and its loader (AMENDMENTS K17), including the
yearly expiry reminder.
"""
import json
from datetime import date, timedelta

import pytest

from tracker import domain as d
from tracker.analytics import calendar as cal
from tracker.analytics import plans
from tracker.analytics.calendar import UPCOMING_KIND_ORDER, build_calendar, upcoming
from tracker.analytics.forecast import cash_flow_forecast

TODAY = date(2026, 11, 14)          # window [2026-11-14, 2027-02-12]; Republic Day (26 Jan) falls inside
END = TODAY + timedelta(days=90)

# A local copy of test_links.ALLOWED_PREFIXES / route_ok (Part 1 §3.4 page list); kept in step by hand.
ALLOWED_PREFIXES = ("/actions", "/plan", "/holdings/", "/holding/", "/p2p", "/fixed-deposits", "/forex", "/epf",
                    "/nps", "/performance", "/risk", "/tax", "/recurring", "/cash-flows", "/transactions", "/import",
                    "/markets", "/reports", "/settings")


def route_ok(link: str) -> bool:
    if link == "/":
        return True
    for p in ALLOWED_PREFIXES:
        if p.endswith("/"):
            if link.startswith(p) and len(link) > len(p) and link[len(p)] not in "/?#":
                return True
        elif link == p or (link.startswith(p) and link[len(p)] in "/?#"):
            return True
    return False


# ── fixture ──

def fd_position(id_, name, maturity, invested=100000, maturity_value=105000):
    return {"id": id_, "asset_class": d.FIXED_DEPOSIT, "name": name, "segment": d.SEG_FD, "value": invested,
            "weight": 5.0, "is_open": True, "invested": invested, "maturity_value": maturity_value,
            "maturity_date": maturity, "first_date": "2025-12-20"}


def portfolio(positions):
    return {"totals": {"value": 1000000},
            "segments": [{"segment": d.SEG_EQ_IN, "value": 800000, "mix_pct": 80.0, "target": 70},
                         {"segment": d.SEG_COMMODITY, "value": 100000, "mix_pct": 10.0, "target": 10},
                         {"segment": d.SEG_FD, "value": 100000, "mix_pct": 10.0, "target": 20}],
            "positions": positions}


def sip(pid, name, amount=5000, dom=5, **kw):
    return {"id": pid, "name": name, "instrument_id": None, "segment": d.SEG_MF, "amount": amount,
            "frequency": "monthly", "day_of_month": dom, "step_up_pct": None, "start_date": "2026-01-01",
            "end_date": None, "active": 1, "created_at": "2026-01-01T09:00:00", **kw}


def ipo(id_, name, applied=0, **dates):
    row = {"id": id_, "owner": "me", "name": name, "open_date": None, "close_date": None,
           "allotment_date": None, "listing_date": None, "applied": applied}
    row.update(dates)
    return row


@pytest.fixture()
def inputs():
    # FD 5 matures in the window and is known to both sources; FD 6 matures after the window
    positions = [fd_position(5, "HDFC Bank", "2026-12-20"), fd_position(6, "SBI", "2027-03-01")]
    instruments = [{"id": p["id"], "name": p["name"], "asset_class": d.FIXED_DEPOSIT, "maturity_date": p["maturity_date"],
                    "rate": 7.0} for p in positions]
    sips = [sip(1, "Index Fund"), sip(2, "Flexi Cap", amount=3000, dom=20)]
    cal = build_calendar(portfolio(positions), None, [], today=TODAY, horizon_days=90)
    cash = cash_flow_forecast(positions, instruments, [], sips, months=4, today=TODAY)
    due = plans.next_due(sips, TODAY, 90)
    ipos = [ipo(1, "Acme", open_date="2026-11-18", close_date="2026-11-20", allotment_date="2026-11-21",
                listing_date="2026-11-25")]
    return cal, cash, due, ipos


# ── tests ──

def test_shape_and_pass_through(inputs):
    cal, cash, due, ipos = inputs
    up = upcoming(cal, cash, due, ipos, TODAY)
    assert set(up) == {"inflow_90d", "outflow_90d", "theme", "next_festival", "events"}
    assert up["theme"] == cal["theme"] and up["next_festival"] == cal["next_festival"]
    for e in up["events"]:
        assert {"date", "days", "kind", "title", "amount", "direction", "link", "key"} <= set(e)
        assert set(e) - {"date", "days", "kind", "title", "amount", "direction", "link", "key"} <= {"note"}
        assert e["kind"] in UPCOMING_KIND_ORDER
        assert e["direction"] in ("in", "out", None)
        assert e["days"] == (date.fromisoformat(e["date"]) - TODAY).days
    sips = [e for e in up["events"] if e["kind"] == "sip"]
    assert sips and all(e["direction"] == "out" and e["link"] == "/recurring" and e["amount"] > 0 for e in sips)
    assert {e["key"] for e in sips} == {f"sip:{s['plan_id']}:{s['date']}" for s in due}
    ipo_events = [e for e in up["events"] if e["kind"] == "ipo"]
    assert {e["key"] for e in ipo_events} == {"ipo:1:open_date", "ipo:1:close_date", "ipo:1:allotment_date",
                                              "ipo:1:listing_date"}
    assert all(e["amount"] is None and e["direction"] is None and e["link"] == "/markets?tab=watchlist"
               for e in ipo_events)
    assert next(e for e in ipo_events if e["key"] == "ipo:1:close_date")["note"] == "Last day to apply."


def test_fd_maturity_listed_once_with_the_cash_flow_amount(inputs):
    cal, cash, due, ipos = inputs
    # both sources list FD 5 on the same date
    assert any(e["key"] == "fd:5" for e in cal["events"])
    assert any(e["kind"] == "fd_maturity" and e["instrument_id"] == 5 for e in cash["events"])
    up = upcoming(cal, cash, due, ipos, TODAY)
    fds = [e for e in up["events"] if e["kind"] == "fd_maturity"]
    assert len(fds) == 1
    fd = fds[0]
    assert fd["key"] == "fd:5" and fd["date"] == "2026-12-20" and fd["direction"] == "in"
    assert fd["link"] == "/fixed-deposits" and fd["amount"] == pytest.approx(105000)
    assert not any(e["kind"] == "personal" and e["key"].startswith("fd:") for e in up["events"])


def test_calendar_only_fd_becomes_fd_maturity_without_amount():
    cal = {"theme": None, "next_festival": None,
           "events": [{"date": "2026-12-01", "key": "fd:9", "title": "FD matures · Axis", "kind": "personal",
                       "note": "About ₹1,00,000 will be credited.", "link": "/fixed-deposits", "days": 17}]}
    # a cash-flow maturity for the same FD on another date does not hide it: dedupe is by (instrument, date)
    cash = {"months": [], "events": [{"date": "2026-12-02", "kind": "fd_maturity", "name": "Axis", "amount": 100500.0,
                                      "note": "FD matures", "instrument_id": 9}]}
    up = upcoming(cal, cash, [], [], TODAY)
    fds = [e for e in up["events"] if e["kind"] == "fd_maturity"]
    assert [(e["date"], e["amount"]) for e in fds] == [("2026-12-01", None), ("2026-12-02", 100500.0)]
    assert all(e["direction"] == "in" and e["key"] == "fd:9" for e in fds)


def test_totals_sum_cash_flow_rows_and_prorate_the_last_month():
    # END is 2027-02-12: Nov, Dec and Jan count in full, Feb counts 12/28, Oct and Mar not at all
    rows = [("2026-10", 999, 999), ("2026-11", 1000, 100), ("2026-12", 2000, 200), ("2027-01", 3000, 300),
            ("2027-02", 2800, 280), ("2027-03", 999, 999)]
    cash = {"months": [{"month": m, "inflow": i, "outflow": o} for m, i, o in rows], "events": []}
    up = upcoming({"events": []}, cash, [], [], TODAY)
    assert END == date(2027, 2, 12)
    assert up["inflow_90d"] == pytest.approx(1000 + 2000 + 3000 + 2800 * 12 / 28)
    assert up["outflow_90d"] == pytest.approx(100 + 200 + 300 + 280 * 12 / 28)


def test_totals_from_a_real_cash_flow_include_money_without_events(inputs):
    cal, cash, due, ipos = inputs
    up = upcoming(cal, cash, due, ipos, TODAY)
    # rows: Nov, Dec, Jan in full, Feb pro rata. SIPs land on their due dates (§6.6 rule 6): November holds
    # only the 3,000 due on the 20th (the 5th is past); Dec and Jan hold both (8,000); Feb counts 12/28.
    assert [r["month"] for r in cash["months"]] == ["2026-11", "2026-12", "2027-01", "2027-02"]
    assert up["outflow_90d"] == pytest.approx(3000 + 2 * 8000 + 8000 * 12 / 28, abs=0.01)
    # the FD comes back in December: principal + interest, all of it inside the window
    assert up["inflow_90d"] == pytest.approx(105000, abs=0.01)
    assert sum(e["amount"] for e in up["events"] if e["direction"] == "in" and e["amount"] is not None) \
        <= up["inflow_90d"] + 0.01
    assert upcoming(cal, None, due, ipos, TODAY)["inflow_90d"] is None  # no cash flow: unknown, not zero


def test_ninety_day_cutoff():
    sips = [sip(1, "Weekly", frequency="weekly", start_date="2026-11-16")]
    due = plans.next_due(sips, TODAY, 120)  # more than the window, on purpose
    assert any(date.fromisoformat(s["date"]) > END for s in due)
    ipos = [ipo(2, "Edge", open_date=END.isoformat(), close_date=(END + timedelta(days=1)).isoformat())]
    cash = {"months": [], "events": [
        {"date": END.isoformat(), "kind": "p2p_close", "name": "2 P2P loans", "amount": 8000.0, "note": "repaid",
         "instrument_id": None},
        {"date": (END + timedelta(days=1)).isoformat(), "kind": "fd_maturity", "name": "Late", "amount": 1.0,
         "note": "", "instrument_id": 3}]}
    up = upcoming({"events": []}, cash, due, ipos, TODAY)
    assert up["events"] and all(TODAY <= date.fromisoformat(e["date"]) <= END for e in up["events"])
    assert max(e["days"] for e in up["events"]) == 90
    assert "ipo:2:open_date" in {e["key"] for e in up["events"]}
    assert "ipo:2:close_date" not in {e["key"] for e in up["events"]}
    p2p = next(e for e in up["events"] if e["kind"] == "p2p_close")
    assert p2p["key"] == f"p2p:{END.isoformat()[:7]}" and p2p["direction"] == "in" and p2p["link"] == "/p2p"
    assert not any(e["kind"] == "fd_maturity" for e in up["events"])


def test_national_days_are_dropped(inputs):
    cal, cash, due, ipos = inputs
    assert any(e["kind"] == "national" and e["key"] == "republic_day" for e in cal["events"])
    up = upcoming(cal, cash, due, ipos, TODAY)
    assert not any(e["kind"] == "national" for e in up["events"])
    keys = {e["key"] for e in up["events"]}
    assert "republic_day" not in keys and "advance_tax_3" in keys  # other calendar events stay
    tax = next(e for e in up["events"] if e["key"] == "advance_tax_3")
    assert tax["kind"] == "tax" and tax["link"] == "/tax" and tax["amount"] is None and tax["direction"] is None
    assert tax["note"]


def test_past_events_and_overdue_alerts_are_dropped():
    yesterday = (TODAY - timedelta(days=1)).isoformat()
    cal = {"events": [{"date": yesterday, "key": "diwali", "title": "Diwali", "kind": "festival", "note": "",
                       "link": "/risk#rebalance", "days": -1},
                      {"date": TODAY.isoformat(), "key": "itr_due", "title": "Today", "kind": "tax", "note": "n",
                       "link": "/tax", "days": 0}]}
    cash = {"months": [], "events": [
        {"date": "2026-09-30", "kind": "p2p_overdue", "name": "1 P2P loan", "amount": 5000.0, "note": "past maturity",
         "instrument_id": None},
        {"date": "2026-12-15", "kind": "p2p_overdue", "name": "odd", "amount": 1.0, "note": "", "instrument_id": None},
        {"date": yesterday, "kind": "fd_maturity", "name": "Old", "amount": 1.0, "note": "", "instrument_id": 4}]}
    due = [{"date": yesterday, "plan_id": 1, "name": "Late SIP", "amount": 100.0}]
    ipos = [ipo(3, "Gone", open_date="2026-11-01", close_date=yesterday, listing_date="2026-11-14T10:00:00")]
    up = upcoming(cal, cash, due, ipos, TODAY)
    assert [e["key"] for e in up["events"]] == ["itr_due", "ipo:3:listing_date"]  # today counts, with days 0
    assert all(e["days"] == 0 for e in up["events"])


def test_sort_by_date_then_kind_and_cap_at_thirty():
    day = "2026-12-05"
    kinds = ["personal", "festival", "fy", "tax"]
    cal = {"events": [{"date": day, "key": f"k:{k}", "title": k, "kind": k, "note": "", "link": "/tax", "days": 21}
                      for k in kinds] + [{"date": day, "key": "fd:8", "title": "FD", "kind": "personal", "note": "",
                                          "link": "/fixed-deposits", "days": 21}]}
    cash = {"months": [], "events": [{"date": day, "kind": "p2p_close", "name": "1 P2P loan", "amount": 10.0,
                                      "note": "", "instrument_id": None}]}
    due = [{"date": day, "plan_id": 1, "name": "A", "amount": 10.0}]
    ipos = [ipo(4, "Same", open_date=day)]
    up = upcoming(cal, cash, due, ipos, TODAY)
    assert [e["kind"] for e in up["events"]] == list(UPCOMING_KIND_ORDER)

    # 40 weekly instalments across plans: the list is cut to 30, earliest first
    many = [sip(i, f"W{i}", frequency="weekly", start_date="2026-11-14") for i in range(1, 6)]
    due = plans.next_due(many, TODAY, 90)
    assert len(due) > 30
    up = upcoming({"events": []}, None, due, [], TODAY)
    assert len(up["events"]) == 30
    order = [(e["date"], e["key"]) for e in up["events"]]
    assert order == sorted(order)
    assert up["events"][-1]["date"] <= sorted(s["date"] for s in due)[30]


def test_every_upcoming_link_is_a_known_route(inputs):
    cal, cash, due, ipos = inputs
    cash = dict(cash, events=cash["events"] + [{"date": "2026-12-10", "kind": "p2p_close", "name": "2 P2P loans",
                                                 "amount": 9000.0, "note": "", "instrument_id": None}])
    up = upcoming(cal, cash, due, ipos, TODAY)
    kinds = {e["kind"] for e in up["events"]}
    assert {"sip", "fd_maturity", "p2p_close", "ipo", "tax"} <= kinds
    bad = [(e["key"], e["link"]) for e in up["events"] if e["link"] is not None and not route_ok(e["link"])]
    assert not bad, f"upcoming emits links outside the §3.4 page list: {bad}"


def _txn(i, iid, dt, typ, amt, qty=None):
    return {"id": i, "instrument_id": iid, "date": dt, "type": typ, "quantity": qty, "amount": amt, "amount_fc": None,
            "principal": None, "fees": None, "owner": "a"}


def _real_cash_flow(inst, txns, today):
    from tracker.analytics.portfolio import compute_portfolio
    port = compute_portfolio(inst, txns, None, today=today)
    return cash_flow_forecast(port["positions"], inst, txns, [], months=4, today=today)


def test_p2p_close_is_a_date_not_the_outstanding_principal():
    """Wave-3 review: the folded close carried the loans' whole outstanding principal as '+₹X' on the close
    date, although that money arrives as EMIs over the months before it (and is already in inflow_90d)."""
    inst = [{"id": 3, "owner": "a", "asset_class": d.P2P, "name": "Loan A", "currency": "INR", "status": "active",
             "rate": 12.0, "tenure_months": 6, "maturity_date": "2027-01-10", "tax_class": d.TAX_INCOME}]
    cash = _real_cash_flow(inst, [_txn(1, 3, "2026-07-10", d.BUY, 12000)], TODAY)
    folded = next(e for e in cash["events"] if e["kind"] == "p2p_close")
    assert folded["instrument_id"] is None and folded["count"] == 1 and folded["amount"] == 12000
    up = upcoming({"events": []}, cash, [], [], TODAY)
    p2p = next(e for e in up["events"] if e["kind"] == "p2p_close")
    assert p2p["title"] == "1 P2P loan finishes repaying" and p2p["key"] == "p2p:2027-01"
    assert p2p["amount"] is None and p2p["direction"] == "in" and p2p["link"] == "/p2p"
    assert "12,000" not in p2p.get("note", "")
    # the 12,000 comes back as two EMIs (Dec, Jan): January brings about half, never 12,000 on the 10th
    jan = next(r for r in cash["months"] if r["month"] == "2027-01")
    assert 0 < jan["inflow"] < 7000 and up["inflow_90d"] > 0
    # the event amounts never claim more money than the window's own total
    assert sum(e["amount"] for e in up["events"] if e["direction"] == "in" and e["amount"] is not None) <= up["inflow_90d"]

    # several loans in one month: plural; a named single loan keeps its own title
    two = dict(folded, count=2, name="2 P2P loans")
    assert upcoming({}, {"months": [], "events": [two]}, [], [], TODAY)["events"][0]["title"] == "2 P2P loans finish repaying"
    named = dict(folded, instrument_id=3, name="Loan A")
    ev = upcoming({}, {"months": [], "events": [named]}, [], [], TODAY)["events"][0]
    assert ev["title"] == "Loan A is fully repaid" and ev["key"] == "p2p:3" and ev["amount"] is None


def test_epf_contribution_already_paid_this_month_is_not_counted_again():
    """Wave-3 review: today's month row counts in full, so an EPF contribution already recorded this month
    must not be projected into it again."""
    today = date(2026, 11, 29)                       # window 2026-11-29 … 2027-02-27
    epf = [{"id": 4, "owner": "a", "asset_class": d.EPF, "name": "EPF", "currency": "INR", "status": "active",
            "rate": 8.25, "tax_class": d.TAX_EXEMPT}]
    paid = [_txn(1, 4, "2026-09-25", d.BUY, 10000), _txn(2, 4, "2026-10-25", d.BUY, 10000),
            _txn(3, 4, "2026-11-25", d.BUY, 10000)]
    cash = _real_cash_flow(epf, paid, today)
    rows = {r["month"]: r for r in cash["months"]}
    assert rows["2026-11"]["contributions"] == 0 and rows["2026-12"]["contributions"] == 10000
    up = upcoming({"events": []}, cash, [], [], today)
    assert up["outflow_90d"] == pytest.approx(10000 + 10000 + 10000 * 27 / 28, abs=0.01)   # Dec, Jan, 27/28 of Feb
    # not yet paid this month: November's contribution is still to come and counts
    cash = _real_cash_flow(epf, paid[:2], date(2026, 11, 20))
    assert cash["months"][0]["month"] == "2026-11" and cash["months"][0]["contributions"] == 10000


def test_empty_inputs():
    up = upcoming(None, None, None, None, TODAY)
    assert up == {"inflow_90d": None, "outflow_90d": None, "theme": None, "next_festival": None, "events": []}
    up = upcoming({"events": []}, {"months": [], "events": []}, [], [], TODAY)
    assert up["inflow_90d"] == 0 and up["outflow_90d"] == 0 and up["events"] == []


# ── festivals.json (SPEC Part 1 §2 P3 festival row; AMENDMENTS K17) ──

# The inline list calendar.py held before the file existed: the loaded file must reproduce it exactly.
OLD_FESTIVALS = [
    ("2026-11-06", "dhanteras", "Dhanteras", "gold"),
    ("2026-11-08", "diwali", "Diwali · Lakshmi Puja", "muhurat"),
    ("2027-05-09", "akshaya_tritiya", "Akshaya Tritiya", "gold"),
]


def _festivals_doc():
    with open(cal.FESTIVALS_FILE, encoding="utf-8") as fh:
        return json.load(fh)


def test_festivals_file_has_a_date_more_than_180_days_ahead():
    """A deliberate yearly reminder: when this fails, add next year's lunar-calendar dates (Dhanteras, Diwali,
    Akshaya Tritiya) to tracker/data/festivals.json from a published panchang, each with its source."""
    horizon = date.today() + timedelta(days=180)
    later = [ds for ds, *_ in cal.FESTIVALS if date.fromisoformat(ds) > horizon]
    assert later, (f"festivals.json has no festival after {horizon.isoformat()}; "
                   "add next year's dates from a published panchang")


def test_festivals_file_shape_and_sources():
    doc = _festivals_doc()
    assert doc["version"] == 1 and doc["source"].strip()
    rows = doc["festivals"]
    for r in rows:
        assert set(r) == {"date", "key", "name", "kind", "source"} and r["source"].strip()
        date.fromisoformat(r["date"])
        assert r["kind"] in ("gold", "muhurat")
        assert r["key"] in {k for ws in cal.FESTIVE_WINDOWS.values() for k, _, _ in ws}
    assert len({(r["date"], r["key"]) for r in rows}) == len(rows)
    # the module list is the file, as (date, key, name, kind) tuples sorted by date, and keeps the old dates
    assert cal.FESTIVALS == sorted((r["date"], r["key"], r["name"], r["kind"]) for r in rows)
    assert set(OLD_FESTIVALS) <= set(cal.FESTIVALS)
    have = {(ds, k) for ds, k, *_ in cal.FESTIVALS}
    for ds in ("2027-10-27", "2028-10-15"):
        assert (ds, "dhanteras") in have
    for ds in ("2027-10-29", "2028-10-17"):
        assert (ds, "diwali") in have
    assert ("2028-04-27", "akshaya_tritiya") in have


def test_loader_falls_back_to_no_festivals(tmp_path, capsys):
    assert cal.load_festivals() == cal.FESTIVALS
    cases = {
        "missing.json": None,
        "bad.json": "{not json",
        "list.json": "[]",
        "nokey.json": '{"version": 1}',
        "notlist.json": '{"festivals": {"date": "2027-01-01"}}',
        "baddate.json": '{"festivals": [{"date": "2027-13-40", "key": "diwali", "name": "Diwali", "kind": "muhurat"}]}',
        "blank.json": '{"festivals": [{"date": "2027-10-29", "key": "", "name": "Diwali", "kind": "muhurat"}]}',
        "row.json": '{"festivals": ["2027-10-29"]}',
    }
    for name, text in cases.items():
        path = tmp_path / name
        if text is not None:
            path.write_text(text, encoding="utf-8")
        assert cal.load_festivals(str(path)) == [], name
        assert "Warning: festivals file" in capsys.readouterr().out, name
    ok = tmp_path / "ok.json"
    ok.write_text(json.dumps({"festivals": [
        {"date": "2028-10-17", "key": "diwali", "name": "Diwali", "kind": "muhurat", "source": "x"},
        {"date": "2027-10-29", "key": "diwali", "name": "Diwali", "kind": "muhurat"}]}), encoding="utf-8")
    assert cal.load_festivals(str(ok)) == [("2027-10-29", "diwali", "Diwali", "muhurat"),
                                           ("2028-10-17", "diwali", "Diwali", "muhurat")]
    assert capsys.readouterr().out == ""


def test_calendar_with_no_festivals_still_builds(monkeypatch):
    monkeypatch.setattr(cal, "FESTIVALS", [])
    out = build_calendar(portfolio([]), None, [], today=date(2026, 11, 4))
    assert out["theme"] is None and out["next_festival"] is None
    assert all(e["kind"] != "festival" for e in out["events"])


@pytest.mark.parametrize("today, horizon", [(date(2026, 11, 4), 75), (TODAY, 90), (date(2027, 4, 20), 75),
                                            (date(2027, 5, 7), 90)])
def test_build_calendar_unchanged_by_the_file(monkeypatch, today, horizon):
    """The loaded file gives exactly the output the inline list gave, wherever the new dates are out of reach."""
    positions = [fd_position(5, "HDFC Bank", "2026-12-20")]
    new = build_calendar(portfolio(positions), None, [], today=today, horizon_days=horizon)
    monkeypatch.setattr(cal, "FESTIVALS", OLD_FESTIVALS)
    old = build_calendar(portfolio(positions), None, [], today=today, horizon_days=horizon)
    assert new == old


def test_build_calendar_pinned_fixture():
    out = build_calendar(portfolio([fd_position(5, "HDFC Bank", "2026-12-20")]), None, [], today=date(2026, 11, 4))
    assert out["theme"] == "diwali"
    assert [(e["date"], e["key"], e["kind"], e["link"]) for e in out["events"]] == [
        ("2026-11-06", "dhanteras", "festival", "/holdings/commodity"),
        ("2026-11-08", "diwali", "festival", "/risk#rebalance"),
        ("2026-12-15", "advance_tax_3", "tax", "/tax"),
        ("2026-12-20", "fd:5", "personal", "/fixed-deposits"),
    ]
    assert out["next_festival"]["key"] == "dhanteras" and out["next_festival"]["days"] == 2
    assert all(route_ok(e["link"]) for e in out["events"] if e["link"])


def test_later_years_get_their_festivals_and_theme():
    """festivals.json holds several years; each year's Dhanteras/Diwali drives that year's events and theme."""
    out = build_calendar(portfolio([]), None, [], today=date(2027, 10, 22), horizon_days=30)
    assert out["theme"] == "diwali"                     # Dhanteras 2027-10-27 is 5 days away (window: 6 before)
    fest = [(e["date"], e["key"]) for e in out["events"] if e["kind"] == "festival"]
    assert fest == [("2027-10-27", "dhanteras"), ("2027-10-29", "diwali")]
    assert out["next_festival"]["date"] == "2027-10-27"
    assert build_calendar(portfolio([]), None, [], today=date(2028, 4, 25))["theme"] == "akshaya_tritiya"
    assert build_calendar(portfolio([]), None, [], today=date(2028, 10, 19))["theme"] == "diwali"
    assert build_calendar(portfolio([]), None, [], today=date(2027, 11, 5))["theme"] is None
