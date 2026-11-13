"""Forecasting, risk, allocation lab and SIP plans: offline unit tests plus API round trips."""
import math
import random
from datetime import date, timedelta

import pytest
from conftest import GUEST, USER, auth

from tracker import domain as d
from tracker import prices as px
from tracker.analytics import forecast, optimizer, quant
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


def test_portfolio_risk_var_beta_and_correlations():
    a = walk(100, 400, seed=3)
    bench = walk(20000, 400, vol=0.009, seed=4)
    # B follows A closely: the pair should be flagged as highly correlated
    b = [(dd, round(v * (1 + 0.002 * math.sin(i)), 4)) for i, (dd, v) in enumerate(a)]
    positions = [
        {"id": 1, "name": "A", "symbol": "A.NS", "segment": d.SEG_EQ_IN, "asset_class": d.EQUITY, "value": 60000, "is_open": True, "currency": "INR"},
        {"id": 2, "name": "B", "symbol": "B.NS", "segment": d.SEG_EQ_IN, "asset_class": d.EQUITY, "value": 30000, "is_open": True, "currency": "INR"},
        {"id": 3, "name": "FD", "symbol": None, "segment": d.SEG_FD, "asset_class": d.FIXED_DEPOSIT, "value": 90000, "is_open": True, "currency": "INR"},
    ]
    r = quant.portfolio_risk(positions, {"A.NS": a, "B.NS": b}, bench)
    assert r["exposed_pct"] == 50.0 and r["var_95"]["day"] > 0 and r["var_95"]["month"] > r["var_95"]["day"]
    assert r["correlation"]["highest"]["value"] > 0.95
    contrib = sum(h["risk_contribution_pct"] for h in r["holdings"])
    assert contrib == pytest.approx(100, abs=1.5)
    assert r["beta"] is not None
    empty = quant.portfolio_risk([positions[2]], {}, bench)
    assert empty["holdings"] == [] and empty["notes"]


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


def test_projection_blends_own_record_when_history_is_long_enough():
    base = forecast.blended_assumptions(PORT["segments"], None)
    own = forecast.blended_assumptions(PORT["segments"], {"days": 1000, "twr_annualised": 25.0, "volatility": 30.0})
    assert own["mu"] > base["mu"] and own["sigma"] > base["sigma"] and "record" in own["basis"]
    short = forecast.blended_assumptions(PORT["segments"], {"days": 300, "twr_annualised": 25.0, "volatility": 30.0})
    assert short["mu"] == base["mu"]


def test_stress_test_hits_equity_not_fds():
    st = forecast.stress_test(PORT, monthly_sip=5000)
    gfc = next(s for s in st["scenarios"] if s["key"] == "gfc")
    assert gfc["impact"] < 0 and all(r["segment"] != d.SEG_FD for r in gfc["rows"])
    assert gfc["impact_pct"] == pytest.approx((90000 * -0.52 + 20000 * -0.30) / 160000 * 100, abs=0.01)
    assert gfc["recovery_months"] and gfc["recovery_months"] > 0
    assert next(s for s in st["scenarios"] if s["key"] == "gold")["impact"] == 0
    assert st["worst"] == "gfc"


def test_retirement_plan_corpus_required_sip_and_fire():
    rp = forecast.retirement_plan(PORT, None, {"current_age": 35, "retire_age": 60, "life_expectancy": 85,
                                               "monthly_expenses": 50000, "monthly_sip": 20000, "return_pct": 10})
    assert rp["years_to_retire"] == 25 and rp["retirement_years"] == 25
    assert rp["monthly_expenses_at_retirement"] == pytest.approx(50000 * 1.06 ** 25, rel=1e-6)
    assert rp["corpus_needed"] > rp["monthly_expenses_at_retirement"] * 12 * 15
    # the required SIP, invested instead, reaches the corpus
    reach = forecast._fv(160000, rp["required_sip"], 0.10, 300)
    assert reach == pytest.approx(rp["corpus_needed"], rel=1e-4)
    assert rp["fire"]["number"] == pytest.approx(50000 * 12 / 0.035)
    assert rp["path"][0]["age"] == 35 and rp["path"][-1]["age"] == 85 and rp["path"][25]["phase"] == "retired"
    rich = forecast.retirement_plan({"totals": {"value": 5e7}, "segments": [{"segment": d.SEG_FD, "value": 5e7}]}, None,
                                    {"current_age": 50, "retire_age": 55, "monthly_expenses": 40000})
    assert rich["status"] == "on_track" and rich["fire"]["coasting"] and rich["runs_out_at"] is None


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
    assert p2p_principal == pytest.approx(12000 - 946, abs=1)                                # loan amortises to zero by December
    assert rows["2026-12"]["principal_back"] == 0 and any(e["kind"] == "p2p_close" for e in cf["events"])
    assert rows["2027-03"]["epf_interest"] > 0 and rows["2026-07"]["contributions"] == 5000
    assert rows["2026-07"]["sip_out"] == 10000 and rows["2027-01"]["sip_out"] == pytest.approx(11000)  # step-up after a year
    assert cf["totals"]["inflow"] > cf["totals"]["dividends"]


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


# ── optimizer ──

def test_optimizer_respects_caps_floors_and_locked_segments():
    port = {"totals": {"value": 200000}, "segments": [{"segment": d.SEG_EQ_IN, "value": 100000}, {"segment": d.SEG_FD, "value": 60000},
                                                      {"segment": d.SEG_EPF, "value": 40000}]}
    res = optimizer.suggest(port, "aggressive")
    rows = {r["segment"]: r for r in res["rows"]}
    assert rows[d.SEG_EPF]["suggested_pct"] == 20.0 and rows[d.SEG_EPF]["locked"]
    assert rows[d.SEG_FD]["suggested_pct"] >= 15.0  # FDs are 30% today: an aggressive mix still keeps at least half
    for p in res["profiles"]:
        assert sum(p["weights"].values()) == pytest.approx(100, abs=0.5)
        assert p["weights"].get(d.SEG_P2P, 0) <= 10.5 and p["weights"].get(d.SEG_COMMODITY, 0) <= 20.5
    vols = [p["vol_pct"] for p in res["profiles"]]
    assert vols == sorted(vols) and res["profiles"][-1]["return_pct"] >= res["profiles"][0]["return_pct"]
    assert res["frontier"] and res["current"]["closest_profile"]


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

    st = client.get("/api/forecast/stress", headers=h).json
    assert st["scenarios"] and st["market_exposed_pct"] > 0

    rp = client.get("/api/forecast/retirement?current_age=40&retire_age=60&monthly_expenses=60000", headers=h).json
    assert rp["inputs"]["monthly_sip"] == 5000 and rp["corpus_needed"] > 0 and rp["path"]
    assert client.put("/api/settings/retirementPlan", headers=h, json={"value": {"current_age": 40, "retire_age": 58, "monthly_expenses": 60000}}).status_code == 200
    assert client.get("/api/forecast/retirement", headers=h).json["inputs"]["retire_age"] == 58
    assert client.put("/api/settings/riskProfile", headers=h, json={"value": "bold"}).status_code == 400

    cf = client.get("/api/forecast/cashflow?months=6", headers=h).json
    assert len(cf["months"]) == 6 and cf["totals"]["sip_out"] >= 5000 * 6 - 1

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
