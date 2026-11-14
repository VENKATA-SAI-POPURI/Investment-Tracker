"""actions.py: the rule catalogue, ranking, budgets, log overlay, auto-done and follow-through.

SPEC Part 2 §7.9 (test_actions row), §8.1–§8.5 and Part 1 §1.4–§1.7, as amended by AMENDMENTS A6–A15, A24 and A28.
Everything here is pure: fixtures are plain dicts and nothing touches a database.
"""
import ast
from datetime import date, timedelta
from pathlib import Path

import pytest

from tracker import domain as d
from tracker.analytics import actions as A

TODAY = date(2026, 11, 14)
FY = "FY2026-27"
ME, MEMBER = "me@x.in", "member@x.in"


def iso(days: int) -> str:
    return (TODAY + timedelta(days=days)).isoformat()


# Part 1 §3.4 page list, kept here on purpose (not imported from test_links): a prefix ending in "/" needs a
# further path segment; any other prefix must be the whole path or be followed by "/", "?" or "#".
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


# ── fixtures ──

def P(id_, ac, name, value, owner=ME, **kw):
    seg = kw.pop("segment", None) or {d.EQUITY: d.SEG_EQ_IN, d.MUTUAL_FUND: d.SEG_MF, d.P2P: d.SEG_P2P,
                                      d.FIXED_DEPOSIT: d.SEG_FD, d.CASH: d.SEG_EQ_US, d.NPS: d.SEG_NPS}[ac]
    return {"id": id_, "owner": owner, "asset_class": ac, "name": name, "segment": seg, "value": value,
            "cost": kw.pop("cost", value), "is_open": kw.pop("is_open", True), "has_price": kw.pop("has_price", True),
            "weight": kw.pop("weight", round(value / 10000, 2)), **kw}


def portfolio(extra=()):
    positions = [
        P(1, d.EQUITY, "Infosys", 200000, owner=MEMBER, weight=20.0, sector="IT"),
        P(2, d.FIXED_DEPOSIT, "HDFC Bank", 104000, maturity_date=iso(3), maturity_value=105000, days_to_maturity=3,
          has_price=False),
        P(3, d.FIXED_DEPOSIT, "SBI", 52000, maturity_date=iso(-40), maturity_value=None, days_to_maturity=None,
          has_price=False),
        P(4, d.P2P, "LenDen A", 8000, at_risk=3000, overdue_days=40, outstanding=8000, has_price=False),
        P(5, d.CASH, "USD wallet", 42000, balance_usd=500),
        P(6, d.MUTUAL_FUND, "Index Fund", 60000, cost=60000, has_price=False),
        P(7, d.NPS, "NPS Tier 1", 90000),
        P(8, d.P2P, "LenDen B", 20000, outstanding=20000, overdue_days=0, has_price=False),
        *extra,
    ]
    return {"positions": positions, "segments": [],
            "totals": {"value": 1_000_000, "missing_prices": ["Index Fund"]}}


def I(id_, severity="info", category="review", amount=None, link=None, title=None):
    return {"id": id_, "severity": severity, "category": category, "title": title or id_, "detail": f"{id_} detail",
            "action": f"{id_} action", "link": link, "amount": amount}


def insights():
    return [
        I("data:missing-prices", "warning", "data", link="/settings#prices"),
        I("data:stale-prices", "info", "data", link="/"),
        I("nps:nav-stale:7", "info", "data", 90000, "/nps"),
        I("p2p:defaulted", "warning", "p2p", 3000, "/p2p"),
        I("p2p:overdue", "warning", "p2p", 8000, "/p2p"),
        I("p2p:yield", "warning", "p2p", link="/p2p"),
        I("fd:maturing:2", "info", "fd", 105000, "/fixed-deposits"),
        I("cash:usd", "info", "allocation", 42000, "/forex"),
        I("drift:Mutual Funds", "warning", "allocation", 30000, "/risk#rebalance"),
        I("targets:missing", "info", "allocation", link="/settings"),
        I("concentration:1", "warning", "risk", 200000, "/holding/1"),
        I("sector:IT", "info", "risk", 200000, "/risk#concentration"),
        I("diversification:stocks", "info", "risk"),
        I("elss:unlocked:6", "info", "tax", 5000, "/holding/6"),
        I("sip:gap:6", "info", "habit", link="/holding/6"),
        I("sip:missed:11", "warning", "habit", 5000, "/recurring"),
        I("goal:9", "warning", "goals", 15000, "/plan?tab=goals"),
        I("review:due", "info", "habit", link="/risk#rebalance"),
        I("loser:1", "warning", "performance", 40000, "/holding/1"),
        I("winner:1", "info", "performance", 90000, "/holding/1"),
        I("perf:vs-nifty", "warning", "performance", link="/performance"),
        I("perf:drawdown", "info", "performance", link="/performance"),
        I("perf:xirr", "positive", "performance", link="/performance"),
        I("tax:ltcg-harvest", "info", "tax", 40000, "/tax"),
        I("empty", "info", "data", link="/transactions"),
    ]


def tax(remaining=50000, booking=40000, offsettable=8000, lots=None):
    return {"fy": FY, "tax_lines": [{"group": "ST", "rate": 20.0, "taxable": 30000, "tax": 6000, "slab": False}],
            "opportunities": {
                "ltcg_harvest": {"remaining_exemption": remaining, "suggested_booking": booking,
                                 "future_tax_saved": round(booking * 0.125, 2), "lots": []},
                "loss_harvest_offsettable": offsettable,
                "upcoming_long_term": lots if lots is not None else [
                    {"instrument_id": 1, "name": "Infosys", "date": "2025-12-01", "lt_on": iso(20), "days_to_lt": 20,
                     "tax_saving": 900, "qty": 5}],
            }}


SIPS = [
    {"id": 11, "owner": ME, "instrument_id": 6, "name": "Index SIP", "segment": None, "amount": 5000,
     "frequency": "monthly", "day_of_month": 4, "active": 1, "end_date": None},
    {"id": 12, "owner": ME, "instrument_id": 1, "name": "Infosys SIP", "segment": None, "amount": 2000,
     "frequency": "monthly", "day_of_month": 17, "active": 1, "end_date": None},
    {"id": 13, "owner": ME, "instrument_id": None, "name": "Old plan", "segment": d.SEG_MF, "amount": 1000,
     "frequency": "monthly", "day_of_month": 10, "active": 1, "end_date": "2026-10-01"},
]


def adherence():
    return {"plans": [
        {"id": 11, "name": "Index SIP", "months": [{"month": "2026-11", "due": "2026-11-04", "planned": 5000,
                                                    "invested": 0, "status": "missed"}]},
        {"id": 12, "name": "Infosys SIP", "months": [{"month": "2026-11", "due": "2026-11-17", "planned": 2000,
                                                      "invested": 0, "status": "upcoming"}]},
    ], "adherence_6m_pct": 82.5}


def rich_src(**over):
    src = {
        "owner": ME,
        "port": portfolio(),
        "txns": [{"id": 501, "instrument_id": 8, "type": d.REPAYMENT, "date": iso(-5), "amount": 13000, "principal": 12000}],
        "sips": SIPS,
        "settings": {},
        "insights": insights(),
        "cashflow_events": [{"date": iso(3), "kind": "fd_maturity", "name": "HDFC Bank", "amount": 104900,
                             "instrument_id": 2}],
        "tax": tax(),
        "adherence": adherence(),
        "cushion": {"set": True, "months": 2.0, "target_months": 6, "monthly_expenses": 50000, "amount": 100000,
                    "cash_amount": 0, "instrument_ids": [], "candidates": [], "candidates_amount": 0},
        "deploy": {"suggested": 150000, "sources": []},
        "risk_est": {"vol_pct": 16.0, "target_vol_pct": 9.0, "profile": "balanced", "closest_profile": "aggressive"},
        "stress": {"total": 1_000_000, "scenarios": [{"key": "covid", "impact_pct": -30.0}]},
        "plan": {"goals": [{"id": 9, "name": "House", "target_amount": 5_000_000, "target_date": "2031-01-01",
                            "monthly_contribution": 10000,
                            "projection": {"status": "off_track", "probability": 30.0, "required_sip": 25000}}],
                 "retirement": {"status": "at_risk", "probability": 55.0, "required_sip": 40000,
                                "inputs": {"monthly_sip": 30000}}},
        "snapshot_then": {"date": iso(-30), "data": {"action_ids": ["drift:Mutual Funds"], "goal_probs": {"9": 50.0},
                                                     "retirement_probability": 70.0}},
    }
    src.update(over)
    return src


def by_id(actions):
    return {a["id"]: a for a in actions}


# Every §8.3 rule this wave can fire: id → (category, severity, cta type)
EXPECTED = {
    "data:missing-prices": ("data", "crit", "route"),
    "data:stale-prices": ("data", "warn", "api"),
    "nps:nav-stale:7": ("data", "info", "route"),
    "p2p:defaulted": ("p2p", "crit", "route"),
    "p2p:overdue": ("p2p", "warn", "route"),
    "p2p:yield": ("p2p", "info", "route"),
    "fd:maturing:2": ("fd", "warn", "route"),
    "fd:matured-unrecorded:3": ("fd", "crit", "fd_mature"),
    "cash:usd": ("cash", "info", "route"),
    "cash:p2p-principal:2026-11": ("cash", "info", "route"),
    "deploy:idle": ("allocation", "info", "route"),
    "cushion:low": ("cash", "warn", "route"),
    "drift:Mutual Funds": ("allocation", "warn", "route"),
    "targets:missing": ("allocation", "info", "route"),
    "concentration:1": ("risk", "warn", "route"),
    "sector:IT": ("risk", "warn", "route"),
    "diversification:stocks": ("risk", "info", "route"),
    "risk:above-profile": ("risk", "crit", "route"),
    "stress:beyond-tolerance": ("risk", "warn", "route"),
    f"tax:ltcg-harvest:{FY}": ("tax", "info", "route"),
    f"tax:loss-harvest:{FY}": ("tax", "info", "route"),
    "tax:wait-lt:1:2025-12-01": ("tax", "info", "whatif"),
    "elss:unlocked:6": ("tax", "info", "route"),
    "sip:missed:11:2026-11-04": ("habit", "warn", "dialog"),
    "sip:due:12:2026-11-17": ("habit", "info", "dialog"),
    "sip:ended:13": ("habit", "info", "route"),
    "sip:gap:6": ("habit", "info", "route"),
    "goal:9": ("goals", "crit", "route"),
    "retirement:gap": ("goals", "warn", "route"),
    "plan:probability-drop:9": ("goals", "warn", "route"),
    "plan:probability-drop:retirement": ("goals", "warn", "route"),
    "review:due:2026-Q4": ("review", "info", "api"),
    "loser:1": ("performance", "info", "route"),
    "winner:1": ("performance", "info", "route"),
    "perf:vs-nifty": ("performance", "warn", "route"),
    "perf:drawdown": ("performance", "warn", "route"),
    "perf:xirr": ("performance", "pos", "route"),
}


@pytest.fixture(scope="module")
def rich():
    return A.build_actions(rich_src(), {}, TODAY)


# ── one test per rule: it fires, with a stable id ──

@pytest.mark.parametrize("aid", sorted(EXPECTED))
def test_rule_fires_with_stable_id(rich, aid):
    got = by_id(rich)
    assert aid in got, f"{aid} did not fire; got {sorted(got)}"
    cat, sev, cta_type = EXPECTED[aid]
    a = got[aid]
    assert (a["category"], a["severity"], a["cta"]["type"]) == (cat, sev, cta_type)
    assert aid.startswith(A.ACTION_PREFIXES)
    # the same sources a day later give the same id (no volatile parts beyond the period key)
    again = by_id(A.build_actions(rich_src(), {}, TODAY + timedelta(days=1)))
    assert aid in again or aid.startswith(("sip:due:", "cash:p2p-principal:", "fd:maturing:")), aid


def test_rich_build_emits_nothing_unexpected(rich):
    assert set(by_id(rich)) == set(EXPECTED)
    assert len(rich) == len(by_id(rich)), "ids are unique"
    assert "empty" not in by_id(rich)  # brief.py owns onboard:*


def test_action_shape_matches_8_1(rich):
    keys = {"id", "kind", "tier", "severity", "status", "category", "title", "detail", "why", "assumptions", "impact",
            "due", "days", "confidence", "score", "owner", "instrument_id", "cta", "link", "first_seen", "is_new",
            "done_via", "evidence", "planned_for", "snooze_until", "days_late"}
    for a in rich:
        assert keys <= set(a), a["id"]
        assert not any(k.startswith("_") for k in a)
        assert a["tier"] in A.TIERS and a["confidence"] in A.CONFIDENCE and a["status"] == "open"
        imp = a["impact"]
        if imp is not None:
            assert imp["amount"] > 0 and imp["kind"] in ("lump", "monthly") and "₹" in imp["label"]


def test_impacts_are_real_rupees(rich):
    a = by_id(rich)
    assert a["p2p:defaulted"]["impact"]["amount"] == 3000
    assert a["p2p:overdue"]["impact"]["amount"] == 8000            # outstanding where overdue_days > 30
    assert a["fd:maturing:2"]["impact"]["amount"] == 105000
    assert a["fd:matured-unrecorded:3"]["impact"]["amount"] == 52000
    assert a["data:missing-prices"]["impact"]["amount"] == 60000   # Σ cost of the unpriced holdings
    assert a["concentration:1"]["impact"]["amount"] == pytest.approx(100000)   # (20 − 10)% × ₹10L
    assert a["sector:IT"]["impact"]["amount"] == pytest.approx(140000)          # ₹2L − 30% of ₹2L direct equity
    assert a["cushion:low"]["impact"]["amount"] == 200000          # (6 − 2) × ₹50k
    assert a["stress:beyond-tolerance"]["impact"]["amount"] == pytest.approx(75000)  # (30 − 22.5)% × ₹10L
    assert a[f"tax:ltcg-harvest:{FY}"]["impact"]["amount"] == 5000
    assert a[f"tax:loss-harvest:{FY}"]["impact"]["amount"] == 1600   # 8000 × top rate 20%
    assert a["goal:9"]["impact"] == {"amount": 15000, "kind": "monthly", "label": "+₹15,000/month needed"}
    assert a["retirement:gap"]["impact"]["kind"] == "monthly"
    assert a["cash:p2p-principal:2026-11"]["impact"]["amount"] == 12000
    for aid in ("targets:missing", "p2p:yield", "review:due:2026-Q4", "perf:vs-nifty", "risk:above-profile"):
        assert a[aid]["impact"] is None, aid


def test_p2p_principal_keeps_its_id_across_a_month_and_a_close_carries_over():
    port = {"positions": [P(7, d.P2P, "Loan", 0, is_open=False)], "totals": {"value": 500000}}
    txns = [{"id": 1, "instrument_id": 7, "type": d.REPAYMENT, "date": "2026-11-25", "amount": 15500, "principal": 15000}]
    src = {"owner": ME, "port": port, "txns": txns}
    nov = by_id(A.build_actions(src, {}, date(2026, 11, 28)))
    dec = by_id(A.build_actions(src, {}, date(2026, 12, 2)))
    assert list(nov) == list(dec) == ["cash:p2p-principal:2026-11"]   # the month the money came back
    # dismissed on 28 Nov: the same repayment is not raised again, but new money after the close is
    log = {(ME, "cash:p2p-principal:2026-11"): {"id": "cash:p2p-principal:2026-11", "owner": ME, "status": "dismissed",
                                                "first_seen": "2026-11-28", "updated_at": "2026-11-28T10:00:00Z"}}
    assert A.build_actions(src, log, date(2026, 12, 2)) == []
    more = txns + [{"id": 2, "instrument_id": 7, "type": d.REPAYMENT, "date": "2026-12-05", "amount": 21000,
                    "principal": 20000}]
    after = by_id(A.build_actions({**src, "txns": more}, log, date(2026, 12, 8)))
    assert list(after) == ["cash:p2p-principal:2026-12"] and after["cash:p2p-principal:2026-12"]["impact"]["amount"] == 20000


def test_insight_severity_overrides(rich):
    a = by_id(rich)
    assert a["p2p:defaulted"]["severity"] == "crit"   # the insight says warning
    assert a["p2p:yield"]["severity"] == "info"       # the insight says warning
    assert a["loser:1"]["severity"] == "info"
    assert a["cash:usd"]["category"] == "cash"        # the insight says allocation


def test_is_new_against_the_snapshot(rich):
    a = by_id(rich)
    assert a["drift:Mutual Funds"]["is_new"] is False
    assert a["p2p:defaulted"]["is_new"] is True
    assert all(x["is_new"] is False for x in A.build_actions(rich_src(snapshot_then=None), {}, TODAY))


def test_missing_sources_skip_their_rules():
    only = A.build_actions({"owner": ME, "insights": [I("p2p:defaulted", "warning", "p2p", 3000, "/p2p")]}, {}, TODAY)
    assert [a["id"] for a in only] == ["p2p:defaulted"]
    assert A.build_actions({}, {}, TODAY) == []


# ── ids (A8, A9) ──

def test_action_id_for_insight_period_keys():
    assert A.action_id_for_insight({"id": "tax:ltcg-harvest"}, TODAY) == f"tax:ltcg-harvest:{FY}"
    assert A.action_id_for_insight("tax:loss-harvest", date(2027, 2, 1)) == f"tax:loss-harvest:{FY}"
    assert A.action_id_for_insight("tax:loss-harvest", date(2027, 4, 1)) == "tax:loss-harvest:FY2027-28"
    assert A.action_id_for_insight("review:due", TODAY) == "review:due:2026-Q4"
    assert A.action_id_for_insight("review:due", date(2027, 2, 1)) == "review:due:2027-Q1"
    assert A.action_id_for_insight("sip:missed:11", TODAY, SIPS) == "sip:missed:11:2026-11-04"
    # day_of_month 31 is clamped to the month's end
    plan31 = [{"id": 7, "day_of_month": 31}]
    assert A.action_id_for_insight("sip:missed:7", date(2027, 2, 20), plan31) == "sip:missed:7:2027-02-28"
    assert A.action_id_for_insight("concentration:4", TODAY) == "concentration:4"
    assert A.action_id_for_insight("sip:missed:7:2027-02-28", TODAY) == "sip:missed:7:2027-02-28"


def test_sip_missed_from_insight_and_adherence_is_one_action():
    both = by_id(A.build_actions(rich_src(), {}, TODAY))
    insight_only = by_id(A.build_actions(rich_src(adherence=None), {}, TODAY))
    missed = [k for k in both if k.startswith("sip:missed:")]
    assert missed == ["sip:missed:11:2026-11-04"]
    assert [k for k in insight_only if k.startswith("sip:missed:")] == ["sip:missed:11:2026-11-04"]
    # with adherence, the plans rule is the source (its title, not the insight's)
    assert both["sip:missed:11:2026-11-04"]["title"] != "sip:missed:11"


# ── ranking (§1.7, §8.2) ──

def test_critical_p2p_default_outranks_a_200_tax_saving():
    src = {"owner": ME, "insights": [I("p2p:defaulted", "warning", "p2p", 5000, "/p2p")],
           "tax": tax(remaining=0, booking=0, offsettable=0, lots=[
               {"instrument_id": 1, "name": "X", "date": "2025-12-01", "lt_on": iso(20), "days_to_lt": 20,
                "tax_saving": 200, "qty": 1}])}
    out = A.build_actions(src, {}, TODAY)
    order = [a["id"] for a in out]
    assert order.index("p2p:defaulted") < order.index("tax:wait-lt:1:2025-12-01")
    assert by_id(out)["p2p:defaulted"]["tier"] == "now"


def test_fd_due_in_3_days_outranks_an_undated_info_item():
    src = {"owner": ME, "port": portfolio(),
           "insights": [I("cash:usd", "info", "allocation", 900000, "/forex")]}
    out = A.build_actions(src, {}, TODAY)
    order = [a["id"] for a in out]
    assert order.index("fd:maturing:2") < order.index("cash:usd")
    assert by_id(out)["fd:maturing:2"]["tier"] == "now"
    assert by_id(out)["cash:usd"]["tier"] == "consider"


def _mk(id_, amount=None, days=None, conf="fact", sev="info", cat="tax", kind="lump"):
    return {"id": id_, "severity": sev, "category": cat, "confidence": conf, "days": days, "status": "open",
            "impact": {"amount": amount, "kind": kind, "label": ""} if amount else None}


def test_score_has_a_1000_floor():
    assert A.score(_mk("a", 200)) == A.score(_mk("b", 900)) == A.score(_mk("c")) == 1000 * 0.25 * 1.0
    assert A.score(_mk("d", 5000)) == 5000 * 0.25
    ranked = A.rank([_mk("b", 900), _mk("a", 200), _mk("d", 5000)])
    assert [a["id"] for a in ranked] == ["d", "a", "b"]   # ties broken by id


def test_score_urgency_confidence_and_monthly():
    assert A.score(_mk("x", 10000, days=-5)) == 10000      # overdue → U 1.0
    assert A.score(_mk("x", 10000, days=6)) == 8500
    assert A.score(_mk("x", 10000, days=14)) == 7000
    assert A.score(_mk("x", 10000, days=31)) == 5000
    assert A.score(_mk("x", 10000, days=60)) == 3000
    assert A.score(_mk("x", 10000, conf="model")) == 10000 * 0.25 * 0.6
    assert A.score(_mk("x", 10000, conf="signal")) == 10000 * 0.25 * 0.3
    assert A.score(_mk("m", 2000, kind="monthly")) == 24000 * 0.25


def test_tiers():
    t = lambda **kw: A.tier_of(_mk("x", **kw))  # noqa: E731
    assert t(sev="crit") == "now"
    assert t(days=5) == "now"
    assert t(sev="warn") == "month"
    assert t(days=20) == "month"
    assert t(days=-3) == "month"
    assert t() == "consider"
    assert t(sev="pos", days=2) == "good"
    assert A.tier_of({**_mk("x", cat="data", sev="warn")}, data_act=True) == "now"
    assert A.tier_of({**_mk("x"), "days_late": 2}) == "now"
    ranked = A.rank([_mk("data:x", sev="warn", cat="data")], [{"key": "data", "status": "act"}])
    assert ranked[0]["tier"] == "now"


def test_summary_counts_tiers_and_lump_impacts_only():
    acts = A.rank([_mk("tax:a", 5000, sev="crit"), _mk("tax:b", 3000, sev="warn", kind="monthly"),
                   _mk("tax:c", 7000, sev="warn"), _mk("tax:d", 9000), _mk("tax:e", sev="pos")])
    assert A.summary(acts) == {"now": 1, "month": 2, "consider": 1, "good": 1, "impact_total": 12000,
                               "new": 0, "tax_open": 5}   # _mk's category is tax
    acts[0]["is_new"], acts[1]["category"], acts[2]["status"] = True, "allocation", "dismissed"
    assert (A.summary(acts)["new"], A.summary(acts)["tax_open"]) == (1, 3)


def test_tax_open_counts_tax_moves_not_elss_unlocks():
    """An unlocked ELSS sits in the tax category, but its impact is principal, not tax saved: it is not a tax move
    (W2 review), so it neither lights the Tax badge nor opens the FY-window line."""
    acts = A.rank([_mk("elss:unlocked:6", 6734), _mk(f"tax:loss-harvest:{FY}", 1500, sev="warn")])
    assert A.summary(acts)["tax_open"] == 1
    assert A.summary(A.rank([_mk("elss:unlocked:6", 6734)]))["tax_open"] == 0
    assert A.is_tax_move({"id": "tax:wait-lt:1:2025-12-01", "category": "tax"})
    assert not A.is_tax_move({"id": "elss:unlocked:6", "category": "tax"})


def test_loss_harvest_saving_walks_the_tax_lines_and_never_exceeds_the_tax():
    """W2 review: the offset cancels taxable lines highest rate first; gains already shielded by the exemption or
    taxed lower save nothing extra, so the saving can never exceed the year's capital-gains tax."""
    lines = [{"group": "ST", "rate": 20.0, "taxable": 12614.97, "tax": 2522.99},
             {"group": "ST", "rate": 5.0, "taxable": 4844.32, "tax": 242.22}]
    t = {**tax(offsettable=17459.29), "tax_lines": lines}
    assert A.loss_harvest_saving(t, 17459.29) == pytest.approx(2522.994 + 242.216)   # all of the CG tax, no more
    assert A.loss_harvest_saving(t, 100000) == pytest.approx(2522.994 + 242.216)
    assert A.loss_harvest_saving(t, 10000) == pytest.approx(2000)                     # inside the 20% line
    assert A.loss_harvest_saving(t, 15000) == pytest.approx(12614.97 * 0.2 + (15000 - 12614.97) * 0.05)
    assert A.loss_harvest_saving({**t, "tax_lines": []}, 5000) == 0
    a = by_id(A.build_actions(rich_src(tax=t), {}, TODAY))[f"tax:loss-harvest:{FY}"]
    assert a["impact"]["amount"] == pytest.approx(2765.21, abs=0.01)                  # was 17459.29 × 20% = 3491.86
    # the close rule inverts the walk to recover the offsettable from the stored impact
    for off in (5000.0, 15000.0, 17459.29):
        assert A._offset_for_saving(t, A.loss_harvest_saving(t, off)) == pytest.approx(off)
    act = {"id": f"tax:loss-harvest:{FY}", "impact": a["impact"], "meta": {"first_impact": a["impact"]["amount"]}}
    assert A.auto_done(act, [], None, {**t, "opportunities": {**t["opportunities"], "loss_harvest_offsettable": 3000}},
                       TODAY) is not None                                                   # ≤ 20% of 17,459 left
    assert A.auto_done(act, [], None, {**t, "opportunities": {**t["opportunities"], "loss_harvest_offsettable": 9000}},
                       TODAY) is None


# ── budgets (§1.4, §1.5) ──

def test_diversify_one_per_category_and_one_data_unless_critical():
    acts = [_mk("a1", cat="allocation"), _mk("a2", cat="allocation"), _mk("d1", cat="data", sev="warn"),
            _mk("d2", cat="data", sev="warn"), _mk("d3", cat="data", sev="crit"), _mk("t1", cat="tax")]
    assert [a["id"] for a in A.diversify(acts, k=10)] == ["a1", "d1", "d3", "t1"]
    assert [a["id"] for a in A.diversify(acts)] == ["a1", "d1", "d3"]


def test_for_home_admission():
    acts = A.rank([
        _mk("small", 1500, sev="warn", cat="allocation"),       # below 0.25% of ₹10L = ₹2,500
        _mk("big", 30000, sev="warn", cat="p2p"),
        _mk("soon", None, days=10, sev="info", cat="habit"),    # deadline within 30 days
        _mk("idle", 900000, sev="info", cat="cash"),            # consider tier: never T1
        _mk("goal", None, sev="warn", cat="goals"),             # plan at risk
        _mk("good", 90000, sev="pos", cat="performance"),
        _mk("data", None, sev="warn", cat="data"),
    ])
    home = A.for_home(acts, 1_000_000, "good")
    assert [a["id"] for a in home] == ["big", "soon", "goal"]   # soon: U 0.7 beats undated 0.25
    with_data = A.for_home(acts, 1_000_000, "act")
    assert with_data[0]["id"] == "data" and with_data[0]["tier"] == "now"
    assert len(A.for_home(acts * 3, 1_000_000, "act", k=5)) <= 5
    assert "small" in [a["id"] for a in A.for_home(acts, 100_000, "good", k=10)]  # floor is ₹1,000 there


# ── FD rules (dedupe, A28) ──

def test_fd_maturity_insight_and_cashflow_event_dedupe():
    ev = [{"date": iso(3), "kind": "fd_maturity", "name": "HDFC Bank", "amount": 104900, "instrument_id": 2}]
    ins = [I("fd:maturing:2", "info", "fd", 105000, "/fixed-deposits")]
    for src in ({"owner": ME, "port": portfolio(), "insights": ins, "cashflow_events": ev},
                {"owner": ME, "insights": ins, "cashflow_events": ev},
                {"owner": ME, "cashflow_events": ev + ev}):
        fds = [a for a in A.build_actions(src, {}, TODAY) if a["id"].startswith("fd:maturing:")]
        assert len(fds) == 1 and fds[0]["id"] == "fd:maturing:2"
        assert fds[0]["kind"] == "event"


def test_cashflow_fd_beyond_30_days_does_not_fire():
    ev = [{"date": iso(45), "kind": "fd_maturity", "name": "X", "amount": 1000, "instrument_id": 2}]
    assert A.build_actions({"owner": ME, "cashflow_events": ev}, {}, TODAY) == []


def test_fd_matured_unrecorded_uses_the_maturity_date():
    port = {"positions": [P(3, d.FIXED_DEPOSIT, "SBI", 52000, maturity_date=iso(-5), days_to_maturity=None,
                            maturity_value=None)], "totals": {"value": 52000}}
    a = by_id(A.build_actions({"owner": ME, "port": port}, {}, TODAY))["fd:matured-unrecorded:3"]
    assert a["severity"] == "warn" and a["days"] == -5 and a["cta"] == {"label": "Mark matured", "type": "fd_mature",
                                                                         "instrument_id": 3}
    port["positions"][0]["maturity_date"] = iso(-31)
    assert by_id(A.build_actions({"owner": ME, "port": port}, {}, TODAY))["fd:matured-unrecorded:3"]["severity"] == "crit"


# ── CTAs and links (A7, A13, A14) ──

CTA = {
    "data:missing-prices": ("/settings", None, "prices"),
    "nps:nav-stale:7": ("/nps", None, None),
    "p2p:defaulted": ("/p2p", {"tab": "defaulted"}, None),
    "p2p:overdue": ("/p2p", {"tab": "overdue"}, None),
    "p2p:yield": ("/p2p", None, None),
    "fd:maturing:2": ("/actions", {"new_money": 105000}, "deploy"),
    "cash:usd": ("/actions", {"new_money": 42000}, "deploy"),
    "cash:p2p-principal:2026-11": ("/actions", {"new_money": 12000}, "deploy"),
    "deploy:idle": ("/actions", {"new_money": 150000}, "deploy"),
    "cushion:low": ("/settings", None, "cushion"),
    "drift:Mutual Funds": ("/risk", None, "rebalance"),
    "targets:missing": ("/settings", None, None),
    "concentration:1": ("/holding/1", None, None),
    "sector:IT": ("/risk", None, "concentration"),
    "diversification:stocks": ("/holdings/equity", None, None),
    "risk:above-profile": ("/risk", None, None),
    "stress:beyond-tolerance": ("/risk", None, "stress"),
    f"tax:ltcg-harvest:{FY}": ("/tax", {"tab": "save"}, None),
    f"tax:loss-harvest:{FY}": ("/tax", {"tab": "save"}, None),
    "elss:unlocked:6": ("/holding/6", None, None),
    "sip:ended:13": ("/recurring", None, None),
    "sip:gap:6": ("/holding/6", None, None),
    "goal:9": ("/plan", {"tab": "goals"}, "goal-9"),
    "retirement:gap": ("/plan", {"tab": "retirement"}, None),
    "plan:probability-drop:9": ("/plan", None, None),
    "loser:1": ("/holding/1", None, None),
    "perf:vs-nifty": ("/performance", None, None),
}


@pytest.mark.parametrize("aid", sorted(CTA))
def test_route_cta_for_each_prefix(rich, aid):
    cta = by_id(rich)[aid]["cta"]
    route, query, fragment = CTA[aid]
    assert cta["type"] == "route" and cta["label"]
    assert (cta["route"], cta.get("query"), cta.get("fragment")) == (route, query, fragment)


def test_non_route_ctas(rich):
    a = by_id(rich)
    assert a["data:stale-prices"]["cta"]["api"] == "prices_refresh"
    assert a["review:due:2026-Q4"]["cta"]["api"] == "review_complete"
    assert a["tax:wait-lt:1:2025-12-01"]["cta"]["whatif"] == {"instrument_id": 1, "qty": 5}
    assert a["fd:matured-unrecorded:3"]["cta"]["type"] == "fd_mature"
    dlg = a["sip:missed:11:2026-11-04"]["cta"]["dialog"]
    assert dlg == {"instrumentId": 6, "type": "BUY", "amount": 5000, "date": "2026-11-04"}
    assert a["sip:due:12:2026-11-17"]["cta"]["dialog"]["date"] == "2026-11-17"


def test_link_is_the_evidence_page(rich):
    a = by_id(rich)
    assert a["fd:maturing:2"]["link"] == "/fixed-deposits"
    assert a["fd:matured-unrecorded:3"]["link"] == "/fixed-deposits"
    assert a["cash:usd"]["link"] == "/forex"
    assert a["cash:usd"]["cta"]["label"] == "Deploy" and a["cash:usd"]["cta"]["fragment"] == "deploy"   # SPEC §5.7
    assert a["cushion:low"]["link"] == "/settings#cushion"
    assert a["sip:missed:11:2026-11-04"]["link"] == "/recurring"


def test_deploy_cta_has_query_and_fragment():
    cta = A.deploy_cta(54321.4)
    assert cta == {"label": "Plan where it goes", "type": "route", "route": "/actions", "fragment": "deploy",
                   "query": {"new_money": 54321}}
    assert A.cta_href(cta) == "/actions?new_money=54321#deploy"
    assert A.cta_href(A.deploy_cta(None)) == "/actions#deploy"
    assert "#deploy?" not in A.cta_href(cta)


def test_every_link_and_cta_route_is_an_allowed_route(rich):
    bad = []
    for a in rich:
        if a["link"] is not None and not route_ok(a["link"]):
            bad.append((a["id"], "link", a["link"]))
        cta = a["cta"]
        if cta and cta.get("route") is not None:
            if not route_ok(cta["route"]) or "?" in cta["route"] or "#" in cta["route"]:
                bad.append((a["id"], "cta", cta["route"]))
            href = A.cta_href(cta)
            assert href.index("?") < href.index("#") if "?" in href and "#" in href else True
    assert not bad, bad


def test_prefix_grammar_rejects_unknown_ids():
    assert "drift:Equity (India)".startswith(A.ACTION_PREFIXES)
    assert "sip:due:3:2026-12-04".startswith(A.ACTION_PREFIXES)
    assert not "hack:me".startswith(A.ACTION_PREFIXES)
    assert A.HARVEST_FLOOR == 2000


# ── harvest thresholds (A12) ──

def test_harvest_fires_only_at_the_floor():
    fired = lambda t: f"tax:ltcg-harvest:{FY}" in by_id(A.build_actions({"owner": ME, "tax": t}, {}, TODAY))  # noqa: E731
    assert fired(tax(remaining=2000, booking=1001))
    assert not fired(tax(remaining=1999, booking=1999))
    assert not fired(tax(remaining=50000, booking=1000))


def test_harvest_with_about_1000_remaining_auto_closes():
    aid = f"tax:ltcg-harvest:{FY}"
    log = {(ME, aid): {"id": aid, "owner": ME, "status": "open", "first_seen": iso(-20), "tier_first": "consider",
                       "category": "tax", "impact": 5000, "impact_kind": "lump", "due": "2027-03-31"}}
    out = A.build_actions({"owner": ME, "tax": tax(remaining=1000.4, booking=1000.4)}, log, TODAY, include_closed=True)
    a = by_id(out)[aid]
    assert a["status"] == "done" and a["done_via"] == "auto"
    assert a["evidence"]["remaining_exemption"] == 1000.4
    assert A.auto_done({"id": aid}, [], None, tax(remaining=1000), TODAY) is not None
    assert A.auto_done({"id": aid}, [], None, tax(remaining=2500), TODAY) is None


# ── risk thresholds (A24) ──

@pytest.mark.parametrize("v,sev", [(11.0, None), (11.5, "warn"), (14.0, "warn"), (14.5, "crit")])
def test_risk_above_profile_thresholds(v, sev):
    out = by_id(A.build_actions({"owner": ME, "risk_est": {"vol_pct": v, "target_vol_pct": 9.0, "profile": "balanced"}},
                                {}, TODAY))
    assert (out["risk:above-profile"]["severity"] if "risk:above-profile" in out else None) == sev


def test_cushion_and_deploy_thresholds():
    cu = {"set": True, "months": 4.0, "target_months": 6, "monthly_expenses": 40000}
    assert by_id(A.build_actions({"cushion": cu}, {}, TODAY))["cushion:low"]["severity"] == "info"
    assert A.build_actions({"cushion": {**cu, "months": 6.0}}, {}, TODAY) == []
    assert A.build_actions({"cushion": {**cu, "set": False}}, {}, TODAY) == []
    assert A.build_actions({"deploy": {"suggested": 10000, "sources": []}}, {}, TODAY) == []


# ── log overlay (§8.4, A8, A11) ──

def row(aid, status, owner=ME, **kw):
    return {(owner, aid): {"id": aid, "owner": owner, "status": status, "first_seen": iso(-10), **kw}}


def test_overlay_snooze_plan_done_dismiss():
    src = rich_src()
    snoozed = A.build_actions(src, row("cushion:low", "snoozed", snooze_until=iso(3)), TODAY)
    assert "cushion:low" not in by_id(snoozed)
    reopened = by_id(A.build_actions(src, row("cushion:low", "snoozed", snooze_until=iso(-1)), TODAY))
    assert reopened["cushion:low"]["status"] == "open" and reopened["cushion:low"]["first_seen"] == iso(-10)
    planned = by_id(A.build_actions(src, row("p2p:yield", "planned", planned_for=iso(-2)), TODAY))["p2p:yield"]
    assert planned["status"] == "planned" and planned["tier"] == "now" and planned["days_late"] == 2
    ahead = by_id(A.build_actions(src, row("p2p:yield", "planned", planned_for=iso(5)), TODAY))["p2p:yield"]
    assert ahead["tier"] == "consider" and ahead["days_late"] is None and ahead["planned_for"] == iso(5)
    for status in ("done", "dismissed"):
        assert "cushion:low" not in by_id(A.build_actions(src, row("cushion:low", status, done_via="manual"), TODAY))
    # an auto-done state action whose condition is back reopens; an expired one too
    assert "cushion:low" in by_id(A.build_actions(src, row("cushion:low", "done", done_via="auto"), TODAY))
    assert "cushion:low" in by_id(A.build_actions(src, row("cushion:low", "expired"), TODAY))


def test_legacy_period_free_snooze_alias():
    src = rich_src()
    live = row("review:due", "snoozed", snooze_until=iso(10))
    assert "review:due:2026-Q4" not in by_id(A.build_actions(src, live, TODAY))
    past = row("review:due", "snoozed", snooze_until=iso(-1))
    assert "review:due:2026-Q4" in by_id(A.build_actions(src, past, TODAY))
    not_snooze = row("review:due", "dismissed")
    assert "review:due:2026-Q4" in by_id(A.build_actions(src, not_snooze, TODAY))
    # the period-keyed row wins over the alias
    both = {**live, **row("review:due:2026-Q4", "open")}
    assert "review:due:2026-Q4" in by_id(A.build_actions(src, both, TODAY))
    sip_alias = row("sip:missed:11", "snoozed", snooze_until=iso(30))
    assert "sip:missed:11:2026-11-04" not in by_id(A.build_actions(src, sip_alias, TODAY))
    assert A.legacy_id("tax:ltcg-harvest:FY2026-27") == "tax:ltcg-harvest"
    assert A.legacy_id("drift:EPF") is None


def test_skipping_an_instalment_covers_both_ids():
    src = rich_src(adherence={"plans": [{"id": 11, "months": [
        {"due": "2026-11-04", "planned": 5000, "status": "missed"}]}, {"id": 12, "months": [
        {"due": "2026-11-17", "planned": 2000, "status": "upcoming"}]}]})
    skip_due = row("sip:due:11:2026-11-04", "dismissed", reason="skipped")
    assert "sip:missed:11:2026-11-04" not in by_id(A.build_actions(src, skip_due, TODAY))
    skip_missed = row("sip:missed:12:2026-11-17", "dismissed", owner=MEMBER, reason="skipped")  # plan 12 is on the member's stock
    assert "sip:due:12:2026-11-17" not in by_id(A.build_actions(src, skip_missed, TODAY))
    other_reason = row("sip:due:11:2026-11-04", "dismissed", reason="not relevant")
    assert "sip:missed:11:2026-11-04" in by_id(A.build_actions(src, other_reason, TODAY))


# ── owners (§7.4, A10) ──

def test_family_status_owner_is_the_instrument_owner():
    src = rich_src(owner="__global__")
    out = by_id(A.build_actions(src, {}, TODAY))
    assert out["concentration:1"]["owner"] == MEMBER       # instrument 1 belongs to the member
    assert out["fd:maturing:2"]["owner"] == ME
    assert out["cushion:low"]["owner"] == "__global__"     # no instrument: the settings owner
    assert out["sip:due:12:2026-11-17"]["owner"] == MEMBER  # the plan's instrument owner
    # the member's snooze is the same row in family view and in the member's own view
    snooze = row("concentration:1", "snoozed", owner=MEMBER, snooze_until=iso(5))
    assert "concentration:1" not in by_id(A.build_actions(src, snooze, TODAY))
    assert "concentration:1" not in by_id(A.build_actions(rich_src(owner=MEMBER), snooze, TODAY))
    wrong = row("concentration:1", "snoozed", owner="__global__", snooze_until=iso(5))
    assert "concentration:1" in by_id(A.build_actions(src, wrong, TODAY))


def test_segment_sip_plan_owner_is_the_plan_owner():
    sips = [{"id": 21, "owner": MEMBER, "instrument_id": None, "segment": d.SEG_MF, "name": "MF plan", "amount": 3000,
             "day_of_month": 4, "active": 1}]
    adh = {"plans": [{"id": 21, "months": [{"due": "2026-11-04", "planned": 3000, "status": "missed"}]}]}
    a = by_id(A.build_actions({"owner": "__global__", "sips": sips, "adherence": adh}, {}, TODAY))["sip:missed:21:2026-11-04"]
    assert a["owner"] == MEMBER and a["cta"]["type"] == "route" and a["cta"]["route"] == "/recurring"


# ── auto-done (§8.3 'Closes when', P1.10) ──

def buy(id_, iid, days, amount):
    return {"id": id_, "instrument_id": iid, "type": d.BUY, "date": iso(days), "amount": amount, "quantity": 1}


def test_auto_done_sip_buy_in_window_at_80_percent():
    adh = {"plans": [{"id": 11, "months": [{"due": "2026-11-04", "planned": 5000, "status": "missed"}]}]}
    base = {"owner": ME, "sips": SIPS, "adherence": adh, "port": portfolio()}
    out = by_id(A.build_actions({**base, "txns": [buy(901, 6, -8, 4000)]}, {}, TODAY, include_closed=True))
    a = out["sip:missed:11:2026-11-04"]
    assert a["status"] == "done" and a["done_via"] == "auto" and a["evidence"]["txn_ids"] == [901]
    assert "sip:missed:11:2026-11-04" not in by_id(A.build_actions({**base, "txns": [buy(901, 6, -8, 4000)]}, {}, TODAY))
    short = by_id(A.build_actions({**base, "txns": [buy(902, 6, -8, 3900)]}, {}, TODAY))
    assert short["sip:missed:11:2026-11-04"]["status"] == "open"
    outside = by_id(A.build_actions({**base, "txns": [buy(903, 6, -40, 5000)]}, {}, TODAY))
    assert "sip:missed:11:2026-11-04" in outside
    # adherence saying done (or skipped) closes it too
    act = {"id": "sip:missed:11:2026-11-04", "meta": {}, "impact": None}
    done_adh = {"plans": [{"id": 11, "months": [{"due": "2026-11-04", "status": "skipped"}]}]}
    assert A.auto_done(act, [], None, None, TODAY, adherence=done_adh)["condition"] == "instalment skipped"


def test_auto_done_segment_sip_matches_buys_in_the_segment():
    act = {"id": "sip:missed:13:2026-11-04", "instrument_id": None, "meta": {"segment": d.SEG_MF, "amount": 1000},
           "impact": {"amount": 1000, "kind": "lump"}}
    assert A.auto_done(act, [buy(1, 6, -9, 900)], portfolio(), None, TODAY)["txn_ids"] == [1]
    assert A.auto_done(act, [buy(1, 1, -9, 900)], portfolio(), None, TODAY) is None   # equity, not MF


def _matured_fd_port(days_ago):
    fd = P(2, d.FIXED_DEPOSIT, "HDFC Bank", 0, maturity_date=iso(-days_ago), is_open=False, invested=100000,
           realized=5000, has_price=False)
    return {"positions": [fd, P(6, d.MUTUAL_FUND, "Index Fund", 60000), P(9, d.EPF, "EPF", 500000, segment=d.SEG_EPF)],
            "totals": {"value": 560000, "missing_prices": []}}


def test_auto_done_fd_redeploy_80_percent_within_45_days():
    mat = {"id": 700, "instrument_id": 2, "type": d.MATURITY, "date": iso(-10), "amount": 105000}
    src = {"owner": ME, "port": _matured_fd_port(10)}
    pending = by_id(A.build_actions({**src, "txns": [mat, buy(701, 6, -5, 50000)]}, {}, TODAY))
    a = pending["fd:maturing:2"]
    assert a["title"].endswith("matured") and a["impact"]["amount"] == 105000 and a["days"] == -10
    done = by_id(A.build_actions({**src, "txns": [mat, buy(701, 6, -5, 50000), buy(702, 6, -2, 35000)]}, {}, TODAY,
                                 include_closed=True))["fd:maturing:2"]
    assert done["status"] == "done" and done["evidence"]["txn_ids"] == [701, 702] and done["evidence"]["amount"] == 85000
    # EPF payroll contributions are not a redeploy
    epf = by_id(A.build_actions({**src, "txns": [mat, buy(703, 9, -5, 90000)]}, {}, TODAY))
    assert epf["fd:maturing:2"]["status"] == "open"
    # a BUY dated before maturity − 3 does not count
    early = A.auto_done({"id": "fd:maturing:2", "instrument_id": 2, "due": iso(-10), "meta": {"maturity_value": 105000}},
                        [buy(704, 6, -20, 105000)], _matured_fd_port(10), None, TODAY)
    assert early is None


def test_auto_done_fd_matured_unrecorded_and_state_rules():
    mat = {"id": 800, "instrument_id": 3, "type": d.MATURITY, "date": iso(-1), "amount": 52000}
    act = {"id": "fd:matured-unrecorded:3", "instrument_id": 3}
    assert A.auto_done(act, [mat], None, None, TODAY)["txn_ids"] == [800]
    assert A.auto_done(act, [], None, None, TODAY) is None
    clean = {"positions": [P(4, d.P2P, "L", 0, at_risk=0, overdue_days=0), P(5, d.CASH, "W", 100, balance_usd=10)],
             "totals": {"value": 100, "missing_prices": []}}
    for aid in ("data:missing-prices", "p2p:defaulted", "p2p:overdue", "cash:usd"):
        assert A.auto_done({"id": aid}, [], clean, None, TODAY) is not None, aid
        assert A.auto_done({"id": aid}, [], portfolio(), None, TODAY) is None, aid
    rv = {"id": "review:due:2026-Q4"}
    assert A.auto_done(rv, [], None, None, TODAY, settings={"lastReviewDate": "2026-10-02"}) is not None
    assert A.auto_done(rv, [], None, None, TODAY, settings={"lastReviewDate": "2026-09-30"}) is None


def test_auto_done_loss_harvest_when_offsettable_falls_80_percent():
    aid = f"tax:loss-harvest:{FY}"
    act = {"id": aid, "impact": {"amount": 1600, "kind": "lump"}, "meta": {"first_impact": 1600}}
    assert A.auto_done(act, [], None, tax(offsettable=1600), TODAY) is not None
    assert A.auto_done(act, [], None, tax(offsettable=4000), TODAY) is None
    assert A.auto_done(act, [], None, {**tax(offsettable=0), "fy": "FY2027-28"}, TODAY) is None


def test_full_loss_harvest_closes_done_even_with_no_tax_line_left():
    """Harvesting every loss cancels the gains, so tax_lines is empty and the rate cannot be recovered: the stale
    row still closes as done when a loss was booked since first sight, and expires when the losers just recovered."""
    aid = f"tax:loss-harvest:{FY}"
    log = row(aid, "open", category="tax", impact=1000, impact_kind="lump", tier_first="month", due="2027-03-31")
    no_lines = {**tax(offsettable=0), "tax_lines": []}
    harvested = {"positions": [], "totals": {"value": 100000},
                 "realized_lots": [{"instrument_id": 2, "sell_date": iso(-2), "gain": -6000.0},
                                   {"instrument_id": 1, "sell_date": "2026-08-01", "gain": 5000.0}]}
    out = by_id(A.build_actions({"owner": ME, "port": harvested, "tax": no_lines}, log, TODAY, include_closed=True))
    assert out[aid]["status"] == "done" and out[aid]["done_via"] == "auto"
    assert out[aid]["evidence"]["booked_loss"] == 6000.0
    recovered = {**harvested, "realized_lots": harvested["realized_lots"][1:]}
    out = by_id(A.build_actions({"owner": ME, "port": recovered, "tax": no_lines}, log, TODAY, include_closed=True))
    assert out[aid]["status"] == "expired"


def test_stale_open_row_of_a_user_cleared_state_closes_done():
    log = row("data:missing-prices", "open", category="data")
    clean = {**portfolio(), "totals": {"value": 1_000_000, "missing_prices": []}}
    out = by_id(A.build_actions({"owner": ME, "port": clean, "insights": []}, log, TODAY, include_closed=True))
    assert out["data:missing-prices"]["status"] == "done"
    # rows of another scope, or of rules whose source did not run, are left alone
    other = row("concentration:99", "open")
    assert A.build_actions({"owner": ME, "port": {**clean, "positions": []}, "insights": []}, other, TODAY,
                           include_closed=True) == []
    assert A.build_actions({"owner": ME}, row("cushion:low", "open"), TODAY, include_closed=True) == []


def test_mix_actions_close_done_on_user_activity_and_expire_on_price_moves():
    """§8.4 / A24: drift, concentration and risk-above-profile close as done when the user rebalanced or changed the
    profile, and expire when only prices moved."""
    pos = [P(6, d.MUTUAL_FUND, "Index Fund", 300000), P(9, d.EPF, "EPF", 100000, segment=d.SEG_MF)]
    port = {"positions": pos, "totals": {"value": 400000}}
    buy = {"id": 77, "instrument_id": 6, "type": d.BUY, "date": iso(-3), "amount": 20000}
    epf = {"id": 78, "instrument_id": 9, "type": d.BUY, "date": iso(-3), "amount": 5000}
    old = {"id": 79, "instrument_id": 6, "type": d.SELL, "date": iso(-30), "amount": 9000}   # before first sight
    log = {**row("drift:Mutual Funds", "open", category="allocation", tier_first="month"),
           **row("concentration:6", "open", category="risk", tier_first="month")}
    for txns, want in (([buy, epf, old], "done"), ([epf, old], "expired")):
        out = by_id(A.build_actions({"owner": ME, "port": port, "insights": [], "txns": txns}, log, TODAY,
                                    include_closed=True))
        assert out["drift:Mutual Funds"]["status"] == out["concentration:6"]["status"] == want, txns
    assert out["drift:Mutual Funds"]["evidence"] is None
    done = by_id(A.build_actions({"owner": ME, "port": port, "insights": [], "txns": [buy]}, log, TODAY,
                                 include_closed=True))
    assert done["drift:Mutual Funds"]["evidence"]["txn_ids"] == [77]
    risk_row = row("risk:above-profile", "open", category="risk", title="Your mix swings more than your balanced profile")
    calm = {"vol_pct": 9.0, "target_vol_pct": 12.0}
    changed = by_id(A.build_actions({"owner": ME, "port": port, "txns": [], "risk_est": {**calm, "profile": "growth"}},
                                    risk_row, TODAY, include_closed=True))
    assert changed["risk:above-profile"]["status"] == "done"
    assert changed["risk:above-profile"]["evidence"]["condition"] == "risk profile changed"
    same = by_id(A.build_actions({"owner": ME, "port": port, "txns": [], "risk_est": {**calm, "profile": "balanced"}},
                                 risk_row, TODAY, include_closed=True))
    assert same["risk:above-profile"]["status"] == "expired"


def test_lapsed_snooze_and_expired_rows_can_still_close():
    """A snooze that has lapsed is open again, so its stale row closes like an open one. An expired row closes as
    done only on fresh evidence, never re-expires, and a live snooze is left alone."""
    clean = {**portfolio(), "totals": {"value": 1_000_000, "missing_prices": []}}
    src = {"owner": ME, "port": clean, "insights": []}
    lapsed = by_id(A.build_actions(src, row("data:missing-prices", "snoozed", category="data", snooze_until=iso(-1)),
                                   TODAY, include_closed=True))
    assert lapsed["data:missing-prices"]["status"] == "done"
    assert "data:missing-prices" not in by_id(A.build_actions(
        src, row("data:missing-prices", "snoozed", category="data", snooze_until=iso(2)), TODAY, include_closed=True))
    expired = by_id(A.build_actions(src, row("data:missing-prices", "expired", category="data"), TODAY,
                                    include_closed=True))
    assert expired["data:missing-prices"]["status"] == "done"
    assert "targets:missing" not in by_id(A.build_actions(src, row("targets:missing", "expired"), TODAY,
                                                          include_closed=True))
    # a lapsed snooze whose rule stopped firing with no evidence expires
    gone = by_id(A.build_actions(src, row("diversification:stocks", "snoozed", snooze_until=iso(-3)), TODAY,
                                 include_closed=True))
    assert gone["diversification:stocks"]["status"] == "expired"


# ── expiry (§8.4) ──

def test_expiry_of_event_windows():
    # a missed instalment is shown for 30 days after its due date, then expires
    log = row("sip:missed:11:2026-10-04", "open", category="habit", impact=5000, due="2026-10-04")
    adh = {"plans": [{"id": 11, "months": [{"due": "2026-10-04", "planned": 5000, "status": "missed"}]}]}
    src = {"owner": ME, "sips": SIPS[:1], "adherence": adh, "port": {"positions": [P(6, d.MUTUAL_FUND, "Index Fund", 60000)],
                                                                 "totals": {"value": 60000}}, "txns": []}
    assert A.build_actions(src, log, TODAY) == []
    closed = by_id(A.build_actions(src, log, TODAY, include_closed=True))
    assert closed["sip:missed:11:2026-10-04"]["status"] == "expired"
    # an FD redeploy window closes 45 days after maturity
    fd_log = row("fd:maturing:2", "open", category="fd", impact=105000, due=iso(-50))
    fd = A.build_actions({"owner": ME, "port": _matured_fd_port(50), "txns": []}, fd_log, TODAY, include_closed=True)
    assert [(a["id"], a["status"]) for a in fd] == [("fd:maturing:2", "expired")]
    # a fired event whose window has passed is expired, not shown
    lots = [{"instrument_id": 1, "name": "X", "date": "2025-11-10", "lt_on": iso(-1), "days_to_lt": 0, "tax_saving": 900,
             "qty": 1}]
    src_tax = {"owner": ME, "tax": tax(remaining=0, booking=0, offsettable=0, lots=lots)}
    assert A.build_actions(src_tax, {}, TODAY) == []
    assert A.build_actions(src_tax, {}, TODAY, include_closed=True)[0]["status"] == "expired"


def test_stale_state_row_not_cleared_by_the_user_expires():
    log = row("concentration:1", "open", owner=MEMBER, category="risk")
    out = A.build_actions({"owner": ME, "port": portfolio(), "insights": []}, log, TODAY, include_closed=True)
    closed = [(a["id"], a["status"], a["owner"]) for a in out if a["status"] not in A.OPEN_STATUSES]
    assert closed == [("concentration:1", "expired", MEMBER)]


# ── follow-through (§8.5) ──

def test_follow_through():
    log = {}
    log.update(row("a", "done", tier_first="now", first_seen=iso(-20), done_at=iso(-18), due=iso(-15),
                   category="tax", impact=4000, id="tax:ltcg-harvest:FY2026-27"))
    log.update(row("b", "done", tier_first="month", first_seen=iso(-30), done_at=iso(-2), category="fd",
                   evidence={"txn_ids": [1], "amount": 90000}))
    log.update(row("c", "expired", tier_first="month", first_seen=iso(-40)))
    log.update(row("d", "dismissed", tier_first="now", first_seen=iso(-5), reason="not relevant"))
    log.update(row("e", "open", tier_first="now", first_seen=iso(-5)))
    log.update(row("f", "done", tier_first="consider", first_seen=iso(-5), done_at=iso(-1)))
    log.update(row("g", "done", tier_first="now", first_seen=iso(-120), done_at=iso(-100)))
    log.update(row("notice:x", "done", tier_first=None, first_seen=iso(-3), done_at=iso(-3)))
    ft = A.follow_through(log, {"adherence_6m_pct": 77.0}, TODAY)
    assert ft["acted_90d"] == {"done": 2, "total": 3, "pct": 66.7}
    assert ft["on_time_pct"] == 50.0           # a by its due date; b (undated) took 28 days
    assert ft["impact_realised_fy"] == 94000   # tax impact + the fd evidence BUYs
    assert ft["sip_adherence_12m"] == 77.0
    assert ft["median_days_to_act"] == 15      # median of 2 and 28
    empty = A.follow_through({}, None, TODAY)
    assert empty["acted_90d"] == {"done": 0, "total": 0, "pct": None} and empty["on_time_pct"] is None


def test_follow_through_does_not_credit_selling_before_long_term():
    """W4 review: "Hold N more days" marked done by a SELL is the opposite of the advice; the lot clearing
    (no txn_ids) is following it."""
    sold = row("tax:wait-lt:1:2025-12-09", "done", tier_first="now", first_seen=iso(-5), done_at=iso(-1),
               due=iso(20), category="tax", impact=3750, evidence={"txn_ids": [42]})
    ft = A.follow_through(sold, None, TODAY)
    assert ft["impact_realised_fy"] == 0 and ft["acted_90d"] == {"done": 0, "total": 0, "pct": None}
    held = row("tax:wait-lt:1:2025-12-09", "done", tier_first="now", first_seen=iso(-5), done_at=iso(-1),
               due=iso(-1), category="tax", impact=3750, evidence={"condition": "cleared", "date": iso(-1)})
    ft = A.follow_through(held, None, TODAY)
    assert ft["impact_realised_fy"] == 3750 and ft["acted_90d"]["done"] == 1


# ── purity (A6) ──

def test_module_is_pure():
    tree = ast.parse(Path(A.__file__).read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {n.name for n in node.names}
        elif isinstance(node, ast.ImportFrom):
            imported.add(("." * node.level) + (node.module or ""))
    assert not {m for m in imported if any(x in m for x in ("services", "db", "ledger", "brief", "flask", "prices"))}
