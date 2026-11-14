"""Goals on the Assumption Book and the funding summary (SPEC §6.4; AMENDMENTS G3–G7, D3)."""
import math
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from tracker import domain as d
from tracker.analytics import assumptions as A
from tracker.analytics import goals, mc

TODAY = date(2026, 1, 1)
BACKEND = Path(__file__).resolve().parents[1]


def pos(iid, seg, value, **kw):
    ac = {d.SEG_EQ_IN: d.EQUITY, d.SEG_EQ_US: d.EQUITY, d.SEG_MF: d.MUTUAL_FUND, d.SEG_COMMODITY: d.COMMODITY,
          d.SEG_P2P: d.P2P, d.SEG_FD: d.FIXED_DEPOSIT, d.SEG_EPF: d.EPF, d.SEG_NPS: d.NPS}[seg]
    return {"id": iid, "segment": seg, "asset_class": ac, "value": value, "is_open": True, **kw}


def goal(**kw):
    g = {"id": 3, "name": "House", "target_amount": 2_000_000, "target_date": "2036-01-01", "monthly_contribution": 0,
         "allocation": {d.SEG_EQ_IN: 100}}
    g.update(kw)
    return g


SEGS = [{"segment": d.SEG_EQ_IN, "value": 300_000}]


# ── re-export and imports (G3, G4) ──

def test_assumptions_is_a_re_export_of_the_eight_segment_rows():
    assert set(goals.ASSUMPTIONS) == set(d.SEGMENTS) and len(goals.ASSUMPTIONS) == 8
    assert all(goals.ASSUMPTIONS[k] == A.ASSUMPTIONS[k] for k in d.SEGMENTS)
    assert A.MF_DEBT not in goals.ASSUMPTIONS


@pytest.mark.parametrize("module", ["tracker.analytics.goals", "tracker.analytics.quant"])
def test_imports_cleanly_in_a_fresh_interpreter(module):
    res = subprocess.run([sys.executable, "-c", f"import {module}"], cwd=BACKEND, capture_output=True, text=True)
    assert res.returncode == 0, res.stderr


def test_mc_is_not_imported_at_module_top():
    import ast
    tree = ast.parse(Path(goals.__file__).read_text(encoding="utf-8"))
    top = [a.name for n in tree.body if isinstance(n, ast.ImportFrom) for a in n.names]
    assert "mc" not in top and "assumptions" in top


# ── required SIP at 75% (D3) ──

def _helper_prob(pv, months, mu, sigma, target, sip, seed):
    """Share of the helper's own paths (same shocks, same seed) that reach `target` with `sip`."""
    years = math.ceil(months / 12)
    hits = 0
    for z in mc.annual_shocks(seed, mc.SIMS, years):
        a, b = mc._terminal_parts(pv, months, mu, sigma, 0.0, z)
        hits += a + sip * b >= target
    return hits / mc.SIMS


def test_required_sip_reaches_75_percent_exactly_on_the_helpers_draws():
    g = goal()
    pr = goals.project_goal(g, SEGS, today=TODAY)
    mu, sigma = A.mu_sigma({d.SEG_EQ_IN: 1.0}, A.effective_book(None))
    assert pr["expected_return"] == round(mu * 100, 2) and pr["volatility"] == round(sigma * 100, 2)
    sip = pr["required_sip"]
    assert sip > pr["required_sip_typical"] > 0
    assert _helper_prob(300_000, pr["months_left"], mu, sigma, 2_000_000, sip, seed=3) >= 0.75
    assert _helper_prob(300_000, pr["months_left"], mu, sigma, 2_000_000, sip - 100, seed=3) < 0.75


def test_following_required_sip_gives_about_75_percent_in_the_engine():
    first = goals.project_goal(goal(), SEGS, today=TODAY)
    assert first["status"] == "off_track"
    pr = goals.project_goal(goal(monthly_contribution=first["required_sip"]), SEGS, today=TODAY)
    assert 67 <= pr["probability"] <= 83
    assert pr["status"] in ("on_track", "at_risk")


def test_seed_is_the_goal_id_and_results_repeat():
    a = goals.project_goal(goal(monthly_contribution=5000), SEGS, today=TODAY, sims=300)
    b = goals.project_goal(goal(monthly_contribution=5000), SEGS, today=TODAY, sims=300)
    c = goals.project_goal(goal(id=4, monthly_contribution=5000), SEGS, today=TODAY, sims=300)
    assert a == b and a["p50"] != c["p50"]
    req = mc.required_sip_for(300_000, a["months_left"], 0.12, A.mu_sigma({d.SEG_EQ_IN: 1.0})[1], 2_000_000, 0.75, seed=3)
    assert a["required_sip"] == req["sip_75"] and a["required_sip_typical"] == req["sip_typical"]


def test_no_months_left_keeps_required_sip_none():
    pr = goals.project_goal(goal(target_date="2025-06-01"), SEGS, today=TODAY)
    assert pr["months_left"] == 0 and pr["required_sip"] is None and pr["required_sip_typical"] is None
    assert pr["status"] == "off_track" and pr["probability"] == 0.0


def test_achieved_status_and_zero_sip():
    pr = goals.project_goal(goal(target_amount=250_000), SEGS, today=TODAY, sims=50)
    assert pr["status"] == "achieved" and pr["required_sip"] == 0 and pr["required_sip_typical"] == 0
    assert pr["progress_pct"] == 100


# ── μ and σ from the Book (G6) ──

def test_positions_split_debt_funds_onto_mf_debt():
    segs = [{"segment": d.SEG_MF, "value": 100_000}]
    g = goal(allocation={d.SEG_MF: 100})
    plain = goals.project_goal(g, segs, today=TODAY, sims=50)
    held = [pos(1, d.SEG_MF, 50_000, category="Equity: Large Cap"),
            pos(2, d.SEG_MF, 50_000, category="Debt: Liquid", tax_class=d.TAX_DEBT)]
    split = goals.project_goal(g, segs, today=TODAY, sims=50, positions=held)
    mu, sigma = A.mu_sigma({d.SEG_MF: 0.5, A.MF_DEBT: 0.5}, A.rated_book(held))
    assert plain["volatility"] == 15.0 and plain["expected_return"] == 11.0
    assert split["volatility"] == round(sigma * 100, 2) < plain["volatility"]
    assert split["expected_return"] == round(mu * 100, 2) == 9.0
    assert "split by your holdings" in split["assumptions"]["basis"]
    assert split["current"] == plain["current"] == 100_000


def test_positions_use_the_holdings_fd_rates():
    segs = [{"segment": d.SEG_FD, "value": 200_000}, {"segment": d.SEG_EQ_IN, "value": 200_000}]
    g = goal(allocation={d.SEG_FD: 100})
    plain = goals.project_goal(g, segs, today=TODAY, sims=50)
    held = [pos(5, d.SEG_FD, 200_000, rate=7.75), pos(6, d.SEG_EQ_IN, 200_000)]
    rated = goals.project_goal(g, segs, today=TODAY, sims=50, positions=held)
    assert plain["expected_return"] == 7.0 and rated["expected_return"] == 7.75
    assert rated["volatility"] == plain["volatility"] == 1.0   # only the FD segment is linked


def test_weights_follow_segment_values_or_pct_when_empty():
    segs = [{"segment": d.SEG_EQ_IN, "value": 300_000}, {"segment": d.SEG_FD, "value": 100_000}]
    g = goal(allocation={d.SEG_EQ_IN: 50, d.SEG_FD: 100})   # 150k + 100k → 60/40
    pr = goals.project_goal(g, segs, today=TODAY, sims=50)
    mu, sigma = A.mu_sigma({d.SEG_EQ_IN: 0.6, d.SEG_FD: 0.4})
    assert pr["expected_return"] == round(mu * 100, 2) and pr["volatility"] == round(sigma * 100, 2)
    empty = goals.project_goal(g, [], today=TODAY, sims=50)   # no values → by pct: 1/3 and 2/3
    mu, sigma = A.mu_sigma({d.SEG_EQ_IN: 1 / 3, d.SEG_FD: 2 / 3})
    assert empty["expected_return"] == round(mu * 100, 2) and empty["volatility"] == round(sigma * 100, 2)


def test_expected_return_overrides_mu_only():
    pr = goals.project_goal(goal(expected_return=9), SEGS, today=TODAY, sims=50)
    assert pr["expected_return"] == 9.0 and pr["volatility"] == 18.0
    assert pr["assumptions"]["return_pct"] == 9.0 and pr["assumptions"]["volatility_pct"] == 18.0
    assert pr["assumptions"]["typical_pct"] == round(A.typical(0.09, 0.18) * 100, 2)
    assert "your expected return of 9%" in pr["assumptions"]["basis"]


def test_no_allocation_uses_the_portfolio_mix():
    segs = [{"segment": d.SEG_EQ_IN, "value": 100_000}, {"segment": d.SEG_FD, "value": 100_000}]
    pr = goals.project_goal(goal(allocation=None), segs, today=TODAY, sims=50)
    mu, _ = A.mu_sigma({d.SEG_EQ_IN: 0.5, d.SEG_FD: 0.5})
    assert pr["current"] == 0 and pr["expected_return"] == round(mu * 100, 2)
    bare = goals.project_goal(goal(allocation=None), [], today=TODAY, sims=50)
    assert bare["expected_return"] == 11.0 and bare["volatility"] == 15.0


# ── the forward block (G5) ──

def test_forward_block_shape_and_honesty():
    pr = goals.project_goal(goal(), SEGS, today=TODAY, sims=200)
    blk = pr["assumptions"]
    assert set(blk) == {"return_pct", "typical_pct", "volatility_pct", "inflation_pct", "basis", "hash"}
    assert blk["return_pct"] == pr["expected_return"] and blk["volatility_pct"] == pr["volatility"]
    assert blk["inflation_pct"] == 6.0 and blk["typical_pct"] < blk["return_pct"]
    assert pr["honesty"]["p50"] == A.HONESTY["p50"].format(sims="200")
    assert pr["honesty"]["p10"] == A.HONESTY["p10"] and pr["honesty"]["probability"] == A.HONESTY["probability"]
    assert "75 of 100" in pr["note"] and A.HONESTY["disclaimer"] in pr["note"]
    for k in ("current", "progress_pct", "months_left", "expected_return", "volatility", "projected", "shortfall",
              "required_sip", "probability", "status", "p10", "p50", "p90", "path"):
        assert k in pr


def test_block_hash_is_stable_and_changes_with_the_book():
    a = goals.project_goal(goal(), SEGS, today=TODAY, sims=50)["assumptions"]["hash"]
    b = goals.project_goal(goal(), SEGS, today=TODAY, sims=50)["assumptions"]["hash"]
    assert a == b == A.book_hash(A.effective_book(None))
    held = [pos(5, d.SEG_FD, 100_000, rate=8.1), pos(6, d.SEG_EQ_IN, 300_000)]
    c = goals.project_goal(goal(), SEGS, today=TODAY, sims=50, positions=held)["assumptions"]["hash"]
    assert c == A.book_hash(A.rated_book(held)) != a
    plain_held = [pos(6, d.SEG_EQ_IN, 300_000)]   # no rated holding: the rated book equals the default
    assert goals.project_goal(goal(), SEGS, today=TODAY, sims=50, positions=plain_held)["assumptions"]["hash"] == a


# ── funding_summary (G7) ──

FUND_SEGS = [{"segment": d.SEG_EQ_IN, "value": 500_000}, {"segment": d.SEG_MF, "value": 300_000},
             {"segment": d.SEG_EQ_US, "value": 200_000}]
FUND_POS = [pos(1, d.SEG_EQ_IN, 500_000),
            pos(2, d.SEG_MF, 100_000, category="Debt: Liquid"),
            pos(3, d.SEG_MF, 200_000, category="Equity: Flexi Cap"),
            {"id": 9, "asset_class": d.CASH, "segment": d.SEG_EQ_US, "value": 50_000, "is_open": True},
            pos(4, d.SEG_EQ_US, 150_000),
            pos(7, d.SEG_EQ_IN, 0, is_open=False)]
FUND_GOALS = [{"id": 11, "name": "House", "allocation": {d.SEG_EQ_IN: 60, d.SEG_MF: 50}},
              {"id": 12, "name": "Education", "allocation": '{"Equity (India)": 60, "Equity (USA)": 100}'}]


def test_funding_takes_the_cushion_out_before_earmarks_and_scales_over_allocation():
    f = goals.funding_summary(FUND_GOALS, FUND_SEGS, FUND_POS, {"instrument_ids": [2, 9, 7, 999], "cash_amount": 200_000})
    assert f["total"] == 1_000_000
    assert f["cushion"] == {"amount": 150_000, "cash_amount": 200_000, "instrument_ids": [2, 9]}
    rows = {r["goal_id"]: r for r in f["earmarked"]}
    # Equity (India) is claimed 120% → each claim × 100/120; MF and US are cushion-free (200k, 150k)
    assert rows[11] == {"goal_id": 11, "name": "House", "amount": 350_000, "unscaled": 400_000}
    assert rows[12] == {"goal_id": 12, "name": "Education", "amount": 400_000, "unscaled": 450_000}
    assert f["free"] == 100_000
    assert f["over_allocated"] == [{"segment": d.SEG_EQ_IN, "claimed_pct": 120,
                                    "goals": [{"goal_id": 11, "name": "House", "pct": 60},
                                              {"goal_id": 12, "name": "Education", "pct": 60}]}]


def test_funding_never_counts_a_rupee_twice():
    goals_ = FUND_GOALS + [{"id": 13, "name": "Car", "allocation": {d.SEG_MF: 90, d.SEG_EQ_US: 40}}]
    f = goals.funding_summary(goals_, FUND_SEGS, FUND_POS, {"instrument_ids": [2, 9]})
    earmarked = sum(r["amount"] for r in f["earmarked"])
    assert earmarked + f["cushion"]["amount"] <= f["total"] + 0.01
    assert earmarked + f["cushion"]["amount"] + f["free"] == pytest.approx(f["total"], abs=0.05)
    assert {o["segment"] for o in f["over_allocated"]} == {d.SEG_EQ_IN, d.SEG_MF, d.SEG_EQ_US}
    assert all("unscaled" in r for r in f["earmarked"])


def test_funding_cash_amount_is_reported_not_subtracted():
    without = goals.funding_summary(FUND_GOALS, FUND_SEGS, FUND_POS, {"instrument_ids": [2], "cash_amount": 0})
    with_cash = goals.funding_summary(FUND_GOALS, FUND_SEGS, FUND_POS, {"instrument_ids": [2], "cash_amount": 900_000})
    assert with_cash["cushion"]["cash_amount"] == 900_000 and with_cash["cushion"]["amount"] == 100_000
    assert with_cash["free"] == without["free"] and with_cash["earmarked"] == without["earmarked"]


def test_funding_without_emergency_or_over_allocation():
    one = [{"id": 11, "name": "House", "allocation": {d.SEG_EQ_IN: 50}}]
    f = goals.funding_summary(one, FUND_SEGS, FUND_POS, None)
    assert f["cushion"] == {"amount": 0, "cash_amount": 0, "instrument_ids": []}
    assert f["earmarked"] == [{"goal_id": 11, "name": "House", "amount": 250_000}]
    assert f["free"] == 750_000 and f["over_allocated"] == []
    empty = goals.funding_summary([], [], None, None)
    assert empty == {"total": 0, "cushion": {"amount": 0, "cash_amount": 0, "instrument_ids": []},
                     "earmarked": [], "free": 0, "over_allocated": []}


# ── linked SIPs (P2.7, K15) ──

LINKED = [
    {"id": 1, "name": "Index fund", "amount": 10_000, "frequency": "monthly", "active": 1, "start_date": "2025-01-05"},
    {"id": 2, "name": "Gold", "amount": 15_000, "frequency": "quarterly", "active": 1, "start_date": None},
    {"id": 3, "name": "Paused", "amount": 3_000, "frequency": "monthly", "active": 0},
    {"id": 4, "name": "Later", "amount": 7_000, "frequency": "monthly", "active": 1, "start_date": "2026-06-01"},
    {"id": 5, "name": "Ended", "amount": 2_000, "frequency": "weekly", "active": 1, "end_date": "2025-12-31"},
    {"id": 6, "name": "Stepped", "amount": 1_200, "frequency": "yearly", "active": 1, "step_up_pct": 10},
]


def test_linked_sips_replace_the_goal_contribution():
    g = goal(monthly_contribution=1_000)
    pr = goals.project_goal(g, SEGS, today=TODAY, sims=200, linked_sips=LINKED)
    # running today: 10,000 monthly + 15,000 quarterly (5,000) + 1,200 yearly (100, no step-up)
    assert pr["linked_monthly"] == 15_100
    assert pr["contribution_source"] == "linked"
    assert [r["id"] for r in pr["linked_sips"]] == [1, 2, 3, 4, 5, 6]
    assert pr["linked_sips"][1] == {"id": 2, "name": "Gold", "amount": 15_000, "frequency": "quarterly",
                                    "monthly_equiv": 5_000}
    assert {r["id"]: r["monthly_equiv"] for r in pr["linked_sips"]} == {1: 10_000, 2: 5_000, 3: 0, 4: 0, 5: 0, 6: 100}
    # the projection is the goal's own at the linked monthly total
    same = goals.project_goal(goal(monthly_contribution=15_100), SEGS, today=TODAY, sims=200)
    for k in ("projected", "shortfall", "probability", "p10", "p50", "p90", "path", "required_sip", "status"):
        assert pr[k] == same[k], k
    assert same["contribution_source"] == "goal" and same["linked_monthly"] == 0 and same["linked_sips"] == []


def test_no_running_linked_plan_keeps_the_goal_contribution():
    g = goal(monthly_contribution=4_000)
    base = goals.project_goal(g, SEGS, today=TODAY, sims=200)
    for links in (None, [], [LINKED[2], LINKED[3]]):
        pr = goals.project_goal(g, SEGS, today=TODAY, sims=200, linked_sips=links)
        assert pr["contribution_source"] == "goal" and pr["linked_monthly"] == 0
        assert {k: v for k, v in pr.items() if k != "linked_sips"} == \
            {k: v for k, v in base.items() if k != "linked_sips"}
    assert base["linked_sips"] == []


# ── rebalance_plan P2 (P2.8, K13) ──

from tracker.analytics import tax as tax_mod                      # noqa: E402
from tracker.analytics.portfolio import compute_portfolio         # noqa: E402

TAX_TODAY = date(2025, 12, 1)       # FY2025-26: STCG 20%, LTCG 12.5% over ₹1.25 L (as test_tax_whatif)
FY = "FY2025-26"


def T(id_, iid, date_, type_, qty=None, amount=0.0):
    return {"id": id_, "instrument_id": iid, "date": date_, "type": type_, "quantity": qty, "amount": amount,
            "amount_fc": None, "principal": None, "fees": None, "owner": "a"}


def I(id_, ac, name, **kw):
    base = {"id": id_, "owner": "a", "asset_class": ac, "name": name, "currency": "INR", "status": "active"}
    base.update(kw)
    base["tax_class"] = d.default_tax_class(ac, base.get("market"), base.get("category"), name)
    return base


def tax_book():
    """Three Indian stocks (a short-term loss, a long-term gain inside the exemption, a short-term gain) and
    one equity fund."""
    inst = [I(1, d.EQUITY, "Newbie", last_price=600.0, market="India"),        # ST gain: 100 → 60,000
            I(2, d.EQUITY, "Oldie", last_price=900.0, market="India"),         # LT gain: 100 → 90,000
            I(3, d.EQUITY, "Loser", last_price=950.0, market="India"),         # ST loss: 100 → 95,000
            I(4, d.MUTUAL_FUND, "Flexi", last_price=10.0, category="Flexi Cap")]
    txns = [T(1, 1, "2025-06-01", d.BUY, 100, 50000), T(2, 2, "2023-06-01", d.BUY, 100, 50000),
            T(3, 3, "2025-03-01", d.BUY, 100, 100000), T(4, 4, "2025-01-01", d.BUY, 1000, 10000)]
    return compute_portfolio(inst, txns, None, today=TAX_TODAY), txns, inst


def combined_delta(port, txns, inst, sells):
    """compute_tax with every planned sale booked as a real SELL, minus compute_tax without: one combined run."""
    extra = [T(100 + k, s["instrument_id"], TAX_TODAY.isoformat(), d.SELL, s["qty"], s["proceeds"])
             for k, s in enumerate(sells)]
    after_port = compute_portfolio(inst, txns + extra, None, today=TAX_TODAY)
    before = tax_mod.compute_tax(port, txns, inst, FY, 0.30, today=TAX_TODAY, with_opportunities=False)
    after = tax_mod.compute_tax(after_port, txns + extra, inst, FY, 0.30, today=TAX_TODAY, with_opportunities=False)
    return after["estimate"]["total"] - before["estimate"]["total"]


def test_no_sell_plan_is_unchanged():
    segs = [{"segment": "A", "value": 70000}, {"segment": "B", "value": 30000}]
    plan = goals.rebalance_plan(segs, {"A": 50, "B": 50}, new_money=20000)
    assert plan == {"rows": [{"segment": "A", "current": 70000.0, "target_pct": 50.0, "action": "hold", "amount": 0.0,
                              "current_pct": 70.0, "after_pct": 58.33},
                             {"segment": "B", "current": 30000.0, "target_pct": 50.0, "action": "buy", "amount": 20000.0,
                              "current_pct": 30.0, "after_pct": 41.67}],
                    "total": 100000.0, "new_money": 20000, "allow_sell": False, "shortfall_to_targets": 30000.0,
                    "money_to_fix_without_selling": 40000.0}
    # the tax inputs do nothing without allow_sell
    port, txns, inst = tax_book()
    assert goals.rebalance_plan(segs, {"A": 50, "B": 50}, new_money=20000, port=port, txns=txns,
                                instruments=inst, slab_rate=0.30, today=TAX_TODAY) == plan


def test_fd_p2p_epf_nps_are_never_sold_and_buys_are_scaled():
    segs = [{"segment": d.SEG_FD, "value": 100_000}, {"segment": d.SEG_P2P, "value": 50_000},
            {"segment": d.SEG_EPF, "value": 100_000}, {"segment": d.SEG_NPS, "value": 50_000},
            {"segment": d.SEG_EQ_IN, "value": 50_000}]
    targets = {d.SEG_EQ_IN: 60, d.SEG_FD: 10, d.SEG_P2P: 10, d.SEG_EPF: 10, d.SEG_NPS: 10}
    plan = goals.rebalance_plan(segs, targets, new_money=20_000, allow_sell=True)
    rows = {r["segment"]: r for r in plan["rows"]}
    assert not [r for r in plan["rows"] if r["action"] == "sell"]
    # final total 370,000: each 10% class is worth 37,000 at target
    assert rows[d.SEG_FD]["action"] == "hold" and rows[d.SEG_FD]["amount"] == 0
    assert rows[d.SEG_FD]["let_mature"] == 63_000 and "locked" not in rows[d.SEG_FD]
    assert rows[d.SEG_P2P]["action"] == "hold" and rows[d.SEG_P2P]["let_mature"] == 13_000
    for seg, over in ((d.SEG_EPF, 63_000), (d.SEG_NPS, 13_000)):
        assert rows[seg]["action"] == "hold" and rows[seg]["amount"] == 0 and rows[seg]["locked"] is True
        assert "let_mature" not in rows[seg]
    assert plan["not_sold"] == 63_000 + 13_000 + 63_000 + 13_000
    # nothing is freed, so the equity buy is cut from 172,000 to the new money alone
    assert rows[d.SEG_EQ_IN]["action"] == "buy" and rows[d.SEG_EQ_IN]["amount"] == 20_000
    assert sum(r["amount"] for r in plan["rows"] if r["action"] == "buy") == pytest.approx(20_000)
    after = {r["segment"]: r["after_pct"] for r in plan["rows"]}
    assert after[d.SEG_EQ_IN] == round(70_000 / 370_000 * 100, 2)
    assert sum(after.values()) == pytest.approx(100, abs=0.05)
    assert "tax_total" not in plan and "tax_note" not in plan
    # with no new money there is nothing to buy with
    none = {r["segment"]: r for r in goals.rebalance_plan(segs, targets, allow_sell=True)["rows"]}
    assert none[d.SEG_EQ_IN]["action"] == "hold" and none[d.SEG_EQ_IN]["amount"] == 0


def test_an_allowed_sell_funds_the_buys_at_full_size():
    segs = [{"segment": d.SEG_EQ_IN, "value": 80_000}, {"segment": d.SEG_MF, "value": 20_000},
            {"segment": d.SEG_FD, "value": 50_000}]
    plan = goals.rebalance_plan(segs, {d.SEG_EQ_IN: 40, d.SEG_MF: 40, d.SEG_FD: 20}, allow_sell=True)
    rows = {r["segment"]: r for r in plan["rows"]}
    # equity sells 20,000; FD is 20,000 over but only matures; the MF buy (40,000) is cut to what equity frees
    assert rows[d.SEG_EQ_IN]["action"] == "sell" and rows[d.SEG_EQ_IN]["amount"] == 20_000
    assert rows[d.SEG_FD]["let_mature"] == 20_000
    assert rows[d.SEG_MF]["action"] == "buy" and rows[d.SEG_MF]["amount"] == 20_000
    assert plan["not_sold"] == 20_000
    assert "tax_if_sold" not in rows[d.SEG_EQ_IN] and "sells" not in rows[d.SEG_EQ_IN]


def test_sells_are_ordered_loss_then_exempt_long_term_then_short_term():
    port, txns, inst = tax_book()
    plan = goals.rebalance_plan(port["segments"], {d.SEG_EQ_IN: 10, d.SEG_MF: 90}, allow_sell=True,
                                port=port, txns=txns, instruments=inst, slab_rate=0.30, today=TAX_TODAY)
    rows = {r["segment"]: r for r in plan["rows"]}
    eq = rows[d.SEG_EQ_IN]
    # total 255,000; equity's target is 25,500, so 219,500 is to be sold
    assert eq["action"] == "sell" and eq["amount"] == 219_500
    assert [(s["instrument_id"], s["order"]) for s in eq["sells"]] == [(3, "loss"), (2, "lt_exempt"), (1, "other")]
    loser, oldie, newbie = eq["sells"]
    assert loser["qty"] == 100 and loser["gain"] == -5000 and loser["tax"] == 0
    assert oldie["qty"] == 100 and oldie["lt_gain"] == 40000 and oldie["tax"] == 0
    # 34,500 still to free at ₹600 → 57 whole shares (rounded down); the ₹300 left is below a sale's minimum
    assert newbie["qty"] == 57 and newbie["proceeds"] == 34_200 and newbie["st_gain"] == 5_700
    assert newbie["tax"] == pytest.approx(5_700 * 0.20 * 1.04)          # what_if_sale alone
    assert eq["covered"] == 219_200
    # costed together the ₹5,000 loss offsets the short-term gain: 700 × 20% × 1.04
    assert plan["tax_total"] == pytest.approx(combined_delta(port, txns, inst, eq["sells"]), abs=0.01)
    assert plan["tax_total"] == pytest.approx(145.6) and eq["tax_if_sold"] == pytest.approx(145.6)
    assert "exemption is used once" in plan["tax_note"] and tax_mod.CHARGES_NOTE in plan["tax_note"]
    # the buy is scaled to the money the sells actually free
    assert rows[d.SEG_MF]["action"] == "buy" and rows[d.SEG_MF]["amount"] == pytest.approx(219_200)
    assert plan["not_sold"] == 0


def test_rebalance_never_plans_a_sale_of_fd_p2p_epf_or_nps_with_the_ledger():
    port, txns, inst = tax_book()
    segs = port["segments"] + [{"segment": d.SEG_FD, "value": 500_000}, {"segment": d.SEG_EPF, "value": 300_000}]
    targets = {d.SEG_EQ_IN: 50, d.SEG_MF: 30, d.SEG_FD: 10, d.SEG_EPF: 10}
    plan = goals.rebalance_plan(segs, targets, allow_sell=True, port=port, txns=txns, instruments=inst,
                                slab_rate=0.30, today=TAX_TODAY)
    sells = [r for r in plan["rows"] if r["action"] == "sell"]
    assert all(r["segment"] not in (d.SEG_FD, d.SEG_P2P, d.SEG_EPF, d.SEG_NPS) for r in sells)
    assert plan["tax_total"] == 0 and "tax_note" in plan


def test_plan_sales_legs_are_marginal_and_share_one_exemption():
    inst = [I(1, d.EQUITY, "Oldie", last_price=2000.0, market="India"),
            I(2, d.MUTUAL_FUND, "Old fund", last_price=30.0, category="Flexi Cap")]
    txns = [T(1, 1, "2022-06-01", d.BUY, 100, 100000), T(2, 2, "2022-06-01", d.BUY, 5000, 100000)]
    port = compute_portfolio(inst, txns, None, today=TAX_TODAY)
    res = tax_mod.plan_sales(port, txns, inst, [{"segment": d.SEG_EQ_IN, "amount": 200_000},
                                                {"segment": d.SEG_MF, "amount": 100_000}],
                             slab_rate=0.30, today=TAX_TODAY)
    eq, mf = res["legs"]
    # leg 1 sells the stock whole: a ₹100,000 long-term gain inside the exemption
    assert [(s["instrument_id"], s["order"], s["qty"]) for s in eq["sells"]] == [(1, "lt_exempt", 100)]
    assert eq["tax"] == 0 and eq["covered"] == 200_000
    # leg 2: 100,000 of the fund is a ₹66,666.67 long-term gain, but only ₹25,000 of exemption is left
    (sale,) = mf["sells"]
    assert sale["order"] == "other" and sale["qty"] == pytest.approx(3333.333)
    assert sale["tax"] == 0                       # alone, it fits inside the exemption
    gain = sale["gain"]
    assert mf["tax"] == pytest.approx((gain - 25_000) * 0.125 * 1.04, abs=0.02)
    assert res["tax_total"] == pytest.approx(eq["tax"] + mf["tax"], abs=0.01)
    assert res["tax_total"] == pytest.approx(combined_delta(port, txns, inst, eq["sells"] + mf["sells"]), abs=0.02)
    assert res["exemption_used"] == 125_000


def test_plan_sales_skips_locked_unpriced_and_capped_candidates():
    inst = [I(1, d.MUTUAL_FUND, "Tax Saver", category="ELSS", last_price=50.0),
            I(2, d.MUTUAL_FUND, "No price", category="Flexi Cap"),
            I(3, d.MUTUAL_FUND, "Liquid", category="Debt: Liquid", last_price=20.0),
            I(4, d.MUTUAL_FUND, "Index", category="Index", last_price=20.0)]
    txns = [T(1, 1, "2024-06-01", d.BUY, 1000, 30000), T(2, 2, "2024-06-01", d.BUY, 100, 1000),
            T(3, 3, "2025-11-01", d.BUY, 1000, 19000), T(4, 4, "2025-11-01", d.BUY, 1000, 19000)]
    port = compute_portfolio(inst, txns, None, today=TAX_TODAY)
    res = tax_mod.plan_sales(port, txns, inst, [{"segment": d.SEG_MF, "amount": 100_000}], slab_rate=0.30,
                             today=TAX_TODAY)
    (leg,) = res["legs"]
    # the ELSS units are locked until 2027 and the fund without a price cannot be sold
    assert {s["instrument_id"] for s in leg["sells"]} == {3, 4}
    assert leg["covered"] == 40_000 and leg["amount"] == 100_000
    capped = tax_mod.plan_sales(port, txns, inst, [{"segment": d.SEG_MF, "amount": 100_000}], slab_rate=0.30,
                                today=TAX_TODAY, max_per_leg=1)
    assert len(capped["legs"][0]["sells"]) == 1
    empty = tax_mod.plan_sales(port, txns, inst, [{"segment": d.SEG_FD, "amount": 5_000}], slab_rate=0.30,
                               today=TAX_TODAY)
    assert empty["legs"] == [{"segment": d.SEG_FD, "amount": 5_000, "covered": 0, "sells": [], "tax": 0}]
    assert empty["tax_total"] == 0


# ── the base Book (AMENDMENTS R4) ──

def _hot_book(points=4.0):
    b = A.effective_book(None)
    row = {**b["segments"][d.SEG_EQ_IN], "return_pct": b["segments"][d.SEG_EQ_IN]["return_pct"] + points,
           "source": "override"}
    return {**b, "segments": {**b["segments"], d.SEG_EQ_IN: row}}


def test_project_goal_reads_the_base_book():
    g = goal(monthly_contribution=5000)
    plain = goals.project_goal(g, SEGS, today=TODAY, sims=300)
    assert goals.project_goal(g, SEGS, today=TODAY, sims=300, book=A.effective_book(None)) == plain
    hot = goals.project_goal(g, SEGS, today=TODAY, sims=300, book=_hot_book())
    assert hot["probability"] > plain["probability"] and hot["p50"] > plain["p50"]
    assert hot["assumptions"]["hash"] == A.book_hash(_hot_book()) != plain["assumptions"]["hash"]
    # with positions the holdings still rate FD/EPF/P2P, over the base Book's other rows
    p = [pos(1, d.SEG_EQ_IN, 300_000)]
    with_pos = goals.project_goal(g, SEGS, today=TODAY, sims=300, positions=p, book=_hot_book())
    assert with_pos["assumptions"]["hash"] == A.book_hash(A.rated_book(p, _hot_book()))
