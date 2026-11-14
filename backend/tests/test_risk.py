"""Risk engine v2 (SPEC §6.2, §6.7): holding_stats shrinkage and portfolio_risk with ballast, proxies
and renormalised weights; quant on the Assumption Book (AMENDMENTS G3, G9): the cone at the Book μ,
the model block equal to mu_sigma and the optimizer, the P2P ballast cap. Offline: every price series
is a seeded random walk."""
import ast
import math
import random
from datetime import date, timedelta
from pathlib import Path

import pytest

from tracker import domain as d
from tracker.analytics import assumptions as A
from tracker.analytics import optimizer, quant

TODAY = date(2026, 11, 13)   # a Friday, so the last close lands on the grid's last day


def rw(start: float, n: int, vol_annual: float = 0.2, drift_annual: float = 0.08, seed: int = 1, end: date = TODAY):
    """`n` weekday closes ending on `end`: a geometric random walk with the given annual drift and volatility."""
    rng = random.Random(seed)
    mu, sd = drift_annual / 252, vol_annual / math.sqrt(252)
    days, cur = [], end
    while len(days) < n:
        if cur.weekday() < 5:
            days.append(cur)
        cur -= timedelta(days=1)
    out, p = [], start
    for day in reversed(days):
        p *= math.exp(rng.gauss(mu - sd * sd / 2, sd))
        out.append((day.isoformat(), round(p, 6)))
    return out


def pos(pid, name, seg, ac, value, symbol=None, currency="INR", **kw):
    return {"id": pid, "name": name, "symbol": symbol, "segment": seg, "asset_class": ac, "value": value,
            "is_open": True, "currency": currency, **kw}


def stock(pid=1, value=60000, symbol="A.NS", name="A"):
    return pos(pid, name, d.SEG_EQ_IN, d.EQUITY, value, symbol)


def fd(pid=9, value=90000, rate=None):
    return pos(pid, "FD", d.SEG_FD, d.FIXED_DEPOSIT, value, rate=rate)


# ── holding_stats ──

def test_seventy_day_holding_measures_its_own_sigma_and_shrinks_toward_the_prior():
    pts = rw(100, 70, vol_annual=0.32, seed=11)
    st = quant.holding_stats(pts, d.SEG_EQ_IN)
    assert st["n"] == 69 and st["data_quality"] == "some"
    assert 0.26 <= st["sigma_own"] <= 0.38            # A29: the measured σ, not the shrunk one
    prior = A.effective_book(None)["segments"][d.SEG_EQ_IN]["vol_pct"] / 100
    w = 69 / 756
    assert st["sigma_used"] == pytest.approx(math.sqrt(w * st["sigma_own"] ** 2 + (1 - w) * prior ** 2), abs=1e-3)
    assert abs(st["sigma_used"] - prior) < abs(st["sigma_own"] - prior)
    assert st["beta"] == 1.0 and st["mu"] == pytest.approx(0.12)   # no benchmark: the prior β stands


def test_holding_stats_shrink_beta_and_quality_rules():
    short = quant.holding_stats(rw(100, 40, vol_annual=0.5, seed=2), d.SEG_EQ_IN)
    assert short["data_quality"] == "prior" and short["sigma_used"] == pytest.approx(0.18)   # n < 60: w = 0
    long_pts = rw(100, 900, vol_annual=0.30, seed=3)
    bench = rw(20000, 900, vol_annual=0.15, seed=4)
    lg = quant.holding_stats(long_pts, d.SEG_EQ_IN, bench_points=bench)
    assert lg["data_quality"] == "own" and lg["n"] == 899
    w = 0.6   # capped
    assert lg["sigma_used"] == pytest.approx(math.sqrt(w * lg["sigma_own"] ** 2 + 0.4 * 0.18 ** 2), abs=1e-3)
    assert 0.0 <= lg["beta"] <= 2.5 and lg["beta"] != 1.0
    assert quant.holding_stats([], d.SEG_FD)["data_quality"] == "rate"
    # book shapes: tuple mapping and the §6.1 effective-book shape
    assert quant.holding_stats([], d.SEG_EQ_IN, {d.SEG_EQ_IN: (0.1, 0.25)})["sigma_used"] == pytest.approx(0.25)
    eff = {"segments": {d.SEG_EQ_IN: {"return_pct": 10, "vol_pct": 22}}}
    assert quant.holding_stats([], d.SEG_EQ_IN, eff)["sigma_used"] == pytest.approx(0.22)


def test_debt_mutual_funds_map_to_their_own_prior():
    liquid = pos(1, "Liquid", d.SEG_MF, d.MUTUAL_FUND, 1, "L", category="Debt", sub_category="Liquid")
    assert A.book_key(liquid) == quant.MF_DEBT == A.MF_DEBT
    assert A.book_key(pos(2, "Gilt", d.SEG_MF, d.MUTUAL_FUND, 1, "G", category="Gilt Fund")) == A.MF_DEBT
    assert A.book_key(pos(3, "X", d.SEG_MF, d.MUTUAL_FUND, 1, "X", tax_class=d.TAX_DEBT)) == A.MF_DEBT
    assert A.book_key(pos(4, "ELSS", d.SEG_MF, d.MUTUAL_FUND, 1, "E", category="ELSS")) == d.SEG_MF
    # the debt prior is the Book's MF_DEBT row
    st = quant.holding_stats([], A.MF_DEBT)
    assert st["sigma_used"] == pytest.approx(A.ASSUMPTIONS[A.MF_DEBT][1]) and st["mu"] == pytest.approx(0.07)


def test_the_debt_mf_rule_goes_through_assumptions_book_key(monkeypatch):
    """No local regex: quant asks assumptions.book_key for every key it needs (G9)."""
    assert not any(hasattr(quant, n) for n in ("_book_key", "_DEBT_MF", "DEFAULT_BOOK", "_MF_DEBT_CORR", "_corr",
                                               "model_volatility", "DRIFT_PRIOR", "BALLAST_DEFAULT_RATE"))
    seen = []
    real = A.book_key

    def spy(p):
        seen.append(p.get("id"))
        return real(p)

    monkeypatch.setattr(A, "book_key", spy)
    bench = rw(20000, 400, vol_annual=0.14, seed=41)
    liquid = pos(1, "Liquid", d.SEG_MF, d.MUTUAL_FUND, 50000, "LIQ", category="Debt", sub_category="Liquid")
    r = quant.portfolio_risk([liquid, fd(2, 50000)], {"LIQ": rw(10, 80, vol_annual=0.01, seed=42)}, bench, today=TODAY)
    assert 1 in seen and 2 in seen
    # MF_DEBT: no Nifty proxy, and its used σ leans on the 3% debt prior, not the 15% MF one
    assert r["holdings"][0]["data"] == "prior" and r["holdings"][0]["proxy"] is None
    assert r["holdings"][0]["volatility_used_pct"] == pytest.approx(3.0, abs=0.5)


def test_quant_imports_only_domain_and_assumptions_from_the_package():
    tree = ast.parse(Path(quant.__file__).read_text(encoding="utf-8"))
    package_modules = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.level:   # `from .x import y` → x; `from . import y` → y
            package_modules |= {n.module} if n.module else {a.name for a in n.names}
    assert package_modules == {"domain", "assumptions", "signals"}   # signals: the pure leaf of K16 (L1)
    assert quant.RISK_FREE == A.RISK_FREE and quant.P2P_LOSS == A.P2P_LOSS and quant.P2P_MU_CAP == A.P2P_MU_CAP
    assert quant.GSPC == "^GSPC" and quant.GOLDBEES == "GOLDBEES.NS" and quant.NSEI == "^NSEI"   # services reads these


# ── holding_outlook: the cone on the Book (G9) ──

def _shifted(points, annual):
    """The same closes with a constant extra log drift per day: identical σ, very different trend."""
    c = annual / 252
    return [(day, px * math.exp(c * i)) for i, (day, px) in enumerate(points)]


def test_the_cone_uses_the_book_mu_not_the_trend():
    flat = rw(100, 800, vol_annual=0.25, drift_annual=-0.05, seed=61)
    hot = _shifted(flat, 0.60)
    a = quant.holding_outlook(flat, None, d.SEG_EQ_IN, today=TODAY)
    b = quant.holding_outlook(hot, None, d.SEG_EQ_IN, today=TODAY)
    sa, sb = quant.holding_stats(flat, d.SEG_EQ_IN), quant.holding_stats(hot, d.SEG_EQ_IN)
    assert sa["sigma_used"] == sb["sigma_used"]
    # the trend really is different; the cone does not care
    assert b["cagr_3y_pct"] - a["cagr_3y_pct"] > 40 and b["momentum"]["1Y"] > a["momentum"]["1Y"]
    sigma = sa["sigma_used"]
    typ = A.typical(0.12, sigma)
    for o in (a, b):
        assert o["assumptions"]["drift_pct"] == 12.0 and o["assumptions"]["volatility_pct"] == round(sigma * 100, 1)
        assert o["cone"]["1Y"]["p50"] / o["price"] == pytest.approx(1 + typ, rel=2e-4)
        t = 63 / 252
        assert o["cone"]["3M"]["p50"] / o["price"] == pytest.approx(math.exp((math.log(1.12) - sigma ** 2 / 2) * t), rel=2e-4)
    assert a["cone"]["1Y"]["p90"] / a["price"] == pytest.approx(b["cone"]["1Y"]["p90"] / b["price"], rel=2e-4)


def test_the_cone_key_book_and_honest_labels():
    pts = rw(100, 300, vol_annual=0.02, drift_annual=0.04, seed=62)
    o = quant.holding_outlook(pts, None, d.SEG_MF, today=TODAY, book_key=A.MF_DEBT)
    assert o["assumptions"]["drift_pct"] == 7.0                     # the debt row, not the 11% MF row
    assert o["assumptions"]["cone_label"] == A.HONESTY["cone"] != A.HONESTY["signal"]   # H16: the cone's own label
    assert o["assumptions"]["hash"] == A.book_hash(A.effective_book(None))
    assert o["assumptions"]["data_quality"] == "some" and "Mutual Funds (debt)" in o["assumptions"]["basis"]
    assert o["assumptions"]["typical_pct"] == pytest.approx(A.typical(0.07, o["assumptions"]["volatility_pct"] / 100) * 100, abs=0.06)
    own = {"segments": {d.SEG_EQ_IN: {"return_pct": 9, "vol_pct": 20}}, "inflation_pct": 6}
    o2 = quant.holding_outlook(pts, None, d.SEG_EQ_IN, today=TODAY, book=own)
    assert o2["assumptions"]["drift_pct"] == 9.0 and o2["assumptions"]["hash"] == A.book_hash(own)
    # σ used is the shrunk one: 299 returns at 2% pulled toward the book's 20%
    assert o2["assumptions"]["volatility_pct"] == pytest.approx(quant.holding_stats(pts, d.SEG_EQ_IN, own)["sigma_used"] * 100, abs=0.05)
    assert o2["assumptions"]["volatility_pct"] > 10
    # §7.8: no cone under 30 closes
    assert quant.holding_outlook(pts[:29], None, d.SEG_EQ_IN) is None
    assert quant.holding_outlook(pts[:30], None, d.SEG_EQ_IN) is not None


# ── the model block (G9) ──

def test_model_vol_is_the_mu_sigma_sigma_and_the_optimizer_current_vol():
    us = pos(2, "US", d.SEG_EQ_US, d.EQUITY, 20000, "US", currency="USD")
    liquid = pos(3, "Liquid", d.SEG_MF, d.MUTUAL_FUND, 15000, "LIQ", category="Debt", sub_category="Liquid")
    elss = pos(4, "ELSS", d.SEG_MF, d.MUTUAL_FUND, 25000, "ELS", category="ELSS")
    loan = pos(5, "Loan", d.SEG_P2P, d.P2P, 10000, rate=40.0)
    epf = pos(6, "EPF", d.SEG_EPF, d.EPF, 30000, rate=8.25)
    closed = {**stock(7, 99999, "C.NS", "Closed"), "is_open": False}
    positions = [stock(1, 60000), us, liquid, elss, loan, epf, fd(8, 50000, rate=7.5), closed]
    hist = {"A.NS": rw(100, 400, seed=71), "US": rw(200, 400, seed=72), "LIQ": rw(10, 400, vol_annual=0.01, seed=73),
            "ELS": rw(50, 400, seed=74)}
    r = quant.portfolio_risk(positions, hist, rw(20000, 400, vol_annual=0.14, seed=75), today=TODAY)
    _, sigma = A.mu_sigma(A.weights_from_positions(positions), A.rated_book(positions))
    assert r["model"]["vol_pct"] == round(sigma * 100, 2)
    assert r["measured_vs_model"]["model_vol_pct"] == r["model"]["vol_pct"]
    segs: dict[str, float] = {}
    for p in positions:
        if p["is_open"]:
            segs[p["segment"]] = segs.get(p["segment"], 0.0) + p["value"]
    port = {"positions": positions, "segments": [{"segment": s, "value": v} for s, v in segs.items()]}
    for profile in ("conservative", "balanced", "aggressive"):
        assert optimizer.suggest(port, profile)["current"]["vol_pct"] == r["model"]["vol_pct"]
    total = sum(segs.values())
    assert r["model"]["var_day"] == pytest.approx(quant.Z95 * sigma / math.sqrt(252) * total, abs=0.01)
    # the same block when nothing is market-priced yet
    empty = quant.portfolio_risk([epf, loan], {}, None, today=TODAY)
    _, s2 = A.mu_sigma(A.weights_from_positions([epf, loan]), A.rated_book([epf, loan]))
    assert empty["model"]["vol_pct"] == round(s2 * 100, 2) and empty["holdings"] == []


# ── ballast ──

def test_p2p_ballast_is_capped_at_twelve_percent_and_a_default_earns_nothing():
    a = rw(100, 300, seed=81)
    borrower = pos(6, "Loan", d.SEG_P2P, d.P2P, 50000, rate=42.0)          # 42% − 3% = 39%: capped
    r = quant.portfolio_risk([stock(1, 50000), borrower], {"A.NS": a}, None, today=TODAY)
    assert r["ballast"]["rate_pct"] == pytest.approx(A.P2P_MU_CAP * 100) == pytest.approx(12.0)
    bad = {**pos(7, "Bad", d.SEG_P2P, d.P2P, 50000, rate=42.0), "status": "defaulted"}
    r2 = quant.portfolio_risk([stock(1, 50000), borrower, bad], {"A.NS": a}, None, today=TODAY)
    assert r2["ballast"]["rate_pct"] == pytest.approx(6.0)
    plain = pos(8, "Loan", d.SEG_P2P, d.P2P, 50000)                       # no rate: the Book's net 7%
    assert quant.portfolio_risk([stock(1, 50000), plain], {"A.NS": a}, None, today=TODAY)["ballast"]["rate_pct"] == pytest.approx(7.0)
    under = pos(9, "Loan", d.SEG_P2P, d.P2P, 50000, rate=13.0)            # 10% after the loss: under the cap
    assert quant.portfolio_risk([stock(1, 50000), under], {"A.NS": a}, None, today=TODAY)["ballast"]["rate_pct"] == pytest.approx(10.0)


# ── portfolio_risk v2 ──

def test_portfolio_risk_var_beta_and_correlations():
    a = rw(100, 400, vol_annual=0.24, seed=3)
    bench = rw(20000, 400, vol_annual=0.14, seed=4)
    # B follows A closely: the pair should be flagged as highly correlated
    b = [(dd, round(v * (1 + 0.002 * math.sin(i)), 4)) for i, (dd, v) in enumerate(a)]
    positions = [stock(1, 60000, "A.NS", "A"), stock(2, 30000, "B.NS", "B"), fd(3, 90000)]
    r = quant.portfolio_risk(positions, {"A.NS": a, "B.NS": b}, bench, today=TODAY)
    assert r["exposed_pct"] == 50.0 and r["var_95"]["day"] > 0 and r["var_95"]["month"] > r["var_95"]["day"]
    assert r["correlation"]["highest"]["value"] > 0.95
    contrib = sum(h["risk_contribution_pct"] for h in r["holdings"])
    assert contrib == pytest.approx(100, abs=0.5)
    assert r["beta"] is not None
    # v2 fields alongside the old ones
    assert all(h["data"] == "own" and h["volatility_used_pct"] > 0 for h in r["holdings"])
    assert r["ballast"]["rate_pct"] == pytest.approx(7.0)   # FD default rate
    assert r["model"]["vol_pct"] > 0 and r["model"]["var_day"] > 0
    assert r["measured_vs_model"]["model_vol_pct"] == r["model"]["vol_pct"] and r["measured_vs_model"]["ratio"] > 0
    empty = quant.portfolio_risk([positions[2]], {}, bench, today=TODAY)
    assert empty["holdings"] == [] and empty["notes"]
    assert set(empty["correlation"]) == {"labels", "matrix", "highest", "lowest"}


def test_ballast_accrues_so_a_stock_fd_mix_keeps_its_sharpe():
    a = rw(100, 400, vol_annual=0.22, drift_annual=0.15, seed=21)
    alone = quant.portfolio_risk([stock(1, 100000)], {"A.NS": a}, None, today=TODAY)
    mix = quant.portfolio_risk([stock(1, 40000), fd(9, 60000)], {"A.NS": a}, None, today=TODAY)
    assert abs(mix["sharpe"] - alone["sharpe"]) < 0.1
    assert mix["volatility_pct"] == pytest.approx(alone["volatility_pct"] * 0.4, rel=0.02)
    # the FD earns its rate: the mixed mean sits above 40% of the stock's mean
    assert mix["mean_return_pct"] > 0.4 * alone["mean_return_pct"] + 3.5
    assert mix["ballast"]["risk_contribution_pct"] == pytest.approx(0, abs=0.05)
    assert mix["holdings"][0]["risk_contribution_pct"] == pytest.approx(100, abs=0.5)


def test_ballast_rates_come_from_the_position():
    a = rw(100, 300, seed=5)
    hist = {"A.NS": a}
    epf = pos(5, "EPF", d.SEG_EPF, d.EPF, 50000, rate=8.25)
    p2p = pos(6, "Loan", d.SEG_P2P, d.P2P, 50000, rate=12.0)
    nps = pos(7, "NPS", d.SEG_NPS, d.NPS, 50000)
    r = quant.portfolio_risk([stock(1, 50000), epf, p2p, nps], hist, None, today=TODAY)
    # EPF 8.25%, P2P 12% − 3% loss, NPS (hand-priced) 10%
    assert r["ballast"]["rate_pct"] == pytest.approx((8.25 + 9.0 + 10.0) / 3, abs=0.01)
    assert r["exposed_pct"] == 25.0


def test_a_new_holding_counts_from_its_own_first_close_not_zero_filled():
    """v1 zero-filled the days before a holding existed, so a 70-day holding showed a fraction of its
    volatility. v2 counts it from its first close when no proxy stands in."""
    gold = rw(50, 70, vol_annual=0.32, seed=11)
    p = pos(1, "Gold ETF", d.SEG_COMMODITY, d.COMMODITY, 100000, "GOLD.NS")
    r = quant.portfolio_risk([p], {"GOLD.NS": gold}, None, today=TODAY)
    h = r["holdings"][0]
    assert h["data"] == "prior" and r["days"] == 69
    assert 26 <= h["volatility_pct"] <= 38                       # sigma_own
    assert 26 <= r["volatility_pct"] <= 38                       # the portfolio is that one holding
    assert h["volatility_used_pct"] < h["volatility_pct"]        # shrunk toward the 15% commodity prior


def test_a_proxy_row_is_flagged_only_when_proxies_are_passed():
    a = rw(100, 400, seed=31)
    gold = rw(50, 70, vol_annual=0.15, seed=32)
    goldbees = rw(60, 400, vol_annual=0.14, seed=33)
    positions = [stock(1, 50000), pos(2, "Gold ETF", d.SEG_COMMODITY, d.COMMODITY, 50000, "GOLD.NS")]
    hist = {"A.NS": a, "GOLD.NS": gold}
    without = quant.portfolio_risk(positions, hist, None, today=TODAY)
    row = next(h for h in without["holdings"] if h["id"] == 2)
    assert row["data"] == "prior" and row["proxy"] is None
    with_proxy = quant.portfolio_risk(positions, hist, None, today=TODAY, proxies={"GOLDBEES.NS": goldbees})
    row = next(h for h in with_proxy["holdings"] if h["id"] == 2)
    assert row["data"] == "proxy" and row["proxy"] == "GOLDBEES"
    assert next(h for h in with_proxy["holdings"] if h["id"] == 1)["data"] == "own"
    assert any("stands in" in n for n in with_proxy["notes"])
    # Indian equity always has ^NSEI from bench_points; a US holding uses ^GSPC × USDINR
    bench = rw(20000, 400, vol_annual=0.14, seed=34)
    new_in = quant.portfolio_risk([stock(1, 50000, "N.NS", "New")], {"N.NS": rw(100, 50, seed=35)}, bench, today=TODAY)
    assert new_in["holdings"][0]["data"] == "proxy" and new_in["days"] > 200
    us = pos(3, "US", d.SEG_EQ_US, d.EQUITY, 50000, "US", currency="USD")
    us_hist = {"US": rw(200, 50, seed=36)}
    fx = rw(83, 400, vol_annual=0.04, seed=37)
    assert quant.portfolio_risk([us], us_hist, bench, fx, today=TODAY)["holdings"][0]["data"] == "prior"
    us_r = quant.portfolio_risk([us], us_hist, bench, fx, today=TODAY, proxies={"^GSPC": rw(5000, 400, seed=38)})
    assert us_r["holdings"][0]["data"] == "proxy" and us_r["holdings"][0]["proxy"] == "S&P 500 in ₹"


def test_debt_fund_has_no_proxy():
    bench = rw(20000, 400, vol_annual=0.14, seed=41)
    liquid = pos(1, "Liquid", d.SEG_MF, d.MUTUAL_FUND, 50000, "LIQ", category="Debt", sub_category="Liquid")
    r = quant.portfolio_risk([liquid], {"LIQ": rw(10, 80, vol_annual=0.01, seed=42)}, bench, today=TODAY)
    assert r["holdings"][0]["data"] == "prior" and r["days"] == 79


def test_risk_contributions_sum_to_100_with_proxies_and_shifting_weights():
    bench = rw(20000, 400, vol_annual=0.14, seed=51)
    hist = {"A.NS": rw(100, 400, vol_annual=0.25, seed=52), "N.NS": rw(80, 70, vol_annual=0.35, seed=53),
            "G.NS": rw(50, 120, vol_annual=0.15, seed=54)}
    positions = [stock(1, 40000, "A.NS", "A"), stock(2, 25000, "N.NS", "New"),
                 pos(3, "Gold", d.SEG_COMMODITY, d.COMMODITY, 15000, "G.NS"), fd(4, 50000, rate=7.5),
                 pos(5, "EPF", d.SEG_EPF, d.EPF, 30000)]
    r = quant.portfolio_risk(positions, hist, bench, today=TODAY, proxies={"GOLDBEES.NS": rw(60, 400, seed=55)})
    total = sum(h["risk_contribution_pct"] for h in r["holdings"])
    assert total == pytest.approx(100, abs=0.5)
    assert total + r["ballast"]["risk_contribution_pct"] == pytest.approx(100, abs=0.2)
    assert {h["data"] for h in r["holdings"]} == {"own", "proxy"}
    assert r["sharpe"] is not None and r["sortino"] is not None
