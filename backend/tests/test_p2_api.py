"""W7-B1: the P2 plan wiring (SPEC §6.10, §7.2; AMENDMENTS R3–R7, R11, K9–K17, L5).

POST /plan/compare, GET /plan?detail=1, GET /forecast?after_tax=1, GET /forecast/stress with plan_impact,
GET /sips history, /assumptions calibration, the base Book through every engine, and the per-member settings read.
Everything runs offline (`offline_prices`); counts and shapes are asserted, never times (A5).
"""
from datetime import date, timedelta

import pytest
from conftest import ADMIN, GUEST, OTHER, USER, auth
from test_p1_api import buy, full_p1

from tracker.analytics import assumptions as A

TODAY = date.today()


def compare(client, h, *scenarios):
    return client.post("/api/plan/compare", headers=h, json={"scenarios": list(scenarios)})


def rows(cmp):
    return {r["key"]: r for r in cmp["rows"]}


# ── POST /plan/compare (R5, R6) ──

def test_compare_shape_and_zero_deltas_for_the_baseline(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    base = client.get("/api/plan?detail=1", headers=h).json["baseline"]
    assert base == {"name": "Today's plan", "sip": 20000.0, "step": 0.0, "return": None, "retire_age": 55,
                    "lump_sums": [], "inflation_pct": None, "mix": None}
    r = compare(client, h, dict(base), {}, {"name": "Same again", "sip": None, "mix": None})
    assert r.status_code == 200, r.json
    c = r.json
    assert c["columns"] == ["Today's plan", "Today's plan", "Scenario 2", "Same again"]
    assert set(c) >= {"columns", "rows", "paths", "band", "labels", "sims", "assumptions", "honesty", "baseline",
                      "scenarios"}
    keys = [row["key"] for row in c["rows"]]
    assert keys[:7] == ["p10", "p50", "p90", "retire_age", "retirement", "lasts", "needed"]
    assert len(keys) == 8 and keys[7].startswith("goal:")
    for row in c["rows"]:
        assert row["deltas"] == [0, 0, 0, 0], row        # CRN: the baseline against itself is exactly 0
        assert len(row["values"]) == 4
    years = c["years"]
    assert rows(c)["p50"]["label"] == f"Typical in {years} yrs" and rows(c)["lasts"]["label"].startswith("Money lasts to ")
    assert years >= 20                                    # retire at 55 from 35
    assert len(c["labels"]) == years + 1 and len(c["paths"]) == 4 and len(c["band"]["p10"]) == years + 1
    assert c["sims"] == 1000 and c["honesty"]["p50"].endswith("1,000 simulated futures.") is not None
    assert c["baseline"] == base and c["scenarios"][2]["name"] == "Scenario 2"
    assert c["assumptions"]["hash"] == client.get("/api/assumptions", headers=h).json["hash"]


def test_compare_moves_the_right_way(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    c = compare(client, h, {"name": "More", "sip": 40000}, {"name": "Later", "retire_age": 58},
                {"name": "Lump", "lump_sums": [{"date": (TODAY + timedelta(days=400)).isoformat(),
                                                "amount": 500000}]}).json
    r = rows(c)
    for key, row in r.items():
        if row["format"] in ("pct", "inr") and key != "needed":
            assert row["deltas"][1] >= 0, (key, row)      # a higher SIP never hurts, path by path (CRN)
    assert r["p50"]["deltas"][1] > 0 and r["retirement"]["deltas"][1] >= 0
    assert r["retire_age"]["values"] == [55, 55, 58, 55]
    assert r["retirement"]["deltas"][2] >= 0              # retiring later
    # retire_age moves only the retirement rows: the projection and the goals are the baseline's, exactly
    assert all(row["deltas"][2] == 0 for k, row in r.items() if k in ("p10", "p50", "p90") or k.startswith("goal:"))
    assert r["p50"]["deltas"][3] > 400000 and r["p10"]["deltas"][3] > 0
    assert c["scenarios"][1]["sip"] == 40000.0 and c["scenarios"][2]["sip"] == 20000.0
    assert c["scenarios"][2]["retire_age"] == 58 and c["scenarios"][3]["lump_sums"][0]["amount"] == 500000.0


def test_compare_mix_equal_to_today_changes_nothing(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    segs = client.get("/api/portfolio", headers=h).json["segments"]
    total = sum(s["value"] for s in segs if s["value"] > 0)
    mix = {s["segment"]: s["value"] / total * 100 for s in segs if s["value"] > 0}
    c = compare(client, h, {"name": "Same mix", "mix": mix}).json
    for row in c["rows"]:
        if row["deltas"][1] is None:
            continue
        tol = 1.0 if row["format"] == "inr" else 0.1
        assert abs(row["deltas"][1]) <= tol, row
    other = compare(client, h, {"name": "All FD", "mix": {"Fixed Deposits": 100}}).json
    assert rows(other)["p50"]["deltas"][1] < 0            # FDs instead of equity: a lower typical outcome


def test_compare_limits_and_errors(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    assert compare(client, h, {}, {}, {}, {}, {}).status_code == 400
    bad = compare(client, h, 0)
    assert bad.status_code == 400 and "index 0" in bad.json["error"]           # nothing saved yet
    assert compare(client, h, True).status_code == 400
    assert compare(client, h, "Retire at 55").status_code == 400
    r = compare(client, h, {}, {"sip": -1})
    assert r.status_code == 400 and r.json["error"].startswith("Scenario 2: sip ")
    assert compare(client, h, {"retire_age": 30}).status_code == 400          # before the current age (35)
    assert client.post("/api/plan/compare", headers=h, json={"scenarios": {}}).status_code == 400
    saved = {"name": "Retire at 55", "sip": 60000, "step": 10, "return": None, "retire_age": 55,
             "lump_sums": [{"date": "2030-01-01", "amount": 500000}], "inflation_pct": 7, "mix": None}
    # written straight to the ledger, so this test never waits on W7-B2's planScenarios route (A2)
    app.extensions["ledger"].set_setting(USER, "user", "planScenarios", [saved])
    ok = compare(client, h, 0)
    assert ok.status_code == 200 and ok.json["columns"] == ["Today's plan", "Retire at 55"]
    assert compare(client, h, 1).status_code == 400


def test_guest_compare_cap_and_sims(app, client, offline_prices):
    full_p1(client, app, offline_prices)
    g = auth(GUEST, "guest")
    r = compare(client, g, {}, {}, {})
    assert r.status_code == 400 and r.json["error"] == "Guests can compare up to 2 scenarios"
    ok = compare(client, g, {"sip": 5000}, {})
    assert ok.status_code == 200 and ok.json["sims"] == 500
    assert compare(client, auth(USER, "user"), {}, {}, {}, {}).json["sims"] == 1000


# ── GET /plan?detail=1 (R7) ──

def test_plan_detail_adds_sensitivities_and_keeps_plan_unchanged(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    plain = client.get("/api/plan", headers=h).json
    assert "sensitivities" not in plain and "baseline" not in plain
    det = client.get("/api/plan?detail=1", headers=h).json
    assert {k: v for k, v in det.items() if k not in ("sensitivities", "baseline")} == plain
    s = {x["key"]: x for x in det["sensitivities"]}
    assert list(s) == ["sip", "retire", "returns", "inflation"]
    assert s["sip"]["label"] == "SIP +₹5,000/month" and s["sip"]["change"] == 5000
    assert s["sip"]["scenario"]["sip"] == 25000.0
    assert s["retire"]["label"] == "Retire 2 years later" and s["retire"]["scenario"]["retire_age"] == 57
    assert s["returns"]["change"] == -1 and s["inflation"]["change"] == 1
    assert s["inflation"]["scenario"]["inflation_pct"] == 7.0      # the Book's 6 + 1
    for x in s.values():
        assert set(x) == {"key", "label", "change", "retirement_pts", "worst_goal_pts", "worst_goal", "scenario"}
        assert x["worst_goal"] == {"id": plain["goals"][0]["id"], "name": plain["goals"][0]["name"]}  # one goal
        assert set(x["scenario"]) == {"name", "sip", "step", "return", "retire_age", "lump_sums", "inflation_pct", "mix"}
    assert s["sip"]["retirement_pts"] >= 0 and s["sip"]["worst_goal_pts"] >= 0
    assert s["returns"]["retirement_pts"] <= 0 and s["inflation"]["retirement_pts"] <= 0
    # "Try it": the sensitivity's scenario compares to the same delta
    c = compare(client, h, s["sip"]["scenario"]).json
    assert c["sims"] == 1000 and rows(c)["retirement"]["deltas"][1] >= 0
    assert client.get("/api/plan?detail=x", headers=h).status_code == 400


def test_plan_detail_without_a_retirement_plan(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    client.put("/api/settings/retirementPlan", headers=h, json={"value": {}})
    det = client.get("/api/plan?detail=1", headers=h).json
    assert det["baseline"]["sip"] == 10000.0 and det["baseline"]["retire_age"] is None   # the plans' total
    s = {x["key"]: x for x in det["sensitivities"]}
    assert all(x["retirement_pts"] is None for x in s.values())
    assert s["retire"]["scenario"] == det["baseline"]
    assert s["sip"]["worst_goal_pts"] >= 0


# ── /forecast (R3, D5), /forecast/stress (K11), /sips history, /assumptions calibration (K17) ──

def test_forecast_routes_the_plans_and_after_tax(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    f = client.get("/api/forecast", headers=h).json
    assert f["flows_basis"] == "plans" and f["monthly_sip"] == 10000 and f["sip_plans_total"] == 10000
    assert "after_tax" not in f["end"]
    typed = client.get("/api/forecast?sip=10000", headers=h).json
    assert typed["flows_basis"] == "mix"
    t = client.get("/api/forecast?after_tax=1", headers=h).json
    assert set(t["end"]["after_tax"]) >= {"p10", "p50", "p90", "note"}
    assert t["end"]["after_tax"]["p50"] <= t["end"]["p50"]
    assert t["end"]["p50"] == pytest.approx(f["end"]["p50"], rel=0.01)   # only FD accrual is taxed inside the paths
    assert client.get("/api/forecast?after_tax=maybe", headers=h).status_code == 400
    # /plan takes no after_tax (R3)
    assert "after_tax" not in str(client.get("/api/plan", headers=h).json.get("assumptions"))


def test_stress_detail_has_plan_impact_and_betas_only_from_a_warm_risk(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    st = client.get("/api/forecast/stress", headers=h).json
    pi = st["plan_impact"]
    assert pi is not None and set(pi) == {"retirement_before", "retirement_after", "goals"}
    assert pi["retirement_after"] <= pi["retirement_before"]
    assert pi["goals"] and pi["goals"][0]["after"] <= pi["goals"][0]["before"]
    assert all(hh["beta"] is None for s in st["scenarios"] for hh in s["holdings"])     # risk is cold
    svc, ledger = app.extensions["services"], app.extensions["ledger"]
    settings = ledger.get_settings(USER, "user")
    assert svc.stress(USER, settings)["plan_impact"] is None                            # the brief's stress
    assert client.get("/api/risk", headers=h).status_code == 200                       # warm the risk memo
    st2 = client.get("/api/forecast/stress", headers=h).json
    betas = [hh["beta"] for s in st2["scenarios"] for hh in s["holdings"] if hh["segment"] == "Equity (India)"]
    assert betas and all(b is not None for b in betas)
    assert any(hh["beta"] is not None for s in svc.stress(USER, settings)["scenarios"] for hh in s["holdings"])


def test_sips_history_is_twelve_months_oldest_first(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    s = client.get("/api/sips", headers=h).json
    hist = s["history"]
    assert len(hist) == 12 and hist[-1]["month"] == TODAY.strftime("%Y-%m")
    assert [x["month"] for x in hist] == sorted(x["month"] for x in hist)
    assert all(set(x) == {"month", "planned", "invested"} for x in hist)
    assert sum(x["planned"] for x in hist) >= 10000 * 6                  # the plan started 200 days ago
    assert len(s["adherence"]["plans"][0]["months"]) <= 7                 # adherence stays the 6-month block


def test_assumptions_calibration_only_when_performance_is_warm(app, client, offline_prices):
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS", qty=10, amount=30000)
    assert client.get("/api/assumptions", headers=h).json["calibration"] is None
    assert client.get("/api/performance", headers=h).status_code == 200
    cal = client.get("/api/assumptions", headers=h).json["calibration"]
    assert cal is not None and set(cal) >= {"matured", "inside", "coverage_pct", "target", "show", "rows"}
    assert cal["matured"] == 0 and cal["show"] is False


def test_retirement_is_funded_like_the_plan_and_one_path(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    p = client.get("/api/plan", headers=h).json
    ret = client.get("/api/forecast/retirement", headers=h).json
    assert ret["sources"] is not None and ret["flows_basis"] == "input" and ret["inputs"]["monthly_sip"] == 20000
    assert ret["probability"] == p["retirement"]["probability"]
    assert ret["current"] == pytest.approx(ret["sources"]["epf"] + ret["sources"]["nps"] + ret["sources"]["free"],
                                           abs=0.05)
    # the saved plan without a SIP: the plans run (L5), and the monthly SIP is the plans' total
    plan = {"current_age": 35, "retire_age": 55, "monthly_expenses": 40000}
    client.put("/api/settings/retirementPlan", headers=h, json={"value": plan})
    r2 = client.get("/api/forecast/retirement", headers=h).json
    assert r2["flows_basis"] == "plans" and r2["inputs"]["monthly_sip"] == 10000


# ── the base Book through the engines (R4) ──

def test_an_overridden_book_moves_every_engine(app, client, offline_prices, monkeypatch):
    h, _ = full_p1(client, app, offline_prices)
    before = {"p50": client.get("/api/forecast", headers=h).json["end"]["p50"],
              "goal": client.get("/api/plan", headers=h).json["goals"][0]["projection"]["probability"],
              "opt": client.get("/api/optimizer", headers=h).json["current"]["return_pct"]}
    real = A.effective_book

    def boosted(settings=None):
        b = real(settings)
        row = dict(b["segments"]["Equity (India)"])
        row.update(return_pct=row["return_pct"] + 4, source="override")
        return {**b, "segments": {**b["segments"], "Equity (India)": row}}

    monkeypatch.setattr(A, "effective_book", boosted)
    app.extensions["ledger"]._bump()                      # a fresh memo generation, as a settings write would make
    fc = client.get("/api/forecast", headers=h).json
    plan = client.get("/api/plan", headers=h).json
    opt = client.get("/api/optimizer", headers=h).json
    view = client.get("/api/assumptions", headers=h).json
    assert fc["end"]["p50"] > before["p50"]
    assert plan["goals"][0]["projection"]["probability"] > before["goal"]
    assert opt["current"]["return_pct"] > before["opt"]
    assert fc["assumptions"]["hash"] == view["hash"] == plan["retirement"]["assumptions"]["hash"]
    assert next(r for r in view["segments"] if r["key"] == "Equity (India)")["source"] == "override"


# ── per-member settings, the read path (R11) ──

def test_an_admin_viewing_a_member_reads_the_members_settings(app, client, offline_prices):
    ledger = app.extensions["ledger"]
    buy(client, auth(OTHER, "user"), name="Infosys", symbol="INFY.NS", qty=10, amount=15000)
    ledger.set_setting(OTHER, "user", "targetAllocation", {"Equity (India)": 40, "Fixed Deposits": 60})
    ledger.set_setting(ADMIN, "admin", "targetAllocation", {"Equity (India)": 90, "Mutual Funds": 10})
    member = client.get("/api/rebalance", headers=auth(ADMIN, "admin", view_as=OTHER)).json
    targets = {r["segment"]: r["target_pct"] for r in member["rows"]}
    assert targets.get("Fixed Deposits") == 60 and targets.get("Equity (India)") == 40
    family = client.get("/api/rebalance", headers=auth(ADMIN, "admin")).json
    ftargets = {r["segment"]: r["target_pct"] for r in family["rows"]}
    assert ftargets.get("Equity (India)") == 90 and ftargets.get("Mutual Funds") == 10
    svc = app.extensions["services"]
    with app.test_request_context(headers=auth(ADMIN, "admin", view_as=OTHER)):
        from flask import g
        g.email, g.role, g.scope = ADMIN, "admin", OTHER
        assert svc.settings_who() == (OTHER, "user") and svc.owner() == OTHER
        g.scope = None
        assert svc.settings_who() == (ADMIN, "admin") and svc.owner() == "__global__"
        g.email, g.role, g.scope = USER, "user", USER
        assert svc.settings_who() == (USER, "user")
