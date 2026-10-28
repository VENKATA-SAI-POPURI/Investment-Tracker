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
