"""Route regression for every link the pure engines emit (SPEC Part 1 §2 P0.6, §3.4, §3.6; AMENDMENTS A8, A17).

`build_insights`, `build_calendar` and `build_story` run on fixtures that fire (nearly) every rule, and each
link they return must start with a route from the §3.4 page list. The same fixture pins the insight ids,
which are frozen (A8): snoozes, dismissals and action ids key on them.
"""
from datetime import date

import pytest

from tracker import domain as d
from tracker.analytics.calendar import build_calendar
from tracker.analytics.insights import build_insights
from tracker.analytics.portfolio import compute_portfolio
from tracker.analytics.story import build_story

# Part 1 §3.4 page list. A prefix ending in "/" needs a further path segment (/holding/<id>);
# any other prefix must be the whole path or be followed by "/", "?" or "#". "/" is exact-match only.
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


def assert_links_ok(items: list[dict], where: str) -> None:
    bad = [(i.get("id") or i.get("key"), i["link"]) for i in items if i.get("link") is not None and not route_ok(i["link"])]
    assert not bad, f"{where} emits links outside the §3.4 page list: {bad}"


# ── fixture ──

TODAY = date(2026, 2, 20)  # a Q4 day, past the 5th + 4 days, so a monthly SIP due on the 5th counts as missed


def P(id_, ac, name, segment, value, weight, **kw):
    return {"id": id_, "asset_class": ac, "name": name, "segment": segment, "value": value, "weight": weight,
            "is_open": True, "unrealized_pct": None, "first_date": None, "price_at": None, **kw}


def rich_portfolio() -> dict:
    positions = [
        P(1, d.EQUITY, "Infosys", d.SEG_EQ_IN, 300000, 15.0, sector="IT", unrealized_pct=60.0, unrealized=112500,
          first_date="2024-01-01"),
        P(2, d.EQUITY, "Tata Steel", d.SEG_EQ_IN, 100000, 5.0, sector="Metals", unrealized_pct=-30.0, unrealized=-42857,
          first_date="2025-01-01"),
        P(3, d.MUTUAL_FUND, "Index Fund", d.SEG_MF, 200000, 10.0, sub_category="SIP", last_date="2025-12-01",
          price_at="2020-01-01T00:00:00Z", elss={"unlocked_value": 5000, "unlocked_qty": 50.0, "next_unlock": "2027-02-01"}),
        P(4, d.P2P, "LenDen loan", d.SEG_P2P, 30000, 1.5, overdue_days=20, outstanding=8000, at_risk=2000, rate=12.0),
        P(5, d.FIXED_DEPOSIT, "HDFC Bank", d.SEG_FD, 100000, 5.0, days_to_maturity=10, maturity_value=105000,
          maturity_date="2027-01-15"),
        P(6, d.CASH, "US wallet", d.SEG_EQ_US, 17000, 0.8, balance_usd=200.0),
        # hand-priced NPS (no symbol) with a NAV 40 days old: nps:nav-stale, not data:stale-prices (G10)
        P(8, d.NPS, "NPS Tier I", d.SEG_NPS, 50000, 4.8, price_at="2026-01-11T00:00:00Z"),
    ]
    segments = [
        {"segment": d.SEG_EQ_IN, "value": 400000, "mix_pct": 40.0, "target": 30, "drift": 10.0, "xirr": 14.0},
        {"segment": d.SEG_MF, "value": 200000, "mix_pct": 20.0, "target": 40, "drift": -20.0, "xirr": 11.0},
        {"segment": d.SEG_FD, "value": 100000, "mix_pct": 10.0, "target": 10, "drift": 0.0, "xirr": 7.0},
        {"segment": d.SEG_COMMODITY, "value": 300000, "mix_pct": 30.0, "target": 20, "drift": 10.0, "xirr": 9.0},
        {"segment": d.SEG_P2P, "value": 30000, "mix_pct": None, "target": None, "drift": None, "xirr": 3.0},
        {"segment": d.SEG_EQ_US, "value": 17000, "mix_pct": None, "target": None, "drift": None, "xirr": None},
    ]
    return {"totals": {"value": 1047000, "xirr": 13.0, "missing_prices": ["Gold ETF"]},
            "segments": segments, "positions": positions}


TAX = {"estimate": {"total": 50000},
       "opportunities": {"ltcg_harvest": {"suggested_booking": 80000, "remaining_exemption": 80000},
                         "loss_harvest_offsettable": 20000,
                         "upcoming_long_term": [{"instrument_id": 1, "name": "Infosys", "date": "2026-01-09",
                                                 "lt_on": "2027-01-10", "days_to_lt": 19, "tax_saving": 2500}]}}
GOALS = [{"id": 7, "name": "House", "target_amount": 5000000, "target_date": "2027-06-30", "monthly_contribution": 10000,
          "projection": {"status": "off_track", "probability": 30.0, "required_sip": 40000}}]
SIPS = [{"id": 9, "name": "Index Fund", "instrument_id": 3, "amount": 5000, "frequency": "monthly", "day_of_month": 5,
         "active": 1}]
HISTORY = {"days": 400, "current_drawdown": -12.0}
BENCH_BEHIND = [{"key": "NIFTY50", "excess_xirr": -4.0, "end_value": 1200000}]


def rich_insights(**kw):
    return build_insights(rich_portfolio(), TAX, GOALS, {}, HISTORY, BENCH_BEHIND, today=TODAY, sips=SIPS, txns=[], **kw)


# Frozen ids (A8). W3-B7 and later waves must keep this passing: add ids, never rename them.
PINNED_IDS = {
    "drift:Equity (India)", "drift:Mutual Funds", "drift:Commodity",
    "concentration:1", "sector:IT", "diversification:stocks", "winner:1", "loser:2",
    "p2p:overdue", "p2p:defaulted", "p2p:yield", "fd:maturing:5", "cash:usd",
    "tax:ltcg-harvest", "tax:loss-harvest", "tax:wait-lt:1:2026-01-09", "elss:unlocked:3",
    "data:missing-prices", "data:stale-prices", "sip:gap:3", "sip:missed:9", "review:due", "goal:7",
    "perf:vs-nifty", "perf:drawdown", "perf:xirr", "nps:nav-stale:8",
}

# §3.6 backend remap, pinned per insight
EXPECTED_LINKS = {
    "drift:Equity (India)": "/risk#rebalance", "drift:Mutual Funds": "/risk#rebalance", "drift:Commodity": "/risk#rebalance",
    "review:due": "/actions?tab=review", "sector:IT": "/risk#concentration", "sip:missed:9": "/recurring",
    "goal:7": "/plan?tab=goals#goal-7", "perf:vs-nifty": "/performance", "perf:drawdown": "/performance",
    "perf:xirr": "/performance", "concentration:1": "/holding/1", "winner:1": "/holding/1", "loser:2": "/holding/2",
    "elss:unlocked:3": "/holding/3", "sip:gap:3": "/holding/3", "p2p:overdue": "/p2p", "p2p:defaulted": "/p2p",
    "p2p:yield": "/p2p", "fd:maturing:5": "/fixed-deposits", "cash:usd": "/forex", "tax:ltcg-harvest": "/tax",
    "tax:loss-harvest": "/tax", "tax:wait-lt:1:2026-01-09": "/tax", "data:missing-prices": "/settings#prices",
    "data:stale-prices": "/settings#prices", "diversification:stocks": "/holdings/equity", "nps:nav-stale:8": "/nps",
}


# ── the checker itself ──

@pytest.mark.parametrize("link", ["/", "/actions", "/plan?tab=goals", "/holdings/all", "/holding/12", "/risk#rebalance",
                                  "/recurring", "/settings#prices", "/markets?tab=watchlist", "/performance"])
def test_route_ok_accepts_page_list_routes(link):
    assert route_ok(link)


@pytest.mark.parametrize("link", ["/insights#rebalance", "/analytics", "/analytics#risk", "/goals", "/forecast?tab=sips",
                                  "/insights", "/holdings", "/holding/", "/planner", "/riskier", "/x", "", "/?tab=x"])
def test_route_ok_rejects_old_and_unknown_routes(link):
    assert not route_ok(link)


# ── insights ──

def test_insight_ids_are_pinned_on_a_rich_fixture():
    ids = [i["id"] for i in rich_insights()]
    assert len(ids) == len(set(ids))
    assert set(ids) == PINNED_IDS


def test_insight_links_are_remapped_to_page_list_routes():
    items = rich_insights()
    assert_links_ok(items, "build_insights")
    assert {i["id"]: i["link"] for i in items} == EXPECTED_LINKS


def test_insight_edge_states_keep_ids_and_valid_links():
    port = rich_portfolio()
    for s in port["segments"]:
        s["target"] = s["drift"] = s["mix_pct"] = None
    ahead = [{"key": "NIFTY50", "excess_xirr": 4.0, "end_value": 900000}]
    items = build_insights(port, TAX, GOALS, {"lastReviewDate": "2026-02-01"}, HISTORY, ahead, today=TODAY,
                           sips=SIPS, txns=[])
    by_id = {i["id"]: i for i in items}
    # W3-B7 points targets:missing at the mix section of Risk (D11; E19 still redirects it to /settings)
    assert by_id["targets:missing"]["link"] == "/risk#mix"
    assert by_id["perf:vs-nifty"]["severity"] == "positive" and by_id["perf:vs-nifty"]["link"] == "/performance"
    assert "review:due" not in by_id and not any(i.startswith("drift:") for i in by_id)
    assert_links_ok(items, "build_insights (no targets)")

    empty = {"totals": {"value": 0}, "segments": [], "positions": []}
    items = build_insights(empty, None, [], {}, today=TODAY)
    assert [(i["id"], i["link"]) for i in items] == [("empty", "/transactions")]


def test_build_insights_accepts_the_reserved_kwargs_and_ignores_them():
    base = rich_insights()
    with_kw = rich_insights(cushion={"months": 2.0}, risk_est={"vol": 18.0}, stress={"scenarios": []},
                            snapshot_then={"value": 900000}, adherence=[{"sip_id": 9, "status": "missed"}],
                            book={"realized": 1000})
    assert with_kw == base
    # The positional call shape used by services.py keeps working
    positional = build_insights(rich_portfolio(), TAX, GOALS, {}, HISTORY, BENCH_BEHIND, TODAY, SIPS, [])
    assert positional == base


# ── calendar ──

def test_calendar_links_are_page_list_routes():
    cal = build_calendar(rich_portfolio(), TAX, GOALS, today=date(2026, 11, 3), horizon_days=400)
    events = cal["events"]
    assert_links_ok(events, "build_calendar")
    by_key = {e["key"]: e["link"] for e in events}
    assert by_key["diwali"] == "/risk#rebalance" and by_key["fy_start"] == "/risk#rebalance"
    assert by_key["goal:7"] == "/plan?tab=goals"
    assert by_key["dhanteras"] == "/holdings/commodity" and by_key["fd:5"] == "/fixed-deposits"
    assert by_key["elss:3"] == "/holding/3" and by_key["lt:1:2026-01-09"] == "/tax"
    assert {"advance_tax_3", "fy_end", "itr_due", "republic_day"} <= set(by_key)


# ── story ──

def test_story_links_are_page_list_routes():
    def T(id_, iid, date_, qty, amount):
        return {"id": id_, "instrument_id": iid, "date": date_, "type": d.BUY, "quantity": qty, "amount": amount,
                "amount_fc": None, "principal": None, "fees": None, "owner": "a"}

    def I(id_, name, price):
        return {"id": id_, "owner": "a", "asset_class": d.EQUITY, "name": name, "currency": "INR", "status": "active",
                "last_price": price, "tax_class": d.TAX_EQUITY}

    inst = [I(1, "Winner", 30.0), I(2, "Loser", 5.0)]
    txns = [T(1, 1, "2026-01-10", 1000, 10000), T(2, 2, "2026-02-10", 1000, 10000), T(3, 1, "2026-03-10", 100, 2000)]
    port = compute_portfolio(inst, txns, None, today=date(2026, 6, 15))
    perf = {"metrics": {"xirr": 50.0, "start": "2026-01-10"},
            "benchmarks": [{"key": "NIFTY50", "label": "Nifty 50", "xirr": 8.0, "end_value": 23000.0, "excess_xirr": 42.0}]}
    takeaways = build_story(port, txns, perf, today=date(2026, 6, 15))["takeaways"]
    assert_links_ok(takeaways, "build_story")
    by_key = {t["key"]: t["link"] for t in takeaways}
    assert by_key == {"market": "/performance", "driver": "/holding/1", "drag": "/holding/2", "rhythm": "/transactions",
                      "milestone": "/plan?tab=goals"}
