from datetime import date

import pytest

from tracker import domain as d
from tracker.analytics.goals import project_goal, rebalance_plan
from tracker.analytics.portfolio import compute_portfolio, fd_accrued, run_fifo
from tracker.analytics.tax import classify, compute_tax
from tracker.analytics.xirr import xirr


def T(id_, iid, date_, type_, qty=None, amount=0.0, **kw):
    return {"id": id_, "instrument_id": iid, "date": date_, "type": type_, "quantity": qty, "amount": amount,
            "amount_fc": kw.get("fc"), "principal": kw.get("principal"), "fees": kw.get("fees"), "owner": "a"}


def I(id_, ac, name, **kw):
    base = {"id": id_, "owner": "a", "asset_class": ac, "name": name, "currency": "INR", "status": "active",
            "tax_class": d.default_tax_class(ac, kw.get("market"), kw.get("category"), name)}
    base.update(kw)
    return base


def test_xirr_simple_year():
    assert xirr([(date(2025, 1, 1), -1000), (date(2026, 1, 1), 1100)]) == pytest.approx(0.10, abs=1e-4)


def test_xirr_undefined_without_both_signs():
    assert xirr([(date(2025, 1, 1), -1000)]) is None


def test_fifo_matches_oldest_lot_and_intraday_first():
    txns = [T(1, 1, "2025-01-01", d.BUY, 10, 1000), T(2, 1, "2025-06-01", d.BUY, 10, 2000),
            T(3, 1, "2025-06-01", d.SELL, 5, 1100)]
    lots, realized, unmatched = run_fifo(1, txns)
    assert unmatched == 0
    assert realized[0].intraday and realized[0].cost == pytest.approx(1000)  # same-day lot first
    assert sum(l.qty for l in lots) == 15
    assert sum(l.cost for l in lots) == pytest.approx(2000)


def test_tax_classes_and_holding_periods():
    assert classify(d.TAX_EQUITY, "2024-01-01", "2025-01-02", False)[0] == "LTCG"
    assert classify(d.TAX_EQUITY, "2024-06-01", "2025-05-31", False)[0] == "STCG"
    assert classify(d.TAX_FOREIGN, "2024-01-01", "2025-06-01", False) == ("STCG", None, False)
    assert classify(d.TAX_EQUITY, "2025-03-03", "2025-03-03", True)[0] == "Intraday"
    assert classify(d.TAX_EQUITY, "2023-01-01", "2024-07-01", False)[1] == 0.10  # pre-budget rate


def test_tax_set_off_and_exemption():
    inst = [I(1, d.EQUITY, "A"), I(2, d.EQUITY, "B")]
    txns = [T(1, 1, "2024-01-10", d.BUY, 100, 100000), T(2, 1, "2025-06-10", d.SELL, 100, 300000),  # LTCG 2L
            T(3, 2, "2025-05-01", d.BUY, 10, 50000), T(4, 2, "2025-07-01", d.SELL, 10, 30000)]      # STCL 20k
    for i in inst:
        i["last_price"] = 1.0
    port = compute_portfolio(inst, txns, None, today=date(2025, 12, 1))
    tax = compute_tax(port, txns, inst, "FY2025-26", 0.30, today=date(2025, 12, 1))
    assert tax["total_realized"] == pytest.approx(180000)
    # 2L LTCG - 20k STCL = 1.8L; minus 1.25L exemption = 55k @12.5%
    assert tax["estimate"]["capital_gains_tax"] == pytest.approx(55000 * 0.125)
    assert tax["equity_exemption"]["remaining"] == 0


def test_fd_accrual_quarterly():
    assert fd_accrued(100000, 8, date(2025, 1, 1), date(2026, 1, 1)) == pytest.approx(108243, abs=5)


def test_usd_position_splits_fx_and_stock_gain():
    inst = [I(1, d.EQUITY, "NVDA", market="USA", currency="USD", last_price=110.0)]
    txns = [T(1, 1, "2025-01-01", d.BUY, 1, 8500, fc=100)]
    p = compute_portfolio(inst, txns, 90.0, today=date(2025, 6, 1))["positions"][0]
    assert p["value"] == pytest.approx(9900)
    assert p["fx_gain"] == pytest.approx(500)       # 100 USD * (90 - 85)
    assert p["stock_gain"] == pytest.approx(900)    # 10 USD * 90


def test_p2p_outstanding_and_interest():
    inst = [I(1, d.P2P, "Borrower", tenure_months=3, maturity_date="2025-04-05")]
    txns = [T(1, 1, "2025-01-01", d.BUY, None, 3000),
            T(2, 1, "2025-02-05", d.REPAYMENT, None, 1050, principal=1000, fees=5)]
    p = compute_portfolio(inst, txns, None, today=date(2025, 3, 1))["positions"][0]
    assert p["outstanding"] == pytest.approx(2000) and p["interest"] == pytest.approx(50)


def test_goal_projection_and_required_sip():
    seg = [{"segment": d.SEG_MF, "value": 100000}]
    goal = {"id": 1, "target_amount": 1000000, "target_date": "2035-01-01", "monthly_contribution": 0,
            "expected_return": 12, "allocation": {d.SEG_MF: 100}}
    pr = project_goal(goal, seg, today=date(2025, 1, 1), sims=200)
    assert pr["current"] == 100000
    assert pr["required_sip"] > 0 and pr["status"] in ("off_track", "at_risk")


def test_rebalance_new_money_only_goes_to_underweight():
    segs = [{"segment": "A", "value": 70000}, {"segment": "B", "value": 30000}]
    plan = rebalance_plan(segs, {"A": 50, "B": 50}, new_money=20000)
    rows = {r["segment"]: r for r in plan["rows"]}
    assert rows["A"]["action"] == "hold" and rows["B"]["amount"] == pytest.approx(20000)
    assert plan["money_to_fix_without_selling"] == pytest.approx(40000)


def test_calendar_gold_nudge_and_theme():
    from tracker.analytics.calendar import build_calendar
    port = {"totals": {"value": 100000}, "positions": [],
            "segments": [{"segment": d.SEG_COMMODITY, "value": 5000, "pct": 5.0, "mix_pct": 5.0, "target": 10},
                         {"segment": d.SEG_EQ_IN, "value": 95000, "pct": 95.0, "mix_pct": 95.0, "target": 90}]}
    cal = build_calendar(port, None, [], today=date(2026, 11, 3))
    dhanteras = next(e for e in cal["events"] if e["key"] == "dhanteras")
    assert "₹5,000" in dhanteras["note"] and cal["theme"] == "diwali"


def test_health_score_bounds():
    from tracker.analytics.health import health_score
    inst = [I(1, d.EQUITY, "A", last_price=12.0, sector="IT"), I(2, d.MUTUAL_FUND, "F", last_price=11.0, category="Equity")]
    txns = [T(1, 1, "2025-01-01", d.BUY, 10, 100), T(2, 2, "2025-01-01", d.BUY, 10, 100)]
    port = compute_portfolio(inst, txns, None, today=date(2025, 6, 1))
    h = health_score(port, None, None)
    assert 0 <= h["score"] <= 100 and len(h["components"]) == 5 and h["focus"]["label"]


def test_story_rhythm_milestones_and_attribution():
    from tracker.analytics.story import build_story, lakh_label
    inst = [I(1, d.EQUITY, "Winner", last_price=30.0), I(2, d.EQUITY, "Loser", last_price=5.0)]
    txns = [T(1, 1, "2026-01-10", d.BUY, 1000, 10000), T(2, 2, "2026-02-10", d.BUY, 1000, 10000),
            T(3, 1, "2026-03-10", d.BUY, 100, 2000)]
    port = compute_portfolio(inst, txns, None, today=date(2026, 6, 15))
    perf = {"metrics": {"xirr": 50.0, "start": "2026-01-10"},
            "benchmarks": [{"key": "NIFTY50", "label": "Nifty 50", "xirr": 8.0, "end_value": 23000.0, "excess_xirr": 42.0}]}
    s = build_story(port, txns, perf, today=date(2026, 6, 15))
    assert s["rhythm"]["active_months"] == 3 and s["rhythm"]["invested"] == 22000
    assert s["rhythm"]["streak"] == 0  # nothing bought in May, so the streak is broken
    assert s["attribution"]["gainers"][0]["name"] == "Winner" and s["attribution"]["losers"][0]["name"] == "Loser"
    assert s["milestones"]["ahead"][0]["label"] == "₹1 lakh"
    keys = [t["key"] for t in s["takeaways"]]
    assert keys[:3] == ["market", "driver", "drag"] and "ahead" in s["takeaways"][0]["value"]
    assert lakh_label(2.5e5) == "₹2.5 lakh" and lakh_label(1e7) == "₹1 crore"


def test_bonus_and_split_adjust_fifo_lots():
    txns = [T(1, 1, "2025-01-01", d.BUY, 10, 1000), T(2, 1, "2025-06-01", d.SPLIT, 5),
            T(3, 1, "2025-07-01", d.BONUS, 50), T(4, 1, "2025-08-01", d.SELL, 60, 1200)]
    lots, realized, unmatched = run_fifo(1, txns)
    assert unmatched == 0
    # the 50 split shares keep the original cost and date; 10 bonus shares are zero-cost, dated at allotment
    assert realized[0].buy_date == "2025-01-01" and realized[0].qty == pytest.approx(50) and realized[0].cost == pytest.approx(1000)
    assert realized[1].buy_date == "2025-07-01" and realized[1].cost == 0
    assert sum(l.qty for l in lots) == pytest.approx(40)


def test_epf_balance_interest_and_exempt_tax():
    inst = [I(1, d.EPF, "EPF – UAN 1001", rate=8.25)]
    txns = [T(1, 1, "2025-04-30", d.BUY, None, 10000), T(2, 1, "2026-03-31", d.CREDIT, None, 800),
            T(3, 1, "2026-04-30", d.BUY, None, 10000)]
    port = compute_portfolio(inst, txns, None, today=date(2026, 10, 31))
    p = port["positions"][0]
    assert p["segment"] == d.SEG_EPF and p["tax_class"] == d.TAX_EXEMPT
    assert p["interest_credited"] == 800 and p["cost"] == 20000
    assert 0 < p["accrued_interest"] < 1100  # ~7 months of 8.25% on ~₹20.8K
    assert p["value"] == pytest.approx(20800 + p["accrued_interest"], abs=0.01)


def test_nps_units_at_manual_nav():
    inst = [I(1, d.NPS, "SBI Pension Fund Scheme E - Tier I", last_price=45.0)]
    txns = [T(1, 1, "2025-05-01", d.BUY, 100, 4000), T(2, 1, "2025-11-01", d.BUY, 50, 2100)]
    port = compute_portfolio(inst, txns, None, today=date(2026, 5, 1))
    p = port["positions"][0]
    assert p["value"] == pytest.approx(150 * 45) and p["unrealized"] == pytest.approx(6750 - 6100)
    assert port["realized_lots"] == []


def test_cas_name_normalisation():
    from tracker.importers.cas_import import clean_scheme_name, norm_name
    assert norm_name("Axis ELSS Tax Saver Fund - Direct Growth") == norm_name("Axis ELSS Tax Saver Fund")
    assert clean_scheme_name("K123-Kotak Flexicap Fund - Direct Plan - Growth - ISIN: INF174K01LS2") == "Kotak Flexicap Fund - Direct Plan - Growth"


def test_untargeted_classes_stay_outside_the_target_mix():
    from tracker.analytics.goals import rebalance_plan
    inst = [I(1, d.EQUITY, "A", last_price=60.0, sector="IT", market="India"), I(2, d.MUTUAL_FUND, "F", last_price=40.0, category="Equity"),
            I(3, d.EPF, "EPF")]
    txns = [T(1, 1, "2025-01-01", d.BUY, 100, 6000), T(2, 2, "2025-01-01", d.BUY, 100, 4000), T(3, 3, "2025-01-01", d.BUY, None, 90000)]
    port = compute_portfolio(inst, txns, None, {d.SEG_EQ_IN: 50, d.SEG_MF: 50}, today=date(2025, 1, 2))
    seg = {s["segment"]: s for s in port["segments"]}
    # EPF is 90% of the portfolio but has no target: equity is judged within the 10,000 that does
    assert seg[d.SEG_EQ_IN]["pct"] < 10 and seg[d.SEG_EQ_IN]["mix_pct"] == 60 and seg[d.SEG_EQ_IN]["drift"] == 10
    assert seg[d.SEG_EPF]["drift"] is None and seg[d.SEG_EPF]["mix_pct"] is None
    plan = rebalance_plan(port["segments"], {d.SEG_EQ_IN: 50, d.SEG_MF: 50}, new_money=2000)
    assert {r["segment"]: r["amount"] for r in plan["rows"] if r["action"] == "buy"} == {d.SEG_MF: 2000}
