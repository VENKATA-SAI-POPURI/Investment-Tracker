"""The Assumption Book (SPEC §6.1, §7.9; AMENDMENTS A32, E14–E16)."""
import ast
import math
from pathlib import Path

import pytest

from tracker import domain as d
from tracker.analytics import assumptions as A
from tracker.analytics import forecast, goals, optimizer, story


def pos(seg, value, **kw):
    ac = {d.SEG_EQ_IN: d.EQUITY, d.SEG_EQ_US: d.EQUITY, d.SEG_MF: d.MUTUAL_FUND, d.SEG_COMMODITY: d.COMMODITY, d.SEG_P2P: d.P2P,
          d.SEG_FD: d.FIXED_DEPOSIT, d.SEG_EPF: d.EPF, d.SEG_NPS: d.NPS}[seg]
    return {"segment": seg, "asset_class": ac, "value": value, "is_open": True, **kw}


# ── leaf module and shared rows ──

def test_assumptions_is_a_leaf_module():
    tree = ast.parse(Path(A.__file__).read_text(encoding="utf-8"))
    rel = [n for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.level]
    assert [(n.level, n.module) for n in rel] == [(2, None)]   # `from .. import domain` only
    assert [a.name for n in rel for a in n.names] == ["domain"]


def test_shared_rows_equal_goals_assumptions():
    assert set(goals.ASSUMPTIONS) == set(d.SEGMENTS)
    for k, row in goals.ASSUMPTIONS.items():
        assert A.ASSUMPTIONS[k] == row
    assert A.ASSUMPTIONS[A.MF_DEBT] == (0.07, 0.03)
    assert set(A.ASSUMPTIONS) == set(A.KEYS)


def test_honesty_matches_forecast_on_shared_keys():
    for k, v in forecast.HONESTY.items():
        assert A.HONESTY[k] == v
    assert "{sims}" in A.HONESTY["p50"] and A.HONESTY["disclaimer"]
    assert set(A.HONESTY) == {"p50", "p10", "p90", "mean", "probability", "estimate", "signal", "cone", "disclaimer"}
    assert forecast.HONESTY is A.HONESTY                                   # G4: one object
    # H16: the cone has its own label; `signal` stays the §6.12 market-signal copy
    assert A.HONESTY["cone"] == "statistical range at the asset class's long-run return; not a forecast"
    assert A.HONESTY["signal"] == "range if it moves as it has; not a forecast"


def test_constants():
    assert A.RISK_FREE == 0.065 and A.INFLATION == 0.06 and A.P2P_LOSS == 0.03 and A.P2P_MU_CAP == 0.12
    assert A.STATUS_THRESHOLDS == {"on_track": 75, "at_risk": 40}
    from tracker.analytics import history
    assert history.RISK_FREE is A.RISK_FREE and optimizer.RISK_FREE is A.RISK_FREE


# ── CORR ──

def test_corr_is_symmetric_with_the_specified_mf_debt_row():
    keys = list(A.KEYS)
    assert len(keys) == 9 and keys[-1] == A.MF_DEBT
    for a in keys:
        assert A.CORR[a][a] == 1.0
        for b in keys:
            assert A.CORR[a][b] == A.CORR[b][a]
    assert [A.CORR[A.MF_DEBT][k] for k in d.SEGMENTS] == [0.05, 0.00, 0.10, 0.05, 0.10, 0.30, 0.20, 0.30]


def test_corr_cholesky_succeeds():
    """A32: the pure-Python Cholesky of the 9×9 matrix as specified succeeds (λ = 0, no repair)."""
    keys = list(A.KEYS)
    n = len(keys)
    m = [[A.CORR[a][b] for b in keys] for a in keys]
    lower = [[0.0] * n for _ in range(n)]
    pivots = []
    for i in range(n):
        for j in range(i + 1):
            s = m[i][j] - sum(lower[i][k] * lower[j][k] for k in range(j))
            if i == j:
                pivots.append(s)
                assert s > 1e-9, f"pivot {i} = {s}"
                lower[i][i] = math.sqrt(s)
            else:
                lower[i][j] = s / lower[j][j]
    assert all(p > 1e-9 for p in pivots)
    assert min(pivots) == pytest.approx(0.186, abs=0.001)
    assert A.CORR_NOTE == "Positive definite as specified."


# ── book_key ──

@pytest.mark.parametrize("field,value", [("category", "Liquid"), ("sub_category", "Gilt"), ("category", "Corporate Bond"),
                                         ("sub_category", "Overnight Fund"), ("category", "Money Market")])
def test_debt_regex_maps_to_mf_debt(field, value):
    assert A.book_key(pos(d.SEG_MF, 100, **{field: value})) == A.MF_DEBT


def test_book_key_rules():
    assert A.book_key(pos(d.SEG_MF, 100, category="ELSS")) == d.SEG_MF
    assert A.book_key(pos(d.SEG_MF, 100, category="Equity", tax_class=d.TAX_DEBT)) == A.MF_DEBT
    assert A.book_key(pos(d.SEG_MF, 100, category="Flexi Cap", name="HDFC Liquid-ish Bond Name")) == d.SEG_MF  # name unused
    assert A.book_key({"asset_class": d.CASH, "segment": d.SEG_EQ_US, "value": 10}) == d.SEG_EQ_US
    assert A.book_key({"asset_class": d.CASH, "value": 10}) == d.SEG_EQ_US
    assert A.book_key(pos(d.SEG_FD, 100)) == d.SEG_FD
    assert A.book_key({"asset_class": d.EQUITY, "market": "USA"}) == d.SEG_EQ_US   # no segment: from domain


# ── the book ──

def test_effective_book_shape_and_hash():
    book = A.effective_book({"assumptions": {"Equity (India)": {"return_pct": 99}}})   # no overrides until P2
    assert set(book) == {"segments", "inflation_pct"} and book["inflation_pct"] == 6.0
    assert set(book["segments"]) == set(A.KEYS)
    assert book["segments"][d.SEG_EQ_IN]["return_pct"] == 12.0 and book["segments"][d.SEG_EQ_IN]["vol_pct"] == 18.0
    assert book["segments"][d.SEG_P2P]["return_pct"] == pytest.approx(7.0)   # 10% − the expected loss
    assert book["segments"][d.SEG_EPF]["return_pct"] == 8.25
    h = A.book_hash(book)
    assert len(h) == 10 and all(c in "0123456789abcdef" for c in h)
    reordered = {"inflation_pct": book["inflation_pct"],
                 "segments": {k: dict(reversed(list(v.items()))) for k, v in reversed(list(book["segments"].items()))}}
    assert A.book_hash(reordered) == h
    changed = A.effective_book(None)
    changed["segments"][d.SEG_EQ_IN]["return_pct"] = 11.0
    assert A.book_hash(changed) != h


def test_effective_book_applies_overrides():
    """R4: listed rows take both numbers with source 'override'; inflation replaces the default."""
    base = A.effective_book(None)
    ov = {"segments": {d.SEG_EQ_IN: {"return_pct": 10, "vol_pct": 22}, d.SEG_P2P: {"return_pct": 9, "vol_pct": 8},
                       A.MF_DEBT: {"return_pct": 6.5, "vol_pct": 2.5}}, "inflation_pct": 5}
    book = A.effective_book({"assumptions": ov, "taxSlabRate": "30"})
    assert book["segments"][d.SEG_EQ_IN] == {"return_pct": 10.0, "vol_pct": 22.0, "source": "override"}
    assert book["segments"][d.SEG_P2P]["return_pct"] == 9.0          # taken as the net return, no loss applied again
    assert book["segments"][A.MF_DEBT]["source"] == "override" and book["inflation_pct"] == 5.0
    assert book["segments"][d.SEG_FD] == base["segments"][d.SEG_FD]   # unlisted rows keep the default
    assert A.book_hash(book) != A.book_hash(base)
    only_inflation = A.effective_book({"assumptions": {"inflation_pct": 7.5}})
    assert only_inflation["segments"] == base["segments"] and only_inflation["inflation_pct"] == 7.5
    # nothing to apply: missing, null, {}, the wrong shape, or a malformed row
    for s in (None, {}, {"assumptions": None}, {"assumptions": {}}, {"assumptions": "x"},
              {"assumptions": {"segments": {"Gold": {"return_pct": 1, "vol_pct": 1}}}},
              {"assumptions": {"segments": {d.SEG_EQ_IN: {"return_pct": 10}}}},
              {"assumptions": {"segments": {d.SEG_EQ_IN: {"return_pct": float("nan"), "vol_pct": 1}}}},
              {"assumptions": {"inflation_pct": True}}):
        assert A.effective_book(s) == base, s


def test_rated_book_keeps_holding_rates_over_an_override_return_but_not_its_vol():
    ov = {"segments": {d.SEG_FD: {"return_pct": 5.0, "vol_pct": 3.0}, d.SEG_EQ_IN: {"return_pct": 10.0, "vol_pct": 20.0}}}
    book = A.effective_book({"assumptions": ov})
    rated = A.rated_book([pos(d.SEG_FD, 1000, rate=7.5), pos(d.SEG_EQ_IN, 1000)], book)
    fd = rated["segments"][d.SEG_FD]
    assert (fd["return_pct"], fd["vol_pct"], fd["source"]) == (7.5, 3.0, "holding rates")
    assert rated["segments"][d.SEG_EQ_IN]["source"] == "override"
    # with no FD held, the override's return stands
    assert A.rated_book([pos(d.SEG_EQ_IN, 1000)], book)["segments"][d.SEG_FD]["return_pct"] == 5.0


def test_validate_overrides():
    assert A.validate_overrides(None) == {} and A.validate_overrides({}) == {}
    ok = A.validate_overrides({"segments": {d.SEG_EQ_IN: {"return_pct": -5, "vol_pct": 60, "source": "x"}},
                               "inflation_pct": 15})
    assert ok == {"segments": {d.SEG_EQ_IN: {"return_pct": -5.0, "vol_pct": 60.0}}, "inflation_pct": 15.0}
    assert A.validate_overrides({"segments": None, "inflation_pct": None}) == {}
    assert A.validate_overrides({"segments": {A.MF_DEBT: {"return_pct": 25, "vol_pct": 0}}})["segments"]
    for bad in ([], "x", {"segment": {}}, {"segments": {"Gold": {"return_pct": 1, "vol_pct": 1}}},
                {"segments": {d.SEG_EQ_IN: {"return_pct": 25.01, "vol_pct": 1}}},
                {"segments": {d.SEG_EQ_IN: {"return_pct": 1, "vol_pct": 60.5}}},
                {"segments": {d.SEG_EQ_IN: {"return_pct": float("inf"), "vol_pct": 1}}},
                {"segments": {d.SEG_EQ_IN: {"vol_pct": 1}}}, {"inflation_pct": 15.5}, {"inflation_pct": False}):
        with pytest.raises(ValueError):
            A.validate_overrides(bad)


def test_rated_book_caps_p2p_and_value_weights_fd():
    positions = [pos(d.SEG_FD, 300000, rate=7.0), pos(d.SEG_FD, 100000, rate=8.0),
                 pos(d.SEG_FD, 50000, rate=9.0, is_open=False),                       # closed: ignored
                 pos(d.SEG_P2P, 20000, rate=42.0), pos(d.SEG_P2P, 10000, rate=36.0),
                 pos(d.SEG_EPF, 50000, rate=8.25), pos(d.SEG_EQ_IN, 100000)]
    base = A.effective_book(None)
    book = A.rated_book(positions, base)
    segs = book["segments"]
    assert segs[d.SEG_FD]["return_pct"] == pytest.approx((300000 * 7 + 100000 * 8) / 400000)   # 7.25
    assert segs[d.SEG_FD]["source"] == "holding rates" and segs[d.SEG_FD]["vol_pct"] == 1.0
    assert segs[d.SEG_P2P]["return_pct"] == pytest.approx(12.0) and segs[d.SEG_P2P]["capped"] is True
    assert segs[d.SEG_EPF]["return_pct"] == pytest.approx(8.25)
    assert segs[d.SEG_EQ_IN] == base["segments"][d.SEG_EQ_IN]                               # unrated: unchanged
    assert base["segments"][d.SEG_FD]["return_pct"] == 7.0 and "capped" not in base["segments"][d.SEG_P2P]  # a copy


def test_rated_book_p2p_below_cap_and_defaults():
    book = A.rated_book([pos(d.SEG_P2P, 1000, rate=12.0), pos(d.SEG_P2P, 1000, rate=None, status="defaulted"),
                         pos(d.SEG_FD, 1000)], A.effective_book(None))
    assert book["segments"][d.SEG_P2P]["return_pct"] == pytest.approx((9.0 + 0.0) / 2)   # 12 − 3; a defaulted loan earns 0
    assert "capped" not in book["segments"][d.SEG_P2P]
    assert book["segments"][d.SEG_FD]["return_pct"] == pytest.approx(7.0)                 # no rate: the default
    assert A.rated_book([], None) == A.effective_book(None)


def test_weights_from_positions():
    positions = [pos(d.SEG_EQ_IN, 600), pos(d.SEG_MF, 200, category="Liquid"), pos(d.SEG_MF, 100, category="Flexi Cap"),
                 {"asset_class": d.CASH, "segment": d.SEG_EQ_US, "value": 100, "is_open": True},
                 pos(d.SEG_FD, 500, is_open=False), pos(d.SEG_NPS, 0), pos(d.SEG_EPF, -5)]
    w = A.weights_from_positions(positions)
    assert w == pytest.approx({d.SEG_EQ_IN: 0.6, A.MF_DEBT: 0.2, d.SEG_MF: 0.1, d.SEG_EQ_US: 0.1})
    assert A.weights_from_positions([]) == {} and A.weights_from_positions(None) == {}


# ── mu_sigma ──

@pytest.mark.parametrize("key", list(A.KEYS))
def test_mu_sigma_single_segment_is_that_row(key):
    book = A.effective_book(None)
    mu, sigma = A.mu_sigma({key: 1.0}, book)
    assert mu * 100 == pytest.approx(book["segments"][key]["return_pct"])
    assert sigma * 100 == pytest.approx(book["segments"][key]["vol_pct"])


def test_mu_sigma_perfect_correlation_is_the_linear_sum(monkeypatch):
    corr = {a: dict(row) for a, row in A.CORR.items()}
    corr[d.SEG_EQ_IN][d.SEG_COMMODITY] = corr[d.SEG_COMMODITY][d.SEG_EQ_IN] = 1.0
    monkeypatch.setattr(A, "CORR", corr)
    mu, sigma = A.mu_sigma({d.SEG_EQ_IN: 0.4, d.SEG_COMMODITY: 0.6})
    assert mu == pytest.approx(0.4 * 0.12 + 0.6 * 0.08)
    assert sigma == pytest.approx(0.4 * 0.18 + 0.6 * 0.15)


def test_mu_sigma_diversifies_and_handles_edges():
    mu, sigma = A.mu_sigma({d.SEG_EQ_IN: 0.5, d.SEG_FD: 0.5})
    assert sigma < 0.5 * 0.18 + 0.5 * 0.01
    assert sigma == pytest.approx(math.sqrt((0.5 * 0.18) ** 2 + (0.5 * 0.01) ** 2))   # ρ = 0
    assert A.mu_sigma({}) == (0.0, 0.0) and A.mu_sigma({d.SEG_EQ_IN: 0.0}) == (0.0, 0.0)
    notes = []
    assert A.mu_sigma({d.SEG_EQ_IN: 1.0, "Crypto": 0.5}, notes=notes) == pytest.approx((0.12, 0.18))
    assert len(notes) == 1 and "Crypto" in notes[0]
    assert A.mu_sigma({d.SEG_FD: 1.0}, {d.SEG_FD: (0.05, 0.02)}) == pytest.approx((0.05, 0.02))   # plain {key: (mu, sigma)}


# ── typical, band, status, chip ──

@pytest.mark.parametrize("sigma", [0.005, 0.03, 0.12, 0.18, 0.4])
def test_typical_is_below_mu(sigma):
    for mu in (-0.05, 0.0, 0.07, 0.12):
        assert A.typical(mu, sigma) < mu
    assert A.typical(0.1, 0.0) == pytest.approx(0.1)


def test_typical_band_narrows_with_years():
    one, ten = A.typical_band(0.11, 0.15, 1), A.typical_band(0.11, 0.15, 10)
    assert one["typical"] == ten["typical"] == pytest.approx(A.typical(0.11, 0.15) * 100, abs=0.01)
    assert one["lo"] < ten["lo"] < ten["typical"] < ten["hi"] < one["hi"]
    assert A.typical_band(0.11, 0.15, 0) == one   # T = max(years, 1)


def test_status_for_boundaries():
    assert A.status_for(74.9) == "at_risk"
    assert A.status_for(75) == "on_track"
    assert A.status_for(39.9) == "off_track"
    assert A.status_for(40) == "at_risk"
    assert A.status_for(None) is None
    assert A.status_for(10, achieved=True) == "achieved"


def test_chip():
    book = A.effective_book(None)
    w = {d.SEG_EQ_IN: 0.5, d.SEG_MF: 0.3, d.SEG_FD: 0.2}
    c = A.chip(book, w)
    mu, sigma = A.mu_sigma(w, book)
    assert set(c) == {"return_pct", "typical_pct", "volatility_pct", "inflation_pct", "hash", "text"}
    assert c["return_pct"] == round(mu * 100, 2) and c["volatility_pct"] == round(sigma * 100, 2)
    assert c["typical_pct"] < c["return_pct"] and c["hash"] == A.book_hash(book)
    assert c["text"] == f"{mu * 100:.1f}% avg · {A.typical(mu, sigma) * 100:.1f}% typical · ±{sigma * 100:.1f}% · 6% inflation"
    rated = A.rated_book([pos(d.SEG_P2P, 100, rate=40.0)], book)
    assert A.chip(rated, {d.SEG_P2P: 1.0})["text"].endswith(" · P2P capped at 12%")
    assert "capped" not in A.chip(rated, w)["text"]


# ── callers ──

def _port_with_positions():
    positions = [pos(d.SEG_EQ_IN, 400000), pos(d.SEG_MF, 150000, category="Flexi Cap"),
                 pos(d.SEG_MF, 100000, category="Corporate Bond"), pos(d.SEG_FD, 200000, rate=7.5),
                 pos(d.SEG_P2P, 50000, rate=40.0), pos(d.SEG_EPF, 100000, rate=8.25)]
    segs = {}
    for p in positions:
        segs[p["segment"]] = segs.get(p["segment"], 0.0) + p["value"]
    return {"totals": {"value": sum(segs.values())}, "segments": [{"segment": k, "value": v} for k, v in segs.items()],
            "positions": positions}


def test_optimizer_current_uses_the_book_on_positions():
    port = _port_with_positions()
    res = optimizer.suggest(port, "balanced")
    book = A.rated_book(port["positions"], A.effective_book(None))
    mu, sigma = A.mu_sigma(A.weights_from_positions(port["positions"]), book)
    assert res["current"]["vol_pct"] == round(sigma * 100, 2)
    assert res["current"]["return_pct"] == round(mu * 100, 2)
    assert res["current"]["sharpe"] == round((mu - A.RISK_FREE) / sigma, 2)
    # segment weights are unchanged in the output; MF_DEBT never appears as a segment
    assert set(res["current"]["weights"]) == {s["segment"] for s in port["segments"]}
    assert all(A.MF_DEBT not in p["weights"] for p in res["profiles"])
    # the debt MF lowers volatility versus treating every fund as equity MF
    flat = {**port, "positions": [{**p, "category": "Flexi Cap"} for p in port["positions"]]}
    assert optimizer.suggest(flat, "balanced")["current"]["vol_pct"] > res["current"]["vol_pct"]


def test_optimizer_without_positions_scores_segments_on_the_default_book():
    port = {"totals": {"value": 200000}, "segments": [{"segment": d.SEG_EQ_IN, "value": 100000}, {"segment": d.SEG_FD, "value": 100000}]}
    res = optimizer.suggest(port, "balanced")
    mu, sigma = A.mu_sigma({d.SEG_EQ_IN: 0.5, d.SEG_FD: 0.5}, A.effective_book(None))
    assert res["current"]["vol_pct"] == round(sigma * 100, 2) and res["current"]["return_pct"] == round(mu * 100, 2)


def test_optimizer_stats_split_mf_by_debt_share():
    w = {d.SEG_MF: 0.6, d.SEG_EQ_IN: 0.4}
    book = A.effective_book(None)
    split = optimizer._stats(w, book, 0.25)
    assert split == pytest.approx(A.mu_sigma({d.SEG_MF: 0.45, A.MF_DEBT: 0.15, d.SEG_EQ_IN: 0.4}, book))
    assert optimizer._stats(w, book, 0.0) == pytest.approx(A.mu_sigma(w, book))
    assert optimizer._stats({d.SEG_MF: 1.0}, book, 1.0) == pytest.approx((0.07, 0.03))


def test_story_milestones_assume_the_typical_return():
    port = _port_with_positions()
    book = A.rated_book(port["positions"], A.effective_book(None))
    mu, sigma = A.mu_sigma(A.weights_from_positions(port["positions"]), book)
    m = story.milestones(port, 10000)
    assert m["assumed_return"] == round(A.typical(mu, sigma) * 100, 1)
    assert m["assumed_return"] < round(mu * 100, 1)
    assert story.expected_return({"segments": [], "positions": []}) == 0.10
    seg_only = {"segments": [{"segment": d.SEG_EQ_IN, "value": 1000}]}
    assert story.expected_return(seg_only) == pytest.approx(A.typical(0.12, 0.18))
