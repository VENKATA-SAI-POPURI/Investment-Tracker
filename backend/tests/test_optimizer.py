"""optimizer.suggest P2 (SPEC §6.13; AMENDMENTS E16, K1, K14): KEEP_SHARE a quarter, FD/P2P left to mature,
the E16 MF split without a ninth variable, and tax_if_sold on every trim row."""
from datetime import date

import pytest

from tracker import domain as d
from tracker.analytics import assumptions as A
from tracker.analytics import optimizer
from tracker.analytics.portfolio import compute_portfolio
from tracker.analytics.tax import CHARGES_NOTE, compute_tax

TODAY = date(2025, 12, 1)          # FY2025-26: STCG 20%, LTCG 12.5% over ₹1.25 L
FY = "FY2025-26"


def T(id_, iid, date_, type_, qty=None, amount=0.0):
    return {"id": id_, "instrument_id": iid, "date": date_, "type": type_, "quantity": qty, "amount": amount,
            "amount_fc": None, "principal": None, "fees": None, "owner": "a"}


def I(id_, ac, name, **kw):
    base = {"id": id_, "owner": "a", "asset_class": ac, "name": name, "currency": "INR", "status": "active"}
    base.update(kw)
    base["tax_class"] = d.default_tax_class(ac, base.get("market"), base.get("category"), name)
    return base


def seg_port(values: dict, positions=None) -> dict:
    port = {"totals": {"value": sum(values.values())},
            "segments": [{"segment": k, "value": v} for k, v in values.items()]}
    if positions is not None:
        port["positions"] = positions
    return port


# ── moved from test_forecast.py (K1), with the K14 floor ──

def test_optimizer_respects_caps_floors_and_locked_segments():
    port = seg_port({d.SEG_EQ_IN: 100000, d.SEG_FD: 60000, d.SEG_EPF: 40000})
    res = optimizer.suggest(port, "aggressive")
    rows = {r["segment"]: r for r in res["rows"]}
    assert rows[d.SEG_EPF]["suggested_pct"] == 20.0 and rows[d.SEG_EPF]["locked"]
    assert rows[d.SEG_FD]["suggested_pct"] >= 7.5  # FDs are 30% today: an aggressive mix still keeps a quarter
    assert rows[d.SEG_FD]["action"] in ("let_mature", "hold")
    for p in res["profiles"]:
        assert sum(p["weights"].values()) == pytest.approx(100, abs=0.5)
        assert p["weights"].get(d.SEG_P2P, 0) <= 10.5 and p["weights"].get(d.SEG_COMMODITY, 0) <= 20.5
        assert p["weights"].get(d.SEG_FD, 0) >= 7.5 - 0.05
    vols = [p["vol_pct"] for p in res["profiles"]]
    assert vols == sorted(vols) and res["profiles"][-1]["return_pct"] >= res["profiles"][0]["return_pct"]
    assert res["frontier"] and res["current"]["closest_profile"]


# ── KEEP_SHARE (K14) ──

def test_keep_share_is_a_quarter():
    assert optimizer.KEEP_SHARE == 0.25
    floors = optimizer.floors_for({d.SEG_FD: 0.4, d.SEG_EQ_IN: 0.4, d.SEG_EPF: 0.2},
                                  [s for s in d.SEGMENTS if s not in optimizer.LOCKED], free=0.8)
    assert floors == {d.SEG_FD: pytest.approx(0.1), d.SEG_EQ_IN: pytest.approx(0.1)}
    assert "a quarter" in optimizer.floors_for.__doc__
    res = optimizer.suggest(seg_port({d.SEG_EQ_IN: 100000, d.SEG_FD: 100000}), "balanced")
    assert "below a quarter of its weight" in res["note"] and "half" not in res["note"]


# ── FD and P2P are left to mature (K14) ──

def test_fd_and_p2p_are_never_trimmed_and_stay_out_of_turnover():
    port = seg_port({d.SEG_FD: 300000, d.SEG_P2P: 100000, d.SEG_EQ_IN: 50000, d.SEG_EPF: 50000})
    for profile in ("conservative", "balanced", "growth", "aggressive"):
        res = optimizer.suggest(port, profile)
        rows = {r["segment"]: r for r in res["rows"]}
        for seg in (d.SEG_FD, d.SEG_P2P):
            r = rows[seg]
            assert r["action"] != "trim"
            if r["suggested_pct"] < r["current_pct"] - 1.5:
                assert r["action"] == "let_mature"
        assert rows[d.SEG_EPF]["action"] == "hold" and rows[d.SEG_EPF]["locked"]
        expect = sum(abs(r["delta_amount"]) for r in res["rows"]
                     if not r["locked"] and r["action"] != "let_mature") / 2
        assert res["turnover"] == pytest.approx(expect, abs=0.01)
        assert "FD and P2P are left to mature, never sold" in res["note"]
    # growth wants less of the 60% FD and the over-cap P2P: both say let_mature
    rows = {r["segment"]: r for r in optimizer.suggest(port, "growth")["rows"]}
    assert rows[d.SEG_FD]["action"] == "let_mature" and rows[d.SEG_P2P]["action"] == "let_mature"


# ── the E16 MF split: no ninth variable ──

def test_debt_only_fund_portfolio_counts_as_mf_debt_and_never_as_a_segment():
    positions = [{"id": 1, "segment": d.SEG_MF, "asset_class": d.MUTUAL_FUND, "category": "Corporate Bond",
                  "value": 200000, "is_open": True}]
    port = seg_port({d.SEG_MF: 200000}, positions)
    res = optimizer.suggest(port, "balanced")
    mu, sigma = A.ASSUMPTIONS[A.MF_DEBT]
    assert res["current"]["vol_pct"] == round(sigma * 100, 2)
    assert res["current"]["return_pct"] == round(mu * 100, 2)
    assert res["current"]["weights"] == {d.SEG_MF: 100.0}
    assert all(r["segment"] != A.MF_DEBT for r in res["rows"])
    assert all(A.MF_DEBT not in p["weights"] for p in res["profiles"])
    assert set(r["segment"] for r in res["rows"]) <= set(d.SEGMENTS)
    # the same holding as an equity fund is the Mutual Funds row
    eq = seg_port({d.SEG_MF: 200000}, [{**positions[0], "category": "Flexi Cap"}])
    assert optimizer.suggest(eq, "balanced")["current"]["vol_pct"] == round(A.ASSUMPTIONS[d.SEG_MF][1] * 100, 2)


def test_corr_rows_alias_is_gone():
    assert not hasattr(optimizer, "_CORR_ROWS")
    assert "_CORR_ROWS" not in optimizer.__all__


# ── tax_if_sold on every trim row (K14) ──

def _equity_book():
    inst = [I(1, d.EQUITY, "Oldie", last_price=900.0, market="India"),
            I(2, d.EQUITY, "Newbie", last_price=600.0, market="India"),
            I(3, d.EQUITY, "Loser", last_price=950.0, market="India")]
    txns = [T(1, 1, "2023-06-01", d.BUY, 200, 100000), T(2, 2, "2025-06-01", d.BUY, 200, 100000),
            T(3, 3, "2025-03-01", d.BUY, 100, 100000)]
    return compute_portfolio(inst, txns, None, today=TODAY), txns, inst


def test_trim_rows_carry_tax_if_sold_none_without_the_ledger():
    port, _, _ = _equity_book()
    res = optimizer.suggest(port, "conservative")
    trims = [r for r in res["rows"] if r["action"] == "trim"]
    assert trims, "an all-equity portfolio is trimmed for the conservative profile"
    assert all("tax_if_sold" in r and r["tax_if_sold"] is None for r in trims)
    assert all("sells" not in r for r in trims)
    assert "tax_total" not in res
    assert "taxes and exit loads are not included" in res["note"]
    assert all("tax_if_sold" not in r for r in res["rows"] if r["action"] != "trim")


def test_trim_rows_carry_the_planned_tax_with_the_ledger():
    port, txns, inst = _equity_book()
    plain = optimizer.suggest(port, "conservative")
    res = optimizer.suggest(port, "conservative", txns=txns, instruments=inst, slab_rate=0.30, today=TODAY)
    # the mix itself does not depend on the tax inputs
    assert [{k: v for k, v in r.items() if k not in ("tax_if_sold", "sells")} for r in res["rows"]] == \
        [{k: v for k, v in r.items() if k not in ("tax_if_sold", "sells")} for r in plain["rows"]]
    assert res["current"] == plain["current"] and res["turnover"] == plain["turnover"]
    trims = [r for r in res["rows"] if r["action"] == "trim"]
    assert trims and all(isinstance(r["tax_if_sold"], float) for r in trims)
    eq = next(r for r in trims if r["segment"] == d.SEG_EQ_IN)
    assert eq["sells"] and eq["sells"][0]["order"] == "loss" and eq["sells"][0]["instrument_id"] == 3
    assert sum(s["proceeds"] for s in eq["sells"]) <= -eq["delta_amount"] + 0.01
    # tax_total is one combined compute_tax delta over every planned sale
    sells = [s for r in trims for s in r["sells"]]
    extra = [T(100 + k, s["instrument_id"], TODAY.isoformat(), d.SELL, s["qty"], s["proceeds"])
             for k, s in enumerate(sells)]
    after_port = compute_portfolio(inst, txns + extra, None, today=TODAY)
    before = compute_tax(port, txns, inst, FY, 0.30, today=TODAY, with_opportunities=False)["estimate"]["total"]
    after = compute_tax(after_port, txns + extra, inst, FY, 0.30, today=TODAY,
                        with_opportunities=False)["estimate"]["total"]
    assert res["tax_total"] == pytest.approx(after - before, abs=0.02)
    assert res["tax_total"] == pytest.approx(sum(r["tax_if_sold"] for r in trims), abs=0.02)
    assert "estimated tax if sold" in res["note"]


def test_brief_risk_vital_input_is_unchanged_by_the_tax_inputs():
    # floors and the tax inputs never touch `current` (test_risk / test_assumptions pin it to mu_sigma)
    port, txns, inst = _equity_book()
    book = A.rated_book(port["positions"], A.effective_book(None))
    _, sigma = A.mu_sigma(A.weights_from_positions(port["positions"]), book)
    for kw in ({}, {"txns": txns, "instruments": inst, "today": TODAY}):
        assert optimizer.suggest(port, "balanced", **kw)["current"]["vol_pct"] == round(sigma * 100, 2)


def test_charges_note_reaches_the_sell_plan():
    from tracker.analytics.tax import plan_sales
    port, txns, inst = _equity_book()
    res = plan_sales(port, txns, inst, [], slab_rate=0.30, today=TODAY)
    assert res == {"legs": [], "tax_total": 0.0, "exemption_used": 0.0, "note": res["note"]}
    assert CHARGES_NOTE in res["note"] and "₹1.25 L exemption is used once" in res["note"]
    assert "30% slab incl. 4% cess" in res["note"]


# ── the base Book (AMENDMENTS R4) ──

def test_suggest_reads_the_base_book():
    port = seg_port({d.SEG_EQ_IN: 100000, d.SEG_FD: 60000, d.SEG_MF: 40000})
    plain = optimizer.suggest(port, "balanced")
    assert optimizer.suggest(port, "balanced", book=A.effective_book(None)) == plain
    b = A.effective_book(None)
    hot = {**b, "segments": {**b["segments"], d.SEG_EQ_IN: {**b["segments"][d.SEG_EQ_IN], "return_pct": 16.0}}}
    up = optimizer.suggest(port, "balanced", book=hot)
    assert up["current"]["return_pct"] > plain["current"]["return_pct"]
    assert up["current"]["vol_pct"] == plain["current"]["vol_pct"]          # only μ was overridden
