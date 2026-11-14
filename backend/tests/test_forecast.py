"""Forecasting, risk, allocation lab and SIP plans: offline unit tests plus API round trips."""
import math
import random
from datetime import date, timedelta

import pytest
from conftest import GUEST, USER, auth

from tracker import domain as d
from tracker import prices as px
from tracker.analytics import assumptions as A
from tracker.analytics import forecast, plans, quant
from tracker.analytics import simulate as S
from tracker.analytics.insights import build_insights
from tracker.analytics.portfolio import compute_portfolio


def walk(start_price: float, days: int, drift: float = 0.0005, vol: float = 0.015, seed: int = 1, end: date | None = None):
    """Weekday closes ending today (or `end`), a geometric random walk."""
    rng = random.Random(seed)
    end = end or date.today()
    out, p = [], start_price
    day = end - timedelta(days=int(days * 1.45))
    while day <= end:
        if day.weekday() < 5:
            p *= math.exp(rng.gauss(drift, vol))
            out.append((day.isoformat(), round(p, 4)))
        day += timedelta(days=1)
    return out


PORT = {"totals": {"value": 160000}, "segments": [
    {"segment": d.SEG_EQ_IN, "value": 90000}, {"segment": d.SEG_EQ_US, "value": 20000},
    {"segment": d.SEG_FD, "value": 50000}, {"segment": d.SEG_EPF, "value": 0}]}


# ── quant ──

def test_holding_outlook_reads_trend_and_builds_a_widening_cone():
    pts = walk(100, 800, drift=0.0008)
    bench = walk(20000, 800, drift=0.0004, vol=0.009, seed=2)
    o = quant.holding_outlook(pts, bench, d.SEG_EQ_IN, today=date.fromisoformat(pts[-1][0]))
    assert o["trend"]["key"] in ("up", "down", "mixed") and o["rsi"] is not None
    c = o["cone"]
    assert c["3M"]["p10"] < c["3M"]["p50"] < c["3M"]["p90"]
    assert c["1Y"]["p90"] - c["1Y"]["p10"] > c["3M"]["p90"] - c["3M"]["p10"]  # uncertainty grows with time
    assert o["beta"] is not None and o["volatility"]["annual_pct"] > 0
    assert quant.holding_outlook(pts[:10]) is None


# ── forecast ──

def test_projection_bands_order_and_contributions():
    pr = forecast.project_portfolio(PORT, None, years=10, monthly_sip=10000, step_up_pct=10, sims=400)
    end = pr["path"][-1]
    assert end["p10"] < end["p25"] < end["p50"] < end["p75"] < end["p90"]
    # 10 years of SIP stepping up 10% a year: 120,000 × (1.1^10 − 1)/0.1 on top of today's value
    assert end["contributed"] == pytest.approx(160000 + 120000 * (1.1 ** 10 - 1) / 0.1, rel=1e-6)
    assert pr["scenarios"]["bear"] < pr["scenarios"]["base"] < pr["scenarios"]["bull"]
    assert pr["scenarios"]["no_more_investing"] < pr["scenarios"]["base"]
    assert pr["end"]["real_p50"] < pr["end"]["p50"]
    assert all(m["probability"] > 0 for m in pr["milestones"])


def test_projection_scenarios_are_percentiles_of_one_simulation():
    pr = forecast.project_portfolio(PORT, None, years=10, monthly_sip=10000, sims=1000)
    sc, end = pr["scenarios"], pr["end"]
    assert sc["base"] == end["p50"] and sc["bear"] == end["p10"] and sc["bull"] == end["p90"]
    # the mean is kept but sits above the typical (median) outcome
    assert end["expected"] > end["p50"]
    # no more investing: the same shocks without the SIP, so lower than base and above zero
    assert 0 < sc["no_more_investing"] < sc["base"]
    # typical growth on top of the money put in
    assert pr["typical_cagr_pct"] == pytest.approx(((end["p50"] / end["contributed"]) ** 0.1 - 1) * 100, abs=0.01)
    h = pr["honesty"]
    assert h["p50"].startswith("Typical") and "1,000" in h["p50"]
    assert h["p10"] == "1-in-10 bad case" and h["p90"] == "1-in-10 good case" and "Average" in h["mean"]


def test_projection_real_value_uses_the_plan_inflation():
    default = forecast.project_portfolio(PORT, None, years=10, sims=200)
    assert default["end"]["real_p50"] == pytest.approx(default["end"]["p50"] / 1.06 ** 10, abs=0.02)
    assert default["assumptions"]["inflation_pct"] == 6.0
    low = forecast.project_portfolio(PORT, None, years=10, sims=200, inflation=0.04)
    assert low["end"]["p50"] == default["end"]["p50"]  # the simulation itself does not change
    assert low["end"]["real_p50"] == pytest.approx(low["end"]["p50"] / 1.04 ** 10, abs=0.02)
    assert low["assumptions"]["inflation_pct"] == 4.0
    # retirementPlan.inflation_pct is a percent: passing it raw is an error, not a silent 50%
    with pytest.raises(ValueError):
        forecast.project_portfolio(PORT, None, years=10, sims=200, inflation=6)
    plan = {"inflation_pct": 6}
    six = forecast.project_portfolio(PORT, None, years=10, sims=200, inflation=plan["inflation_pct"] / 100)
    assert six["end"]["real_p50"] == default["end"]["real_p50"]


def test_projection_blends_own_record_when_history_is_long_enough():
    base = forecast.blended_assumptions(PORT["segments"], None)
    own = forecast.blended_assumptions(PORT["segments"], {"days": 1000, "twr_annualised": 25.0, "volatility": 30.0})
    assert own["mu"] > base["mu"] and own["sigma"] > base["sigma"] and "record" in own["basis"]
    short = forecast.blended_assumptions(PORT["segments"], {"days": 300, "twr_annualised": 25.0, "volatility": 30.0})
    assert short["mu"] == base["mu"]
    # the blend is 70/30 with the record, clamped (25% and 35% at most)
    hot = forecast.blended_assumptions(PORT["segments"], {"days": 1000, "twr_annualised": 80.0, "volatility": 90.0})
    assert hot["mu"] == pytest.approx(0.7 * base["mu"] + 0.3 * 0.25) and hot["sigma"] == pytest.approx(0.7 * base["sigma"] + 0.3 * 0.35)
    assert hot["own"] == {"return_pct": 25.0, "volatility_pct": 35.0}


def test_blended_assumptions_come_from_the_book():
    """§6.13 P1: μ and σ are mu_sigma over Book keys; segment weights against the default Book without positions."""
    a = forecast.blended_assumptions(PORT["segments"], None)
    w = {d.SEG_EQ_IN: 90 / 160, d.SEG_EQ_US: 20 / 160, d.SEG_FD: 50 / 160}   # the empty EPF segment is left out
    mu, sigma = A.mu_sigma(w, A.effective_book(None))
    assert a["weights"] == pytest.approx(w) and a["mu"] == pytest.approx(mu) and a["sigma"] == pytest.approx(sigma)
    assert a["basis"] == "segment mix" and a["hash"] == A.book_hash(A.effective_book(None))
    assert a["typical_pct"] == pytest.approx(A.typical(mu, sigma) * 100, abs=0.01)
    # σ never drops below the 2% floor, even for an all-EPF portfolio (Book σ 0.5%)
    epf = forecast.blended_assumptions([{"segment": d.SEG_EPF, "value": 100000}], None)
    assert epf["sigma"] == 0.02 and epf["mu"] == pytest.approx(0.0825)
    # no holdings at all: a diversified mutual fund (the Book row), never a local copy of the numbers
    empty = forecast.blended_assumptions([], None)
    assert (empty["mu"], empty["sigma"]) == A.ASSUMPTIONS[d.SEG_MF] and empty["mix"] == {}


def _mf(iid, name, category, value, tax_class=d.TAX_EQUITY):
    return {"id": iid, "asset_class": d.MUTUAL_FUND, "segment": d.SEG_MF, "name": name, "category": category,
            "tax_class": tax_class, "value": value, "is_open": True}


def _fd_pos(iid, value, rate):
    return {"id": iid, "asset_class": d.FIXED_DEPOSIT, "segment": d.SEG_FD, "name": f"FD {iid}", "value": value,
            "rate": rate, "is_open": True}


def _book_port():
    """A port with positions: an equity fund, a debt fund, Indian equity and an FD at 8%."""
    pos = [_mf(1, "Flexi cap", "Equity: Flexi Cap", 60000), _mf(2, "Short duration", "Debt: Short Duration", 40000, d.TAX_DEBT),
           {"id": 3, "asset_class": d.EQUITY, "segment": d.SEG_EQ_IN, "name": "ITC", "value": 100000, "is_open": True},
           _fd_pos(4, 50000, 8.0)]
    segs = [{"segment": d.SEG_MF, "value": 100000}, {"segment": d.SEG_EQ_IN, "value": 100000}, {"segment": d.SEG_FD, "value": 50000}]
    return {"totals": {"value": 250000}, "segments": segs, "positions": pos}


def test_blended_assumptions_with_positions_use_the_rated_book_and_fold_debt_into_mutual_funds():
    port = _book_port()
    a = forecast.blended_assumptions(port["segments"], None, positions=port["positions"])
    book = A.rated_book(port["positions"])
    w = A.weights_from_positions(port["positions"])
    assert w[A.MF_DEBT] == pytest.approx(0.16) and book["segments"][d.SEG_FD]["return_pct"] == 8.0
    mu, sigma = A.mu_sigma(w, book)
    assert a["mu"] == pytest.approx(mu) and a["sigma"] == pytest.approx(sigma) and a["basis"] == "holdings mix"
    assert a["hash"] == A.book_hash(book) != A.book_hash(A.effective_book(None))
    # display rows: one 'Mutual Funds' row holding both funds, at the value-weighted mean of the two keys
    pr = forecast.project_portfolio(port, None, years=5, sims=200)
    rows = {r["segment"]: r for r in pr["assumptions"]["mix"]}
    assert set(rows) == {d.SEG_MF, d.SEG_EQ_IN, d.SEG_FD}
    assert rows[d.SEG_MF]["weight_pct"] == 40.0
    assert rows[d.SEG_MF]["return_pct"] == pytest.approx((0.6 * 11 + 0.4 * 7), abs=0.05)
    assert rows[d.SEG_MF]["volatility_pct"] == pytest.approx((0.6 * 15 + 0.4 * 3), abs=0.05)
    assert rows[d.SEG_FD]["return_pct"] == 8.0
    assert pr["assumptions"]["return_pct"] == pytest.approx(mu * 100, abs=0.01)


def test_projection_is_a_thin_wrapper_over_simulate():
    """K9: payload keys only grow; the default projection is the Book's (δ = 0, s = 1); the record blend and the
    return override still move it, through δ on every market-linked class."""
    pr = forecast.project_portfolio(PORT, None, years=10, monthly_sip=10000, sims=400)
    assert pr["engine"] == "simulate" and pr["flows_basis"] == "mix"
    assert pr["calibration"] == {"delta_pct": 0.0, "vol_scale": 1.0}
    assert {"by_key", "prob_below_contributed_3y", "max_drawdown_p50"} <= set(pr) and "after_tax" not in pr["end"]
    assert set(pr["by_key"]) == {d.SEG_EQ_IN, d.SEG_EQ_US, d.SEG_FD}
    assert pr["by_key"][d.SEG_FD] == pytest.approx(50000 * 1.07 ** 10, rel=1e-6)   # a ladder: deterministic
    assert 0 <= pr["prob_below_contributed_3y"] <= 100 and 0 < pr["max_drawdown_p50"] < 100
    hot = forecast.project_portfolio(PORT, None, years=10, monthly_sip=10000, sims=400, return_override=14)
    assert hot["calibration"]["delta_pct"] == 5.0 and hot["assumptions"]["requested_return_pct"] == 14.0
    # δ's cap on the 68.75% that is market-linked: the simulated 10.31% + 3.44 points is what is reported (wave-6 review)
    assert hot["assumptions"]["return_pct"] == 13.75 and hot["assumptions"]["return_note"]
    assert hot["end"]["p10"] > pr["end"]["p10"] and hot["end"]["p50"] > pr["end"]["p50"]   # same draws (CRN)
    rec = forecast.project_portfolio(PORT, {"days": 1000, "twr_annualised": 25.0, "volatility": 30.0}, years=10,
                                     monthly_sip=10000, sims=400)
    assert rec["calibration"]["delta_pct"] > 0 and rec["calibration"]["vol_scale"] > 1
    assert rec["end"]["p50"] > pr["end"]["p50"] and rec["end"]["p90"] - rec["end"]["p10"] > pr["end"]["p90"] - pr["end"]["p10"]
    # the same seed repeats exactly
    assert forecast.project_portfolio(PORT, None, years=10, monthly_sip=10000, sims=400)["path"] == pr["path"]


def test_projection_flows_from_plans_and_after_tax():
    port = _book_port()
    today = date(2026, 11, 14)
    sips = [{"id": 1, "name": "Flexi", "instrument_id": 1, "amount": 10000, "frequency": "monthly", "day_of_month": 5,
             "active": 1, "start_date": "2026-01-05", "step_up_pct": 0},
            {"id": 2, "name": "ITC", "instrument_id": 3, "amount": 9000, "frequency": "quarterly", "day_of_month": 20,
             "active": 1, "start_date": "2026-02-20", "step_up_pct": 0}]
    plans_pr = forecast.project_portfolio(port, None, years=5, monthly_sip=None, sims=400, today=today, sips=sips)
    assert plans_pr["flows_basis"] == "plans" and plans_pr["monthly_sip"] == 13000
    # every instalment is counted once, on its real date: 60 monthly + 20 quarterly over five years
    assert plans_pr["end"]["contributed"] == pytest.approx(250000 + 60 * 10000 + 20 * 9000)
    mix_pr = forecast.project_portfolio(port, None, years=5, monthly_sip=13000, sims=400, today=today, sips=sips)
    assert mix_pr["flows_basis"] == "mix" and mix_pr["end"]["contributed"] == pytest.approx(250000 + 60 * 13000)
    # debt funds are reported under Mutual Funds
    assert A.MF_DEBT not in plans_pr["by_key"] and plans_pr["by_key"][d.SEG_MF] > 100000
    taxed = forecast.project_portfolio(port, None, years=5, monthly_sip=13000, sims=400, today=today, after_tax=True,
                                       slab_rate=0.30)
    at = taxed["end"]["after_tax"]
    assert at["p10"] <= taxed["end"]["p10"] and at["p50"] <= taxed["end"]["p50"] and at["p90"] <= taxed["end"]["p90"]
    assert at["note"] == "at today's rules; surcharge not modelled"
    assert taxed["end"]["p50"] < mix_pr["end"]["p50"]          # FD accrual net of slab tax too


def _half_fd_port():
    """₹5 L Indian equity (Book μ 12%) and a ₹5 L FD at 7% maturing after any horizon here: the mix is 9.5%, and δ's
    ±5-point cap on the half that is market-linked stops the simulation at 12.0%."""
    pos = [{"id": 1, "asset_class": d.EQUITY, "segment": d.SEG_EQ_IN, "name": "Eq", "value": 500000, "is_open": True},
           {**_fd_pos(2, 500000, 7.0), "maturity_date": "2060-01-01"}]
    segs = [{"segment": d.SEG_EQ_IN, "value": 500000}, {"segment": d.SEG_FD, "value": 500000}]
    return {"totals": {"value": 1e6}, "segments": segs, "positions": pos}


def test_a_capped_return_is_reported_as_the_return_simulated():
    """Wave-6 review: past δ's cap a higher override no longer moves the simulation, so the payload reports the
    return the simulation used (and keeps the one asked for), and retirement's deterministic figures use it too."""
    today, port = date(2026, 11, 14), _half_fd_port()
    within = forecast.project_portfolio(port, None, years=10, monthly_sip=0, sims=400, today=today, return_override=11)
    assert within["assumptions"]["return_pct"] == 11.0 and within["assumptions"]["return_note"] is None
    assert within["assumptions"]["requested_return_pct"] == 11.0
    capped = {ov: forecast.project_portfolio(port, None, years=10, monthly_sip=0, sims=400, today=today, return_override=ov)
              for ov in (15, 20)}
    for ov, pr in capped.items():
        a = pr["assumptions"]
        assert pr["calibration"]["delta_pct"] == 5.0
        assert a["return_pct"] == 12.0 and a["requested_return_pct"] == float(ov)
        assert a["typical_pct"] == round(A.typical(0.12, a["volatility_pct"] / 100) * 100, 2)
        assert a["return_note"].startswith(f"Your {ov}% a year was limited to 12.00%")
    assert capped[15]["end"] == capped[20]["end"]            # the same simulation, so the same reported return
    default = forecast.project_portfolio(port, None, years=10, monthly_sip=0, sims=400, today=today)
    assert default["assumptions"]["return_note"] is None and default["assumptions"]["return_pct"] == 9.5

    base = {"current_age": 35, "retire_age": 60, "life_expectancy": 85, "monthly_expenses": 50000, "monthly_sip": 20000}
    r15, r20 = (forecast.retirement_plan(port, None, {**base, "return_pct": rp}, today=today, sims=400) for rp in (15, 20))
    for rp, r in ((15, r15), (20, r20)):
        assert r["inputs"]["return_pct"] == r["assumptions"]["return_pct"] == 12.0
        assert r["inputs"]["requested_return_pct"] == float(rp) and r["inputs"]["return_note"]
        assert "(limited)" in r["assumptions"]["basis"]
    # one assumption for the whole payload: the deterministic figures no longer move once the chances stop moving
    assert (r15["projected"], r15["gap"], r15["probability"], r15["status"]) == \
        (r20["projected"], r20["gap"], r20["probability"], r20["status"])
    r12 = forecast.retirement_plan(port, None, {**base, "return_pct": 12}, today=today, sims=400)
    assert r12["inputs"]["return_note"] is None and r12["projected"] == r15["projected"]


def test_retirement_uses_one_sip_basis_for_the_whole_payload():
    """Wave-6 review (K9's rule): the plans replace the SIP only when the params name no monthly_sip, and the
    deterministic figures follow the same basis as the chances."""
    today = date(2026, 11, 14)
    port = {"totals": {"value": 2e6}, "segments": [{"segment": d.SEG_EQ_IN, "value": 2e6}],
            "positions": [{"id": 1, "asset_class": d.EQUITY, "segment": d.SEG_EQ_IN, "name": "Eq", "value": 2e6, "is_open": True}]}
    base = {"current_age": 35, "retire_age": 60, "life_expectancy": 85, "monthly_expenses": 60000}
    plan = [{"id": 1, "name": "Eq SIP", "instrument_id": 1, "amount": 30000, "frequency": "monthly", "day_of_month": 5,
             "active": 1, "start_date": "2026-01-05", "step_up_pct": 0}]
    keys = ("projected", "gap", "probability", "probability_lasts", "status", "required_sip")

    typed = forecast.retirement_plan(port, None, {**base, "monthly_sip": 50000}, today=today, sims=400)
    for sips in ([], plan):           # a typed monthly_sip wins over the plans, empty or not
        r = forecast.retirement_plan(port, None, {**base, "monthly_sip": 50000}, today=today, sims=400, sips=sips)
        assert r["flows_basis"] == "input" and r["inputs"]["monthly_sip"] == 50000
        assert [r[k] for k in keys] == [typed[k] for k in keys]

    planned = forecast.retirement_plan(port, None, base, today=today, sims=400, sips=plan)
    lump = forecast.retirement_plan(port, None, {**base, "monthly_sip": 30000}, today=today, sims=400)
    assert planned["flows_basis"] == "plans" and planned["inputs"]["monthly_sip"] == 30000
    assert planned["projected"] == lump["projected"] and planned["gap"] == lump["gap"]   # deterministic: the plans' total
    assert planned["probability"] == pytest.approx(lump["probability"], abs=3)
    nothing = forecast.retirement_plan(port, None, base, today=today, sims=400, sips=[])
    assert nothing["inputs"]["monthly_sip"] == 0 and nothing["projected"] < planned["projected"]


def test_stress_plan_impact_lets_a_typed_retirement_sip_win_over_the_plans():
    today = date(2026, 11, 14)
    plan = {"retirement": {**RETIRE, "monthly_sip": 30000}, "goals": []}
    without = forecast.stress_test(_beta_port(), monthly_sip=30000, plan=plan, today=today)
    empty = forecast.stress_test(_beta_port(), monthly_sip=30000, plan=plan, today=today, sips=[])
    assert empty["plan_impact"] == without["plan_impact"] and without["plan_impact"]["retirement_before"] > 0


def test_stress_test_hits_equity_not_fds():
    st = forecast.stress_test(PORT, monthly_sip=5000)
    gfc = next(s for s in st["scenarios"] if s["key"] == "gfc")
    assert gfc["impact"] < 0 and all(r["segment"] != d.SEG_FD for r in gfc["rows"])
    assert gfc["impact_pct"] == pytest.approx((90000 * -0.52 + 20000 * -0.30) / 160000 * 100, abs=0.01)
    assert gfc["recovery_months"] and gfc["recovery_months"] > 0
    assert next(s for s in st["scenarios"] if s["key"] == "gold")["impact"] == 0
    assert st["worst"] == "gfc"
    # no positions: nothing is split out as a debt fund
    assert all(r.get("book_key") != A.MF_DEBT for s in st["scenarios"] for r in s["rows"])


def test_stress_debt_fund_takes_the_rates_shock_in_its_own_row():
    port = _book_port()
    st = forecast.stress_test(port, monthly_sip=0)
    sc = {s["key"]: s for s in st["scenarios"]}
    for key, mf_shock in (("rates", -0.14), ("covid", -0.33), ("gfc", -0.48)):
        rows = {r["book_key"]: r for r in sc[key]["rows"]}
        debt = rows[A.MF_DEBT]
        assert debt["segment"] == "Mutual Funds (debt)" and debt["value"] == 40000
        assert debt["shock_pct"] == -4.0 and debt["impact"] == -1600
        # only the equity fund takes the equity MF shock
        assert rows[d.SEG_MF]["value"] == 60000 and rows[d.SEG_MF]["impact"] == pytest.approx(60000 * mf_shock)
    rates = sc["rates"]
    assert rates["impact"] == pytest.approx(100000 * -0.15 + 60000 * -0.14 + 40000 * -0.04)
    # a gold-only, rupee-only, P2P-only or routine-correction shock leaves debt funds alone
    for key in ("correction", "rupee", "gold", "p2p"):
        assert all(r["book_key"] != A.MF_DEBT for r in sc[key]["rows"])
    # debt funds are not market-exposed: equity 100k + equity fund 60k of 250k
    assert st["market_exposed_pct"] == 64.0
    assert st["total"] == 250000
    # recovery (K11): each class grows at its Book *typical* return, FD at its holding rate of 8%; no SIP here, so
    # markets alone and with SIPs agree, and recovery_months is the with-SIPs alias
    after = {d.SEG_EQ_IN: 85000, d.SEG_MF: 60000 * 0.86, A.MF_DEBT: 40000 * 0.96, d.SEG_FD: 50000}
    typ = {d.SEG_EQ_IN: A.typical(0.12, 0.18), d.SEG_MF: A.typical(0.11, 0.15), A.MF_DEBT: A.typical(0.07, 0.03),
           d.SEG_FD: A.typical(0.08, 0.01)}
    months = next(m for m in range(1, 241) if sum(v * (1 + typ[k]) ** (m / 12) for k, v in after.items()) >= 250000)
    assert rates["recovery_months_markets"] == months == rates["recovery_months_with_sips"] == rates["recovery_months"]


def _beta_port():
    """Two Indian stocks, an equity fund, a debt fund, a US stock and an FD."""
    pos = [{"id": 11, "asset_class": d.EQUITY, "segment": d.SEG_EQ_IN, "name": "High beta", "value": 100000, "is_open": True},
           {"id": 12, "asset_class": d.EQUITY, "segment": d.SEG_EQ_IN, "name": "Low beta", "value": 100000, "is_open": True},
           _mf(13, "Flexi cap", "Equity: Flexi Cap", 50000), _mf(14, "Short duration", "Debt: Short Duration", 40000, d.TAX_DEBT),
           {"id": 15, "asset_class": d.EQUITY, "segment": d.SEG_EQ_US, "market": "USA", "name": "Apple", "value": 30000, "is_open": True},
           _fd_pos(16, 80000, 7.5)]
    segs = [{"segment": d.SEG_EQ_IN, "value": 200000}, {"segment": d.SEG_MF, "value": 90000}, {"segment": d.SEG_EQ_US, "value": 30000},
            {"segment": d.SEG_FD, "value": 80000}]
    return {"totals": {"value": 400000}, "segments": segs, "positions": pos}


def test_stress_beta_deepens_or_softens_a_holdings_shock():
    """K11: β 1.5 deepens and β 0.5 softens an Indian-equity holding's shock (clamped to −0.95..+1); a US stock and a
    debt fund ignore β; segment rows are the sums of their holdings; the drill-down lists the largest |impact|."""
    port = _beta_port()
    plain = {s["key"]: s for s in forecast.stress_test(port)["scenarios"]}
    betas = {11: 1.5, 12: 0.5, 13: 1.2, 14: 3.0, 15: 2.0}
    st = forecast.stress_test(port, betas=betas)
    sc = {s["key"]: s for s in st["scenarios"]}
    gfc = sc["gfc"]
    hold = {h["instrument_id"]: h for h in gfc["holdings"]}
    assert hold[11]["shock_pct"] == -78.0 and hold[11]["impact"] == -78000 and hold[11]["beta"] == 1.5
    assert hold[12]["shock_pct"] == -26.0 and hold[12]["impact"] == -26000
    assert hold[13]["shock_pct"] == pytest.approx(-57.6) and hold[13]["impact"] == pytest.approx(-28800)
    assert hold[14]["shock_pct"] == -4.0 and hold[14]["beta"] is None        # debt funds keep G8 whatever β says
    assert hold[15]["shock_pct"] == -30.0 and hold[15]["beta"] is None       # β vs the Nifty means nothing for US stocks
    rows = {r["book_key"]: r for r in gfc["rows"]}
    assert rows[d.SEG_EQ_IN]["impact"] == -104000 and rows[d.SEG_EQ_IN]["shock_pct"] == -52.0   # 1.5 and 0.5 average out
    assert rows[d.SEG_MF]["impact"] == pytest.approx(-28800) and rows[A.MF_DEBT]["impact"] == -1600
    # a deeper shock on the equity fund than without β; the low-beta stock softer than the segment shock
    assert rows[d.SEG_MF]["impact"] < next(r for r in plain["gfc"]["rows"] if r["book_key"] == d.SEG_MF)["impact"]
    assert [abs(h["impact"]) for h in gfc["holdings"]] == sorted((abs(h["impact"]) for h in gfc["holdings"]), reverse=True)
    # clamped: β 3 on a 52% fall cannot lose more than 95%
    clamp = forecast.stress_test(port, betas={11: 3.0})
    h11 = next(h for h in next(s for s in clamp["scenarios"] if s["key"] == "gfc")["holdings"] if h["instrument_id"] == 11)
    assert h11["shock_pct"] == -95.0
    # the drill-down keeps the ten largest only
    many = {"totals": {"value": 120000}, "segments": [{"segment": d.SEG_EQ_IN, "value": 120000}],
            "positions": [{"id": i, "asset_class": d.EQUITY, "segment": d.SEG_EQ_IN, "name": f"S{i}", "value": 1000 * i,
                           "is_open": True} for i in range(1, 16)]}
    hs = next(s for s in forecast.stress_test(many)["scenarios"] if s["key"] == "covid")["holdings"]
    assert len(hs) == 10 and hs[0]["instrument_id"] == 15 and hs[-1]["instrument_id"] == 6


def test_stress_recovery_with_sips_is_never_slower_than_markets_alone():
    st = forecast.stress_test(_beta_port(), monthly_sip=20000)
    for s in st["scenarios"]:
        if s["impact"] < 0:
            assert s["recovery_months_markets"] is not None
            assert s["recovery_months_with_sips"] <= s["recovery_months_markets"]
            assert s["recovery_months"] == s["recovery_months_with_sips"]
        else:
            assert s["recovery_months_markets"] is None and s["recovery_months_with_sips"] is None
    gfc = next(s for s in st["scenarios"] if s["key"] == "gfc")
    assert gfc["recovery_months_with_sips"] < gfc["recovery_months_markets"]
    assert st["plan_impact"] is None and all(s["plan_impact"] is None for s in st["scenarios"])   # no plan → null


def test_stress_plan_impact_falls_under_a_falling_scenario():
    """K11: the shocked run (500 sims, seed 7, CRN with the baseline) never beats the baseline; the top-level
    copy is the worst scenario's; a rising scenario gets none."""
    today = date(2026, 11, 14)
    plan = {"retirement": {**RETIRE, "monthly_sip": 30000},
            "goals": [{"id": 5, "name": "House", "allocation": {d.SEG_EQ_IN: 50, d.SEG_MF: 100}, "target_amount": 600000,
                       "target_date": "2031-11-01", "monthly_contribution": 3000},
                      {"id": 6, "name": "Car", "allocation": '{"Fixed Deposits": 100}', "target_amount": 90000,
                       "target_date": "2028-06-01"}]}
    st = forecast.stress_test(_beta_port(), monthly_sip=30000, plan=plan, today=today)
    sc = {s["key"]: s for s in st["scenarios"]}
    for s in st["scenarios"]:
        pi = s["plan_impact"]
        if s["impact"] >= 0:
            assert pi is None
            continue
        assert pi["retirement_after"] <= pi["retirement_before"]
        assert [g["id"] for g in pi["goals"]] == [5, 6]
        for g in pi["goals"]:
            assert g["after"] <= g["before"]
    gfc = sc["gfc"]["plan_impact"]
    assert gfc["goals"][0]["after"] < gfc["goals"][0]["before"]      # the house money is in the falling classes
    assert gfc["goals"][1]["after"] == gfc["goals"][1]["before"]     # the car money is in an FD the shock spares
    assert st["plan_impact"] == sc[st["worst"]]["plan_impact"] and st["worst"] == "gfc"
    assert gfc["retirement_before"] == sc["covid"]["plan_impact"]["retirement_before"]   # one baseline for all


RETIRE = {"current_age": 35, "retire_age": 60, "life_expectancy": 85, "monthly_expenses": 50000, "monthly_sip": 20000, "return_pct": 10}


def test_retirement_plan_corpus_required_sip_and_fire():
    rp = forecast.retirement_plan(PORT, None, RETIRE)
    assert rp["years_to_retire"] == 25 and rp["retirement_years"] == 25
    assert rp["monthly_expenses_at_retirement"] == pytest.approx(50000 * 1.06 ** 25, rel=1e-6)
    # annuity-due: W₁ × ä_n at the real post-retirement rate, withdrawals at the start of each year
    w1 = 12 * 50000 * 1.06 ** 25
    real = 1.07 / 1.06 - 1
    assert rp["first_year_withdrawal"] == pytest.approx(w1, rel=1e-6)
    assert rp["corpus_needed"] == pytest.approx(w1 * (1 - (1 + real) ** -25) / real * (1 + real), rel=1e-6)
    assert rp["corpus_needed"] > rp["monthly_expenses_at_retirement"] * 12 * 15
    # the required SIP reaches the corpus in 75 of 100 futures, so above the SIP that reaches it on the mean path
    assert forecast._fv(160000, rp["required_sip"], 0.10, 300) > rp["corpus_needed"]
    assert rp["required_sip_typical"] < rp["required_sip"]
    assert forecast._fv(160000, rp["required_sip_typical"], 0.10, 300) > rp["corpus_needed"]  # mean > typical
    assert rp["fire"]["number"] == pytest.approx(50000 * 12 / 0.035)
    assert rp["path"][0]["age"] == 35 and rp["path"][-1]["age"] == 85 and rp["path"][25]["phase"] == "retired"
    assert rp["path"][24]["phase"] == "saving" and rp["sims"] == 1000
    # status follows the probability band, never the gap
    assert rp["status"] == A.status_for(rp["probability"])
    rich = forecast.retirement_plan({"totals": {"value": 5e7}, "segments": [{"segment": d.SEG_FD, "value": 5e7}]}, None,
                                    {"current_age": 50, "retire_age": 55, "monthly_expenses": 40000})
    assert rich["status"] == "on_track" and rich["probability"] >= 75
    assert rich["fire"]["coasting"] and rich["runs_out_at"] is None


def test_retirement_corpus_needed_drains_to_zero_at_life_expectancy():
    rp = forecast.retirement_plan(PORT, None, RETIRE)
    w1, n = rp["first_year_withdrawal"], rp["retirement_years"]
    balances = forecast._drawdown(rp["corpus_needed"], w1, 0.06, 0.07, n)
    assert len(balances) == n + 1 and abs(balances[-1]) < 1
    assert all(c > 0 for c in balances[:-1])
    # zero real return: ä_n = n
    assert forecast.annuity_due_factor(0.0, 20) == 20
    flat = forecast._drawdown(12 * 20 * 1000.0, 12000.0, 0.05, 0.05, 20)
    assert abs(flat[-1]) < 1


def test_retirement_path_is_monthly_and_meets_projected_at_retire_age():
    rp = forecast.retirement_plan(PORT, None, {**RETIRE, "step_up_pct": 10})
    at = next(r for r in rp["path"] if r["age"] == 60)
    assert at["corpus"] == pytest.approx(rp["projected"], rel=0.005)
    assert rp["projected"] == pytest.approx(forecast._fv(160000, 20000, 0.10, 300, 0.10), rel=1e-9)
    # drawdown rows follow C_{k+1} = (C_k − W_k)(1 + r)
    retired = [r for r in rp["path"] if r["phase"] == "retired"]
    for a, b in zip(retired, retired[1:]):
        if b["corpus"] > 0:
            assert b["corpus"] == pytest.approx((a["corpus"] - a["expenses"]) * 1.07, abs=1)
    assert retired[-1]["expenses"] == 0  # no withdrawal at life expectancy


def test_retirement_runs_out_at_first_negative_balance():
    lean = forecast.retirement_plan(PORT, None, {**RETIRE, "monthly_sip": 1000, "life_expectancy": 90})
    assert lean["runs_out_at"] is not None and 60 < lean["runs_out_at"] <= 90
    first_zero = next(r["age"] for r in lean["path"] if r["phase"] == "retired" and r["corpus"] == 0)
    assert lean["runs_out_at"] == first_zero
    assert lean["status"] == "off_track"


def test_retirement_status_comes_from_probability():
    """K10: status follows the lower of reaching the corpus and the money lasting, never the gap."""
    seen = set()
    for sip in (5000, 30000, 60000, 90000, 150000, 300000):
        rp = forecast.retirement_plan(PORT, None, {**RETIRE, "monthly_sip": sip})
        prob = min(rp["probability"], rp["probability_lasts"])
        assert rp["status"] == A.status_for(prob)
        assert (rp["status"] == "on_track") == (prob >= 75)
        assert (rp["status"] == "at_risk") == (40 <= prob < 75)
        assert (rp["status"] == "off_track") == (prob < 40)
        seen.add(rp["status"])
    assert seen == {"on_track", "at_risk", "off_track"}
    # projected meets the corpus at the mean, yet the typical future falls short: not "on track"
    req = forecast.retirement_plan(PORT, None, RETIRE)["required_sip_typical"]
    at_mean = forecast.retirement_plan(PORT, None, {**RETIRE, "monthly_sip": req + 1})
    assert at_mean["gap"] <= 0 and at_mean["probability"] < 75 and at_mean["status"] != "on_track"
    assert [A.status_for(p) for p in (74.9, 75, 39.9, 40)] == ["at_risk", "on_track", "off_track", "at_risk"]
    # only without a probability does the status fall back to the gap
    no_mc = forecast.retirement_plan(PORT, None, RETIRE, sims=0)
    assert no_mc["probability"] is None and no_mc["status"] == ("on_track" if no_mc["gap"] <= 0 else
                                                                "at_risk" if no_mc["projected"] >= 0.75 * no_mc["corpus_needed"]
                                                                else "off_track")


@pytest.mark.parametrize("step_up,sip", [(0, 20000), (10, 20000), (0, 0)])
def test_retirement_required_sip_is_exact_on_the_same_draws(step_up, sip):
    """K10 (replaces the D3 75 ± 8 cross-check): the accumulation is linear in the SIP on every path, so the
    required SIP is the exact 75th percentile of the per-path need. At it the engine's own probability is ≥ 75,
    at ₹100 less it is < 75; the typical SIP is the 50th percentile, so it lands on at least half the paths."""
    params = {**RETIRE, "step_up_pct": step_up, "monthly_sip": sip}
    rp = forecast.retirement_plan(PORT, None, params)
    req, typ = rp["required_sip"], rp["required_sip_typical"]
    assert req == math.ceil(req) and typ == math.ceil(typ) and req > typ > 0
    at = forecast.retirement_plan(PORT, None, {**params, "monthly_sip": req})
    below = forecast.retirement_plan(PORT, None, {**params, "monthly_sip": req - 100})
    assert at["probability"] >= 75 and below["probability"] < 75
    # the need does not depend on the SIP the plan already has (same draws, same routing)
    assert at["required_sip"] == req and below["required_sip"] == req
    assert forecast.retirement_plan(PORT, None, {**params, "monthly_sip": typ})["probability"] >= 50
    assert at["status"] == A.status_for(min(at["probability"], at["probability_lasts"]))


def _zero_growth(monkeypatch):
    """Every Book row at μ = 0, σ = 0 (the simulation is then deterministic)."""
    for k in list(A.ASSUMPTIONS):
        monkeypatch.setitem(A.ASSUMPTIONS, k, (0.0, 0.0))
    monkeypatch.setattr(A, "P2P_LOSS", 0.0)


def test_retirement_lasting_is_never_likelier_than_reaching_with_zero_growth(monkeypatch):
    """K10: with σ = 0 and μ = 0, money that reaches a corpus sized for 7% growth cannot last 25 years of
    inflating withdrawals, so probability_lasts ≤ probability, and status follows the lower one."""
    _zero_growth(monkeypatch)
    port = {"totals": {"value": 1e6}, "segments": [{"segment": d.SEG_EQ_IN, "value": 1e6}]}
    for sip in (0, 50000, 200000, 400000):
        rp = forecast.retirement_plan(port, None, {**RETIRE, "monthly_sip": sip, "return_pct": 0}, sims=200)
        assert rp["probability"] in (0.0, 100.0) and rp["probability_lasts"] in (0.0, 100.0)   # σ = 0: one path
        assert rp["probability_lasts"] <= rp["probability"]
        assert rp["status"] == A.status_for(min(rp["probability"], rp["probability_lasts"]))
    reached = forecast.retirement_plan(port, None, {**RETIRE, "monthly_sip": 400000, "return_pct": 0}, sims=200)
    assert reached["probability"] == 100 and reached["probability_lasts"] == 0 and reached["status"] == "off_track"


def test_retirement_far_above_the_need_lasts_and_a_tiny_corpus_runs_out():
    rich = forecast.retirement_plan({"totals": {"value": 5e8}, "segments": [{"segment": d.SEG_EQ_IN, "value": 5e8}]}, None,
                                    {"current_age": 50, "retire_age": 55, "monthly_expenses": 40000}, sims=400)
    assert rich["probability"] == 100 and rich["probability_lasts"] == 100 and rich["depletion_age_p10"] is None
    assert rich["status"] == "on_track"
    tiny = forecast.retirement_plan(PORT, None, {**RETIRE, "monthly_sip": 0}, sims=400)
    assert tiny["probability_lasts"] < 10 and tiny["depletion_age_p10"] is not None
    assert 60 <= tiny["depletion_age_p10"] < 85 and tiny["status"] == "off_track"
    # path bands: one row per age from today to life expectancy, ordered
    bands = tiny["path_bands"]
    assert [b["age"] for b in bands] == list(range(35, 86))
    assert all(b["p10"] <= b["p50"] <= b["p90"] for b in bands)
    assert bands[-1]["p50"] == 0                           # the typical future ran out before 85


def test_retirement_status_follows_the_minimum():
    """A plan that reaches its corpus but whose money does not last is not on track, whatever the probability.
    An optimistic 12% post-retirement return shrinks corpus_needed; the simulated retirement mix does not earn it."""
    rp = forecast.retirement_plan(PORT, None, {**RETIRE, "monthly_sip": 45000, "post_return_pct": 12}, sims=400)
    assert rp["probability"] >= 75 > rp["probability_lasts"]
    assert rp["status"] == "at_risk" == A.status_for(rp["probability_lasts"])
    assert rp["depletion_age_p10"] is not None and 60 < rp["depletion_age_p10"] < 85
    no_mc = forecast.retirement_plan(PORT, None, RETIRE, sims=0)
    assert no_mc["probability_lasts"] is None and no_mc["path_bands"] == [] and no_mc["engine"] is None


def test_retirement_epf_and_nps_are_product_facts_and_funding_ends_the_double_count():
    """K10: EPF and NPS join at retirement (40% of NPS buys a 6% annuity that offsets withdrawals); with funding
    the money used is EPF + NPS + the goal-free share of the rest, and `sources` says so."""
    pos = [{"id": 1, "asset_class": d.EQUITY, "segment": d.SEG_EQ_IN, "name": "ITC", "value": 600000, "cost": 400000, "is_open": True},
           {"id": 2, "asset_class": d.EPF, "segment": d.SEG_EPF, "name": "EPF", "value": 300000, "rate": 8.25, "is_open": True},
           {"id": 3, "asset_class": d.NPS, "segment": d.SEG_NPS, "name": "NPS", "value": 100000, "cost": 80000, "is_open": True}]
    segs = [{"segment": d.SEG_EQ_IN, "value": 600000}, {"segment": d.SEG_EPF, "value": 300000}, {"segment": d.SEG_NPS, "value": 100000}]
    port = {"totals": {"value": 1e6}, "segments": segs, "positions": pos}
    whole = forecast.retirement_plan(port, None, RETIRE, sims=400)
    assert whole["sources"] is None and whole["current"] == 1e6
    assert whole["annuity"]["share"] == 0.4 and whole["annuity"]["rate"] == 0.06 and whole["annuity"]["income_p50"] > 0
    # goals earmark 400k of the equity: free = 1e6 − 400k = 600k, of which EPF + NPS are 400k
    funding = {"total": 1e6, "free": 600000, "cushion": {"amount": 0}, "earmarked": [{"amount": 400000}]}
    funded = forecast.retirement_plan(port, None, RETIRE, sims=400, funding=funding)
    assert funded["sources"] == {"epf": 300000, "nps": 100000, "free": 200000, "excluded": 400000}
    assert funded["current"] == 600000 and funded["projected"] < whole["projected"]
    assert funded["probability"] <= whole["probability"] and funded["required_sip"] >= whole["required_sip"]
    # the deterministic outputs are the P0 ones, on the money used
    assert funded["corpus_needed"] == whole["corpus_needed"]
    assert funded["projected"] == pytest.approx(forecast._fv(600000, 20000, 0.10, 300), rel=1e-9)


def test_retirement_with_funding_leaves_out_plans_linked_to_a_goal():
    """Final pass: a plan linked to a goal funds that goal (K15), like the goal's earmarked money, so with `funding`
    retirement neither counts it nor lets /plan's gap subtract the same rupees twice. Without funding (the whole
    portfolio is used) every plan counts, as before."""
    segs = [{"segment": d.SEG_EQ_IN, "value": 1e6}]
    pos = [{"id": 1, "asset_class": d.EQUITY, "segment": d.SEG_EQ_IN, "name": "ITC", "value": 1e6, "cost": 8e5, "is_open": True}]
    port = {"totals": {"value": 1e6}, "segments": segs, "positions": pos}
    sips = [{"id": 1, "name": "Index", "segment": d.SEG_EQ_IN, "amount": 10000, "frequency": "monthly", "day_of_month": 5,
             "active": 1, "goal_id": None},
            {"id": 2, "name": "House", "segment": d.SEG_EQ_IN, "amount": 15000, "frequency": "monthly", "day_of_month": 5,
             "active": 1, "goal_id": 7}]
    params = {k: v for k, v in RETIRE.items() if k != "monthly_sip"}
    funding = {"total": 1e6, "free": 1e6, "cushion": {"amount": 0}, "earmarked": []}
    funded = forecast.retirement_plan(port, None, params, sims=200, funding=funding, sips=sips)
    assert funded["inputs"]["monthly_sip"] == 10000
    whole = forecast.retirement_plan(port, None, params, sims=200, sips=sips)
    assert whole["inputs"]["monthly_sip"] == 25000


def test_retirement_already_funded_needs_no_sip():
    rich = forecast.retirement_plan({"totals": {"value": 5e8}, "segments": [{"segment": d.SEG_FD, "value": 5e8}]}, None,
                                    {"current_age": 50, "retire_age": 55, "monthly_expenses": 40000})
    assert rich["required_sip"] == 0 and rich["required_sip_typical"] == 0 and rich["status"] == "on_track"


def test_retirement_age_must_be_after_current_age():
    for ret in (35, 30):
        with pytest.raises(ValueError, match="Retirement age must be after your current age"):
            forecast.retirement_plan(PORT, None, {**RETIRE, "retire_age": ret})


def test_cash_flow_forecast_from_ledger_patterns():
    today = date(2026, 6, 15)
    inst = [
        {"id": 1, "owner": "a", "asset_class": d.EQUITY, "name": "ITC", "currency": "INR", "status": "active", "last_price": 400.0,
         "tax_class": d.TAX_EQUITY, "market": "India"},
        {"id": 2, "owner": "a", "asset_class": d.FIXED_DEPOSIT, "name": "SBI FD", "currency": "INR", "status": "active", "rate": 7.0,
         "maturity_date": "2026-09-10", "tax_class": d.TAX_INCOME},
        {"id": 3, "owner": "a", "asset_class": d.P2P, "name": "Loan 1", "currency": "INR", "status": "active", "rate": 12.0,
         "tenure_months": 12, "maturity_date": "2026-12-01", "tax_class": d.TAX_INCOME},
        {"id": 4, "owner": "a", "asset_class": d.EPF, "name": "EPF", "currency": "INR", "status": "active", "rate": 8.25, "tax_class": d.TAX_EXEMPT},
    ]
    T = lambda i, iid, dt, typ, qty=None, amt=0.0, principal=None: {"id": i, "instrument_id": iid, "date": dt, "type": typ, "quantity": qty,
                                                                  "amount": amt, "amount_fc": None, "principal": principal, "fees": None, "owner": "a"}
    txns = [T(1, 1, "2025-01-10", d.BUY, 100, 40000), T(2, 1, "2025-08-20", d.DIVIDEND, None, 700), T(3, 1, "2026-02-18", d.DIVIDEND, None, 650),
            T(4, 2, "2025-09-10", d.BUY, None, 100000),
            T(5, 3, "2025-12-01", d.BUY, None, 12000), T(6, 3, "2026-01-05", d.REPAYMENT, None, 1066, 946),
            T(7, 4, "2026-04-30", d.BUY, None, 5000), T(8, 4, "2026-05-31", d.BUY, None, 5000)]
    port = compute_portfolio(inst, txns, None, today=today)
    sips = [{"id": 1, "name": "Nifty index", "amount": 10000, "frequency": "monthly", "day_of_month": 5, "active": 1,
             "start_date": "2026-01-05", "end_date": None, "step_up_pct": 10}]
    cf = forecast.cash_flow_forecast(port["positions"], inst, txns, sips, months=12, today=today)
    rows = {r["month"]: r for r in cf["months"]}
    assert rows["2026-08"]["dividends"] == 700 and rows["2027-02"]["dividends"] == 650       # last year's pattern
    assert rows["2026-09"]["principal_back"] >= 100000 and rows["2026-09"]["interest"] > 0  # FD maturity
    assert any(e["kind"] == "fd_maturity" for e in cf["events"])
    p2p_principal = sum(r["principal_back"] for r in cf["months"]) - 100000                  # everything but the FD principal
    # the loan amortises to zero with its last EMI on 1 December (July … December, June's is already paid),
    # each month's repayment discounted for expected defaults
    out, rate, n = 12000 - 946, 0.01, 6
    emi, bal, expected = out * rate / (1 - (1 + rate) ** -n), out, 0.0
    for k in range(n):
        principal = emi - bal * rate
        bal -= principal
        expected += principal * (1 - forecast.P2P_LOSS / 12) ** (k + 1)
    assert p2p_principal == pytest.approx(expected, abs=1) and p2p_principal < out
    assert rows["2026-06"]["principal_back"] == 0 and rows["2026-12"]["principal_back"] > 0 and rows["2027-01"]["principal_back"] == 0
    assert next(e for e in cf["events"] if e["kind"] == "p2p_close")["date"] == "2026-12-01"
    assert rows["2027-03"]["epf_interest"] > 0 and rows["2026-07"]["contributions"] == 5000
    assert rows["2026-07"]["sip_out"] == 10000 and rows["2027-01"]["sip_out"] == pytest.approx(11000)  # step-up after a year
    assert cf["totals"]["inflow"] > cf["totals"]["dividends"]
    assert cf["months"][0]["month"] == "2026-06" and len(cf["months"]) == 12  # from tomorrow's month
    assert cf["monthly_sip_total"] == 10000
    assert all(e["date"] > today.isoformat() for e in cf["events"] if e["kind"] != "p2p_overdue")


CF_TODAY = date(2026, 6, 15)


def _txn(i, iid, dt, typ, qty=None, amt=0.0, principal=None):
    return {"id": i, "instrument_id": iid, "date": dt, "type": typ, "quantity": qty, "amount": amt, "amount_fc": None,
            "principal": principal, "fees": None, "owner": "a"}


def _cash_flow(inst, txns, sips=(), months=12):
    port = compute_portfolio(inst, txns, None, today=CF_TODAY)
    cf = forecast.cash_flow_forecast(port["positions"], inst, txns, list(sips), months=months, today=CF_TODAY)
    return cf, {r["month"]: r for r in cf["months"]}


def _stock(iid=1, name="ITC"):
    return {"id": iid, "owner": "a", "asset_class": d.EQUITY, "name": name, "currency": "INR", "status": "active", "last_price": 400.0,
            "tax_class": d.TAX_EQUITY, "market": "India"}


def _payout_fd(iid, maturity):
    return {"id": iid, "owner": "a", "asset_class": d.FIXED_DEPOSIT, "name": f"FD {iid}", "currency": "INR", "status": "active",
            "rate": 7.0, "maturity_date": maturity, "tax_class": d.TAX_INCOME}


def test_cash_flow_fd_interest_stops_at_maturity():
    # a quarterly-payout FD maturing in January 2027: last year's payouts repeat only until then
    inst = [_payout_fd(2, "2027-01-10")]
    txns = [_txn(1, 2, "2024-01-10", d.BUY, None, 100000)] + [
        _txn(10 + k, 2, dt, d.INTEREST, None, 1750) for k, dt in enumerate(("2025-07-10", "2025-10-10", "2026-01-10", "2026-04-10"))]
    cf, rows = _cash_flow(inst, txns)
    assert rows["2026-07"]["interest"] == 1750 and rows["2026-10"]["interest"] == 1750
    assert all(rows[m]["interest"] == 0 for m in ("2027-02", "2027-03", "2027-04", "2027-05"))
    assert rows["2027-01"]["principal_back"] == 100000
    # at maturity only the days since the last (projected) payout: 92 days at 7%, not another full quarter on top
    assert rows["2027-01"]["interest"] == pytest.approx(100000 * 0.07 * 92 / 365, abs=0.01)


def test_cash_flow_payout_fd_maturity_interest_is_pro_rata():
    inst = [_payout_fd(2, "2026-09-10")]
    txns = [_txn(1, 2, "2025-09-10", d.BUY, None, 100000)] + [
        _txn(10 + k, 2, dt, d.INTEREST, None, 1750) for k, dt in enumerate(("2025-12-10", "2026-03-10", "2026-06-10"))]
    cf, rows = _cash_flow(inst, txns)
    assert rows["2026-09"]["interest"] == pytest.approx(1750, abs=25)  # ≈ ₹1.75k: 92 days since the June payout
    assert rows["2026-09"]["principal_back"] == 100000
    assert sum(r["interest"] for r in cf["months"]) == rows["2026-09"]["interest"]  # nothing projected past maturity
    fd = next(e for e in cf["events"] if e["kind"] == "fd_maturity")
    assert fd["amount"] == pytest.approx(100000 + rows["2026-09"]["interest"], abs=0.01)


def test_cash_flow_dividend_received_this_month_is_not_projected():
    base = [_txn(1, 1, "2025-01-10", d.BUY, 100, 40000), _txn(2, 1, "2025-06-20", d.DIVIDEND, None, 1000)]
    _, rows = _cash_flow([_stock()], base)
    assert rows["2026-06"]["dividends"] == 1000  # last June's dividend repeats on the 20th, after today
    _, rows = _cash_flow([_stock()], base + [_txn(3, 1, "2026-06-05", d.DIVIDEND, None, 800)])
    assert rows["2026-06"]["dividends"] == 0  # this year's has already arrived
    assert all(r["dividends"] == 0 for r in rows.values())


def test_cash_flow_dividend_scales_with_units_held_now():
    txns = [_txn(1, 1, "2025-01-10", d.BUY, 100, 40000), _txn(2, 1, "2025-08-20", d.DIVIDEND, None, 700),
            _txn(3, 1, "2026-03-01", d.SELL, 90, 38000)]
    _, rows = _cash_flow([_stock()], txns)
    assert rows["2026-08"]["dividends"] == pytest.approx(70)  # 7 a share × the 10 shares left
    # a later 1:2 split doubles the units but not the payout
    split = [_txn(1, 1, "2025-01-10", d.BUY, 100, 40000), _txn(2, 1, "2025-08-20", d.DIVIDEND, None, 700),
             _txn(3, 1, "2026-01-05", d.SPLIT, 2)]
    _, rows = _cash_flow([_stock()], split)
    assert rows["2026-08"]["dividends"] == pytest.approx(700)
    # a fully sold holding projects nothing
    gone = txns[:2] + [_txn(3, 1, "2026-03-01", d.SELL, 100, 42000)]
    _, rows = _cash_flow([_stock()], gone)
    assert all(r["dividends"] == 0 for r in rows.values())


def test_cash_flow_p2p_without_maturity_amortises_from_first_date():
    inst = [{"id": 3, "owner": "a", "asset_class": d.P2P, "name": "Loan", "currency": "INR", "status": "active", "rate": 12.0,
             "tenure_months": 6, "maturity_date": None, "tax_class": d.TAX_INCOME}]
    txns = [_txn(1, 3, "2026-02-05", d.BUY, None, 12000)]
    cf, rows = _cash_flow(inst, txns)
    # disbursed 5 February for six months: EMIs on the 5th end in August, not six months from today
    assert rows["2026-06"]["principal_back"] == 0  # 5 June is already past
    assert rows["2026-07"]["principal_back"] > 0 and rows["2026-08"]["principal_back"] > 0
    assert all(rows[m]["principal_back"] == 0 for m in ("2026-09", "2026-10", "2026-12"))
    close = next(e for e in cf["events"] if e["kind"] == "p2p_close")
    assert close["date"] == "2026-08-05"
    assert sum(r["principal_back"] for r in cf["months"]) < 12000


def test_cash_flow_epf_plan_is_not_double_counted():
    epf = {"id": 4, "owner": "a", "asset_class": d.EPF, "name": "EPF", "currency": "INR", "status": "active", "rate": 8.25,
           "tax_class": d.TAX_EXEMPT}
    plan = {"id": 7, "name": "EPF payroll", "instrument_id": 4, "segment": d.SEG_EPF, "amount": 5000, "frequency": "monthly",
            "day_of_month": 1, "active": 1, "start_date": "2025-01-01", "end_date": None, "step_up_pct": 0}
    recent = [_txn(1, 4, "2026-04-30", d.BUY, None, 5000), _txn(2, 4, "2026-05-31", d.BUY, None, 5000)]
    cf, rows = _cash_flow([epf], recent, [plan])
    assert rows["2026-07"]["contributions"] == 5000 and rows["2026-07"]["sip_out"] == 0
    assert any("EPF" in n for n in cf["notes"])
    # with no recent payroll rows the plan is the estimate, shown as money into EPF
    cf, rows = _cash_flow([epf], [_txn(1, 4, "2025-01-31", d.BUY, None, 5000)], [plan])
    assert rows["2026-07"]["contributions"] == 5000 and cf["totals"]["sip_out"] == 0


def test_cash_flow_epf_averages_per_calendar_month():
    """H16: employee and employer rows of one month count as one month's contribution, not two."""
    epf = {"id": 4, "owner": "a", "asset_class": d.EPF, "name": "EPF", "currency": "INR", "status": "active", "rate": 8.25,
           "tax_class": d.TAX_EXEMPT}
    # two rows a month (employee + employer); January falls outside the 120 days, February is the oldest of four
    rows_in = [("2026-01-31", 9000), ("2026-01-31", 9000),
               ("2026-02-27", 1000), ("2026-02-27", 1000),
               ("2026-03-31", 4000), ("2026-03-31", 2000),
               ("2026-04-30", 3000), ("2026-04-30", 1500),
               ("2026-05-29", 3000), ("2026-05-29", 1500)]
    txns = [_txn(i + 1, 4, dt, d.BUY, None, amt) for i, (dt, amt) in enumerate(rows_in)]
    cf, rows = _cash_flow([epf], txns)
    monthly = (6000 + 4500 + 4500) / 3                       # the last three months with a contribution
    assert rows["2026-07"]["contributions"] == pytest.approx(monthly)
    assert rows["2026-06"]["contributions"] == pytest.approx(monthly)   # nothing paid in June yet
    # one month only: its two rows are that month's contribution
    cf, rows = _cash_flow([epf], [_txn(1, 4, "2026-05-29", d.BUY, None, 3000), _txn(2, 4, "2026-05-29", d.BUY, None, 1500)])
    assert rows["2026-07"]["contributions"] == pytest.approx(4500)
    # rule 1 unchanged: June's rows are already paid, so June is not projected again but counts in the average
    june = txns + [_txn(20, 4, "2026-06-10", d.BUY, None, 3000), _txn(21, 4, "2026-06-10", d.BUY, None, 3000)]
    cf, rows = _cash_flow([epf], june)
    assert rows["2026-06"]["contributions"] == 0
    assert rows["2026-07"]["contributions"] == pytest.approx((4500 + 4500 + 6000) / 3)
    # a future-dated row is not a contribution made in the last 120 days
    cf, rows = _cash_flow([epf], txns + [_txn(30, 4, "2026-08-01", d.BUY, None, 90000)])
    assert rows["2026-07"]["contributions"] == pytest.approx(monthly)


def test_cash_flow_and_the_plan_engine_share_one_epf_average():
    """H16/K8: one helper gives the EPF monthly contribution to both the cash-flow page and simulate's EPF ladder."""
    assert forecast.epf_monthly_average is S.epf_monthly_average
    epf = {"id": 4, "owner": "a", "asset_class": d.EPF, "name": "EPF", "currency": "INR", "status": "active", "rate": 8.25,
           "tax_class": d.TAX_EXEMPT}
    txns = [_txn(1, 4, "2026-03-31", d.BUY, None, 4000), _txn(2, 4, "2026-03-31", d.BUY, None, 2000),
            _txn(3, 4, "2026-04-30", d.BUY, None, 3000), _txn(4, 4, "2026-05-29", d.BUY, None, 4500)]
    cf, rows = _cash_flow([epf], txns)
    port = compute_portfolio([epf], txns, None, today=CF_TODAY)
    state = S.build_state(port["positions"], book=A.rated_book(port["positions"]), today=CF_TODAY, txns=txns, instruments=[epf])
    assert state["epf"]["monthly"] == pytest.approx(rows["2026-07"]["contributions"]) == pytest.approx((6000 + 3000 + 4500) / 3)
    assert state["epf"]["from_ledger"] is True


def test_future_start_plan_is_excluded_from_monthly_sip_total():
    sips = [{"id": 1, "amount": 5000, "frequency": "monthly", "active": 1, "start_date": "2026-01-01", "end_date": None},
            {"id": 2, "amount": 3000, "frequency": "monthly", "active": 1, "start_date": "2026-07-01", "end_date": None},
            {"id": 3, "amount": 2000, "frequency": "monthly", "active": 1, "start_date": "2025-01-01", "end_date": "2026-05-01"},
            {"id": 4, "amount": 3000, "frequency": "quarterly", "active": 1, "start_date": None, "end_date": None},
            {"id": 5, "amount": 9000, "frequency": "monthly", "active": 0, "start_date": None, "end_date": None}]
    assert forecast.monthly_sip_total(sips, CF_TODAY) == 6000
    assert forecast.monthly_sip_total(sips, date(2026, 7, 1)) == 9000  # it counts from its start date
    cf, rows = _cash_flow([_stock()], [_txn(1, 1, "2025-01-10", d.BUY, 100, 40000)], sips)
    assert cf["monthly_sip_total"] == 6000
    # instalments on their due dates (rule 6): every plan falls on the 1st, so June's are already past
    assert rows["2026-06"]["sip_out"] == 0
    # July: plan 1, plan 2 from its start and the quarterly plan (no anchor: January, April, July, October)
    assert rows["2026-07"]["sip_out"] == pytest.approx(5000 + 3000 + 3000)
    assert rows["2026-08"]["sip_out"] == pytest.approx(8000) and rows["2026-10"]["sip_out"] == pytest.approx(11000)


def _plan(pid, freq, amount, start, day=10, step=0, **kw):
    return {"id": pid, "name": f"Plan {pid}", "instrument_id": 1, "amount": amount, "frequency": freq, "day_of_month": day,
            "active": 1, "start_date": start, "end_date": None, "step_up_pct": step, **kw}


def test_cash_flow_quarterly_and_yearly_sips_land_on_their_months():
    quarterly = _plan(1, "quarterly", 3000, "2026-02-10")
    cf, rows = _cash_flow([_stock()], [_txn(1, 1, "2025-01-10", d.BUY, 100, 40000)], [quarterly])
    landed = {m: r["sip_out"] for m, r in rows.items() if r["sip_out"]}
    assert landed == {"2026-08": 3000, "2026-11": 3000, "2027-02": 3000, "2027-05": 3000}
    # a yearly plan lands once, in its anchor's month, with the step-up after its first whole year
    yearly = _plan(2, "yearly", 12000, "2025-09-20", day=20, step=10)
    _, rows = _cash_flow([_stock()], [_txn(1, 1, "2025-01-10", d.BUY, 100, 40000)], [yearly])
    landed = {m: r["sip_out"] for m, r in rows.items() if r["sip_out"]}
    assert landed == {"2026-09": pytest.approx(13200)}
    # each instalment is the plan's planned amount on its due date
    first, last = CF_TODAY + timedelta(days=1), date(2027, 5, 31)
    dues = plans.due_dates(quarterly, first, last)
    assert cf["totals"]["sip_out"] == pytest.approx(sum(plans.planned_amount(quarterly, x) for x in dues))


def test_cash_flow_weekly_sip_pays_four_or_five_times_a_month():
    weekly = _plan(3, "weekly", 1000, "2026-06-01")   # a Monday
    cf, rows = _cash_flow([_stock()], [_txn(1, 1, "2025-01-10", d.BUY, 100, 40000)], [weekly])
    assert rows["2026-06"]["sip_out"] == 2000          # 22 and 29 June: the 1st, 8th and 15th are past
    for m, r in rows.items():
        if m != "2026-06":
            assert r["sip_out"] / 1000 in (4, 5), m
    assert cf["totals"]["sip_out"] == 1000 * len(plans.due_dates(weekly, CF_TODAY + timedelta(days=1), date(2027, 5, 31)))
    # monthly_sip_total keeps the monthly equivalent (52/12 instalments)
    assert cf["monthly_sip_total"] == pytest.approx(1000 * 52 / 12, abs=0.01)


def test_every_forward_payload_carries_the_assumption_block():
    """G5: projection, retirement, cash flow and stress carry {assumptions{…, hash}, honesty, note}; the hash is the
    rated Book of the positions, so it moves with an FD's rate."""
    def payloads(rate):
        inst = [_payout_fd(2, "2027-06-10") | {"rate": rate}, _stock()]
        txns = [_txn(1, 2, "2026-01-10", d.BUY, None, 100000), _txn(2, 1, "2025-01-10", d.BUY, 100, 40000)]
        port = compute_portfolio(inst, txns, None, today=CF_TODAY)
        return port, {
            "projection": forecast.project_portfolio(port, None, years=5, sims=200, today=CF_TODAY),
            "retirement": forecast.retirement_plan(port, None, RETIRE, today=CF_TODAY, sims=200),
            "cashflow": forecast.cash_flow_forecast(port["positions"], inst, txns, [], months=6, today=CF_TODAY),
            "stress": forecast.stress_test(port, 0),
        }

    port, seven = payloads(7.0)
    book = A.rated_book(port["positions"])
    assert book["segments"][d.SEG_FD]["return_pct"] == 7.0 and book["segments"][d.SEG_FD]["source"] == "holding rates"
    for name, p in seven.items():
        block = p["assumptions"]
        assert {"return_pct", "typical_pct", "volatility_pct", "inflation_pct", "basis", "hash"} <= set(block), name
        assert block["hash"] == A.book_hash(book), name
        assert block["typical_pct"] < block["return_pct"] and block["basis"], name
        assert p["honesty"]["estimate"] == "est." and p["honesty"]["disclaimer"] and p["note"], name
    assert seven["projection"]["honesty"]["p50"] == A.HONESTY["p50"].format(sims="200")
    assert seven["retirement"]["honesty"]["probability"] == A.HONESTY["probability"]
    assert "3% a year expected loss" in seven["cashflow"]["assumptions"]["basis"]
    # existing keys stay
    assert {"own", "mix"} <= set(seven["projection"]["assumptions"])
    assert {"return_pct", "volatility_pct", "return_basis"} <= set(seven["retirement"]["inputs"])
    _, eight = payloads(8.0)
    for name in seven:
        assert eight[name]["assumptions"]["hash"] != seven[name]["assumptions"]["hash"], name


def test_missed_sip_insight():
    today = date(2026, 6, 20)
    inst = [{"id": 1, "owner": "a", "asset_class": d.MUTUAL_FUND, "name": "Index fund", "currency": "INR", "status": "active", "last_price": 100.0,
             "tax_class": d.TAX_EQUITY, "category": "Equity"}]
    txns = [{"id": 1, "instrument_id": 1, "date": "2026-05-05", "type": d.BUY, "quantity": 10, "amount": 1000, "amount_fc": None,
             "principal": None, "fees": None, "owner": "a"}]
    port = compute_portfolio(inst, txns, None, today=today)
    sips = [{"id": 9, "name": "Index fund", "instrument_id": 1, "amount": 1000, "frequency": "monthly", "day_of_month": 5, "active": 1}]
    ids = [i["id"] for i in build_insights(port, None, [], {}, today=today, sips=sips, txns=txns)]
    assert "sip:missed:9" in ids
    txns.append({**txns[0], "id": 2, "date": "2026-06-06"})
    ids = [i["id"] for i in build_insights(port, None, [], {}, today=today, sips=sips, txns=txns)]
    assert "sip:missed:9" not in ids


# The optimizer test that lived here moved to test_optimizer.py with the K14 expectations (AMENDMENTS K1, A2).


# ── API ──

@pytest.fixture
def offline_prices(monkeypatch):
    hist = {"TCS.NS": walk(3000, 800, seed=5), "INFY.NS": walk(1500, 800, seed=6), "^NSEI": walk(24000, 800, vol=0.009, seed=7),
            "USDINR=X": walk(84, 800, drift=0.0, vol=0.003, seed=8), "^CRSLDX": walk(22000, 800, vol=0.009, seed=9),
            "^GSPC": walk(5000, 800, vol=0.01, seed=10), "GOLDBEES.NS": walk(60, 800, vol=0.008, seed=11)}
    monkeypatch.setattr(px, "ensure_history", lambda db, syms, start, max_age_hours=12: {s: hist.get(s, []) for s in syms})
    monkeypatch.setattr(px, "fetch_quotes", lambda syms, timeout=15: {s: None for s in syms})
    return hist


def test_forecast_endpoints_round_trip(client, offline_prices):
    h = auth(USER, "user")
    r = client.post("/api/transactions", headers=h, json={"type": "BUY", "date": "2025-01-05", "quantity": 10, "amount": 35000,
                                                          "instrument": {"asset_class": "equity", "name": "TCS", "symbol": "TCS.NS", "market": "India", "sector": "IT"}})
    assert r.status_code == 201
    iid = r.json["instrument_id"]
    client.post("/api/transactions", headers=h, json={"type": "BUY", "date": "2025-03-05", "quantity": 20, "amount": 30000,
                                                      "instrument": {"asset_class": "equity", "name": "Infosys", "symbol": "INFY.NS", "market": "India", "sector": "IT"}})
    client.post("/api/fixed-deposits", headers=h, json={"name": "HDFC FD", "amount": 50000, "rate": 7.1, "date": "2025-06-01", "maturity_date": "2027-06-01"})

    # SIP plans: create, list, validation, a missed-instalment insight, update and delete
    bad = client.post("/api/sips", headers=h, json={"name": "x", "amount": -5})
    assert bad.status_code == 400
    s = client.post("/api/sips", headers=h, json={"instrument_id": iid, "amount": 5000, "day_of_month": 1, "step_up_pct": 10})
    assert s.status_code == 201 and s.json["name"] == "TCS" and s.json["segment"] == d.SEG_EQ_IN
    lst = client.get("/api/sips", headers=h).json
    assert lst["monthly_total"] == 5000 and len(lst["plans"]) == 1
    assert client.post("/api/sips", headers=auth(GUEST, "guest"), json={"name": "x", "amount": 1}).status_code == 403
    if date.today().day >= 5:
        assert any(i["id"] == f"sip:missed:{s.json['id']}" for i in client.get("/api/insights?performance=0", headers=h).json["insights"])

    f = client.get("/api/forecast?years=5&step=10", headers=h).json
    assert f["monthly_sip"] == 5000 and f["sip_plans_total"] == 5000 and len(f["path"]) == 6
    assert f["path"][-1]["p10"] < f["path"][-1]["p90"] and f["assumptions"]["return_pct"] > 0
    f2 = client.get("/api/forecast?years=5&sip=0", headers=h).json
    assert f2["end"]["contributed"] == f2["current"]
    assert client.get("/api/forecast?years=99", headers=h).status_code == 400
    assert f["sims"] == 1000 and f["scenarios"]["base"] == f["end"]["p50"] and f["honesty"]["p10"] == "1-in-10 bad case"
    for bad_sims in (100, 5000):
        assert client.get(f"/api/forecast?years=5&sims={bad_sims}", headers=h).status_code == 400
    assert client.get("/api/forecast?years=5&sims=2000", headers=h).json["sims"] == 2000
    guest = client.get("/api/forecast?years=5&sims=2000", headers=auth(GUEST, "guest"))
    assert guest.status_code == 200 and guest.json["sims"] == 500  # guests are capped, silently
    rounded = client.get("/api/forecast?years=5&sip=5049&return=11.3", headers=h).json
    assert rounded["monthly_sip"] == 5000 and rounded["assumptions"]["return_pct"] == 11.5

    st =client.get("/api/forecast/stress", headers=h).json
    assert st["scenarios"] and st["market_exposed_pct"] > 0

    rp = client.get("/api/forecast/retirement?current_age=40&retire_age=60&monthly_expenses=60000", headers=h).json
    assert rp["inputs"]["monthly_sip"] == 5000 and rp["corpus_needed"] > 0 and rp["path"]
    assert client.put("/api/settings/retirementPlan", headers=h, json={"value": {"current_age": 40, "retire_age": 58, "monthly_expenses": 60000}}).status_code == 200
    assert client.get("/api/forecast/retirement", headers=h).json["inputs"]["retire_age"] == 58
    bad_age = client.get("/api/forecast/retirement?current_age=60&retire_age=60", headers=h)
    assert bad_age.status_code == 400 and bad_age.json["error"] == "Retirement age must be after your current age"
    # the saved plan retires at 58: a current age past it fails after the merge too
    assert client.get("/api/forecast/retirement?current_age=59", headers=h).status_code == 400
    assert client.put("/api/settings/riskProfile", headers=h, json={"value": "bold"}).status_code == 400

    cf = client.get("/api/forecast/cashflow?months=6", headers=h).json
    # instalments on their due dates (rule 6): the 1st of each month from tomorrow to the end of the sixth month
    plan = client.get("/api/sips", headers=h).json["plans"][0]
    first = date.today() + timedelta(days=1)
    y, m = divmod(first.year * 12 + first.month - 1 + 6, 12)
    dues = plans.due_dates(plan, first, date(y, m + 1, 1) - timedelta(days=1))
    assert len(cf["months"]) == 6 and len(dues) in (5, 6)
    assert cf["totals"]["sip_out"] == pytest.approx(sum(plans.planned_amount(plan, x) for x in dues), abs=0.05)
    assert cf["assumptions"]["hash"] and cf["honesty"]["estimate"] == "est."

    rk = client.get("/api/risk", headers=h).json
    assert rk["holdings"] and rk["var_95"]["day"] > 0 and rk["benchmark"] == "Nifty 50"

    o = client.get(f"/api/instruments/{iid}/outlook", headers=h).json
    assert o["available"] and o["holding"]["quantity"] == 10 and o["cone"]["1Y"]["p50"] > 0
    fd_id = next(p["id"] for p in client.get("/api/portfolio", headers=h).json["positions"] if p["asset_class"] == "fixed_deposit")
    assert client.get(f"/api/instruments/{fd_id}/outlook", headers=h).json["available"] is False

    op = client.get("/api/optimizer?profile=growth", headers=h).json
    assert op["profile"] == "growth" and op["rows"] and op["frontier"]
    assert client.get("/api/optimizer?profile=yolo", headers=h).status_code == 400

    assert client.put(f"/api/sips/{s.json['id']}", headers=h, json={"active": False}).json["active"] == 0
    assert client.get("/api/sips", headers=h).json["monthly_total"] == 0
    assert client.delete(f"/api/sips/{s.json['id']}", headers=h).status_code == 200
    assert client.get("/api/sips", headers=h).json["plans"] == []


# ── the base Book in stress and cash flow (AMENDMENTS R4) ──

def test_stress_and_cash_flow_read_the_base_book():
    port = _book_port()
    plain = forecast.stress_test(port, 10000)
    assert forecast.stress_test(port, 10000, book=A.effective_book(None)) == plain
    b = A.effective_book(None)
    hot = {**b, "inflation_pct": 8.0,
           "segments": {**b["segments"], d.SEG_EQ_IN: {**b["segments"][d.SEG_EQ_IN], "return_pct": 18.0}}}
    st = forecast.stress_test(port, 10000, book=hot)
    covid = lambda s: next(x for x in s["scenarios"] if x["key"] == "covid")
    assert covid(st)["impact"] == covid(plain)["impact"]                          # shocks don't read the Book
    assert covid(st)["recovery_months_markets"] < covid(plain)["recovery_months_markets"]
    assert st["assumptions"]["inflation_pct"] == 8.0 and st["assumptions"]["hash"] != plain["assumptions"]["hash"]
    cf = forecast.cash_flow_forecast(port["positions"], [], [], [], 3, date(2026, 6, 15))
    assert forecast.cash_flow_forecast(port["positions"], [], [], [], 3, date(2026, 6, 15),
                                       book=A.effective_book(None)) == cf
    cf_hot = forecast.cash_flow_forecast(port["positions"], [], [], [], 3, date(2026, 6, 15), book=hot)
    assert cf_hot["assumptions"]["inflation_pct"] == 8.0 and cf_hot["months"] == cf["months"]
    assert forecast.blended_assumptions(port["segments"], None, positions=port["positions"], book=hot)["mu"] >         forecast.blended_assumptions(port["segments"], None, positions=port["positions"])["mu"]
