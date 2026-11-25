"""W4-B1: the P1 services wiring and endpoints (SPEC §7.2–§7.4, §7.7, §7.9; AMENDMENTS H2–H15).

Counts are asserted, never times (A5). Everything runs offline: `offline_prices` patches `ensure_history` and
`fetch_quotes` only, so `market_state` (which reads stored closes) gets its ^NSEI rows from `store_closes`.
"""
import json
from datetime import date, timedelta
from urllib.parse import quote

import pytest
from conftest import ADMIN, GUEST, OTHER, USER, auth

TODAY = date.today()


def buy(client, who, name="TCS", qty=10, amount=35000, day=None, ac="equity", **extra):
    return client.post("/api/transactions", headers=who, json={
        "type": "BUY", "date": (day or TODAY - timedelta(days=300)).isoformat(), "quantity": qty, "amount": amount,
        "instrument": {"asset_class": ac, "name": name, "market": "India", "sector": "IT", **extra}})


def status(client, who, aid, **body):
    return client.post(f"/api/actions/{quote(aid, safe='')}/status", headers=who, json=body)


def store_closes(ledger, symbol, points):
    """Write closes into price_history the way ensure_history stores them (no price_meta)."""
    rows = list(points)
    for i in range(0, len(rows), 200):
        part = rows[i:i + 200]
        ledger.db.execute("INSERT OR REPLACE INTO price_history (symbol, date, close) VALUES "
                          + ",".join(["(?,?,?)"] * len(part)), [v for dt, c in part for v in (symbol, dt, c)])


def full_p1(client, app, offline_prices, who=None, email=USER):
    """Every P1 source present (H15): a priced holding and an FD, a goal, an SIP plan, a saved retirementPlan, an
    emergencyFund, ≥ 200 stored ^NSEI closes, and a warm ALL performance."""
    h = who or auth(email, "user")
    tcs = buy(client, h, symbol="TCS.NS", qty=40, amount=120000).json["instrument_id"]
    client.post("/api/fixed-deposits", headers=h, json={"name": "HDFC FD", "amount": 100000, "rate": 7.1,
                                                        "date": (TODAY - timedelta(days=340)).isoformat(),
                                                        "maturity_date": (TODAY + timedelta(days=20)).isoformat()})
    fd = next(i for i in client.get("/api/portfolio", headers=h).json["positions"] if i["name"] == "HDFC FD")["id"]
    assert client.post("/api/goals", headers=h, json={
        "name": "House", "target_amount": 2_000_000, "target_date": (TODAY + timedelta(days=5 * 365)).isoformat(),
        "monthly_contribution": 10000, "allocation": {"Equity (India)": 100}}).status_code == 201
    sip = client.post("/api/sips", headers=h, json={
        "instrument_id": tcs, "amount": 10000, "frequency": "monthly", "day_of_month": min(TODAY.day, 28),
        "start_date": (TODAY - timedelta(days=200)).isoformat()})
    assert sip.status_code == 201
    plan = {"current_age": 35, "retire_age": 55, "monthly_expenses": 40000, "monthly_sip": 20000}
    assert client.put("/api/settings/retirementPlan", headers=h, json={"value": plan}).status_code == 200
    ef = {"months_target": 6, "monthly_expenses": 40000, "instrument_ids": [fd], "cash_amount": 50000}
    assert client.put("/api/settings/emergencyFund", headers=h, json={"value": ef}).status_code == 200
    store_closes(app.extensions["ledger"], "^NSEI", offline_prices["^NSEI"])
    assert client.get("/api/performance", headers=h).status_code == 200   # warm ALL (A16)
    return h, {"tcs": tcs, "fd": fd, "sip": sip.json["id"]}


@pytest.fixture
def counted(monkeypatch):
    import tracker.services as services
    calls = []
    real = services.compute_portfolio
    monkeypatch.setattr(services, "compute_portfolio", lambda *a, **k: calls.append(1) or real(*a, **k))
    return calls


# ── A5 / H15: counts ──

def test_cold_brief_with_every_p1_source_builds_the_portfolio_once(app, client, offline_prices, counted):
    h, ids = full_p1(client, app, offline_prices)
    counted.clear()
    br = client.get("/api/brief", headers=h)
    assert br.status_code == 200 and len(counted) == 1
    b = br.json
    # every P1 source reached the brief
    assert b["upcoming"] and b["upcoming"]["events"] and b["upcoming"]["inflow_90d"] is not None
    assert b["market_state"] and b["market_state"]["mode"] in ("normal", "volatile", "correction", "crash")
    assert b["pending"] == [] and b["assumptions_check"] is not None
    assert b["cushion"]["set"] is True and b["cushion"]["instrument_ids"] == [ids["fd"]]
    assert b["risk_est"]["vol_pct"] is not None
    assert b["assumptions"]["chip"] == b["assumptions"]["text"] and b["assumptions"]["hash"]
    assert any(r["kind"] == "retirement" for r in b["on_track"]["plan"]["rows"])
    habit = b["on_track"]["habit"]
    assert habit["adherence_6m_pct"] is not None or habit["status"] == "unset"
    assert {"next_due", "milestone", "pace"} <= set(habit)
    # warm: nothing is rebuilt, and /plan, /actions, /sips and /assumptions reuse the same portfolio
    assert client.get("/api/brief", headers=h).status_code == 200 and len(counted) == 1
    for path in ("/api/plan", "/api/actions", "/api/sips", "/api/assumptions", "/api/markets"):
        assert client.get(path, headers=h).status_code == 200, path
    assert len(counted) == 1


def test_brief_never_builds_history(app, client, offline_prices, monkeypatch):
    from tracker import prices as px
    h, _ = full_p1(client, app, offline_prices)
    app.extensions["ledger"]._bump()          # cold, with performance gone
    monkeypatch.setattr(px, "ensure_history", lambda *a, **k: pytest.fail("/brief must not build history"))
    b = client.get("/api/brief", headers=h).json
    assert b["pending"] == ["market"] and b["market_state"] is not None   # stored closes are a read (D6)


def test_a_status_post_does_not_rebuild_a_cached_plan(app, client, offline_prices, monkeypatch):
    import tracker.services as services
    h, _ = full_p1(client, app, offline_prices)
    calls = []
    real = services.goals_mod.funding_summary
    monkeypatch.setattr(services.goals_mod, "funding_summary", lambda *a, **k: calls.append(1) or real(*a, **k))
    first = client.get("/api/plan", headers=h).json
    assert len(calls) == 1
    aid = next(a["id"] for a in client.get("/api/actions", headers=h).json["actions"])
    ledger = app.extensions["ledger"]
    rev = ledger.actions_rev
    assert status(client, h, aid, status="snoozed").status_code == 200 and ledger.actions_rev == rev + 1
    assert client.get("/api/plan", headers=h).json == first and len(calls) == 1


# ── /plan (H6) ──

PLAN_KEYS = {"status", "rows", "goals", "retirement", "funding", "cushion", "sip", "counts", "deltas", "assumptions",
             "empty", "notes"}


def test_plan_shape_sip_block_counts_and_one_rule_with_the_brief(app, client, offline_prices):
    h, ids = full_p1(client, app, offline_prices)
    p = client.get("/api/plan", headers=h).json
    assert set(p) == PLAN_KEYS and p["empty"] is False and p["notes"] == []
    goal, ret = p["goals"][0], p["retirement"]
    assert ret is not None and ret["inputs"]["retire_age"] == 55
    assert set(p["funding"]) >= {"total", "cushion", "earmarked", "free", "over_allocated"}
    assert p["funding"]["cushion"]["instrument_ids"] == [ids["fd"]]
    assert p["cushion"]["set"] is True
    # H6 sums
    req, contrib = goal["projection"]["required_sip"], goal["monthly_contribution"]
    assert p["sip"]["plans_monthly_total"] == 10000
    assert p["sip"]["goals_monthly_contribution"] == contrib
    assert p["sip"]["needed_monthly"] == pytest.approx(req + ret["required_sip"], abs=0.01)
    assert p["sip"]["gap_monthly"] == pytest.approx(max(0, req - contrib) + max(0, ret["required_sip"] - 20000), abs=0.01)
    assert p["counts"]["total"] == 2 and sum(p["counts"][k] for k in ("on_track", "at_risk", "off_track", "achieved",
                                                                      "unknown")) == 2
    assert [r["kind"] for r in p["rows"]] and {r["kind"] for r in p["rows"]} == {"goal", "retirement"}
    assert p["status"]["headline"].startswith("0 of 1 goal on track") or p["status"]["headline"].startswith("1 of 1 goal")
    assert " · retirement " in p["status"]["headline"] and p["status"]["headline"].endswith("% likely")
    # the shell's Plan dot (brief) and /plan follow one rule
    b = client.get("/api/brief", headers=h).json
    assert b["on_track"]["plan"]["status"] == p["status"]["status"]
    assert b["on_track"]["plan"]["rows"] == p["rows"]


def test_plan_sip_counts_a_linked_goal_at_its_linked_plans():
    """K15 (W7 review fixes): a goal funded by linked plans is projected on `linked_monthly`, so that is what it
    contributes; its own `monthly_contribution` (0 here) must not make its whole required SIP a gap."""
    from tracker.services import Services
    sips = [{"amount": 15000, "frequency": "monthly", "active": 1, "start_date": "2024-01-05", "goal_id": 1}] * 2
    goals = [{"id": 1, "name": "House", "monthly_contribution": 0,
              "projection": {"status": "at_risk", "required_sip": 35299.0, "contribution_source": "linked",
                             "linked_monthly": 30000.0}},
             {"id": 2, "name": "Trip", "monthly_contribution": 2000,
              "projection": {"status": "at_risk", "required_sip": 5000.0, "contribution_source": "goal",
                             "linked_monthly": 0}}]
    got = Services._plan_sip(Services, sips, goals, None)
    assert got == {"plans_monthly_total": 30000.0, "goals_monthly_contribution": 32000.0, "needed_monthly": 40299.0,
                   "gap_monthly": 8299.0}


def test_plan_deltas_against_the_30_day_snapshot(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    ledger = app.extensions["ledger"]
    p = client.get("/api/plan", headers=h).json
    gid = str(p["goals"][0]["id"])
    then = (TODAY - timedelta(days=31)).isoformat()
    ledger.kpi_snapshot_write(USER, then, {"value": 1.0, "goal_probs": {gid: 1.0, "retirement": 2.0}})
    ledger._bump()
    p = client.get("/api/plan", headers=h).json
    goal_row = next(r for r in p["rows"] if r["kind"] == "goal")
    ret_row = next(r for r in p["rows"] if r["kind"] == "retirement")
    assert p["deltas"] == {gid: goal_row["delta"], "retirement": ret_row["delta"]}
    assert p["deltas"][gid] == pytest.approx(goal_row["probability"] - 1.0, abs=0.05)


def test_plan_empty_and_family(app, client, offline_prices):
    empty = client.get("/api/plan", headers=auth(OTHER, "user")).json
    assert empty["empty"] is True and empty["status"] == {"status": "unset", "headline": "No goals yet"}
    assert empty["retirement"] is None and empty["counts"]["total"] == 0 and empty["deltas"] == {}
    h, _ = full_p1(client, app, offline_prices)
    # no saved plan: no retirement row and no age-30 default (§7.8)
    assert client.put("/api/settings/retirementPlan", headers=h, json={"value": {}}).status_code == 200
    p = client.get("/api/plan", headers=h).json
    assert p["retirement"] is None and not any(r["kind"] == "retirement" for r in p["rows"])
    fam = client.get("/api/plan", headers=auth(ADMIN, "admin")).json
    assert fam["status"]["headline"].endswith(" · family plan")


# ── the Book hash (H5) and /assumptions (H7) ──

def test_hash_is_stable_and_equal_across_forward_payloads(app, client, offline_prices):
    from tracker.analytics.assumptions import book_hash, rated_book
    h, _ = full_p1(client, app, offline_prices)
    plan = client.get("/api/plan", headers=h).json
    view = client.get("/api/assumptions", headers=h).json
    fc = client.get("/api/forecast", headers=h).json
    ret = client.get("/api/forecast/retirement", headers=h).json
    br = client.get("/api/brief", headers=h).json
    hashes = {plan["assumptions"]["hash"], view["hash"], view["portfolio"]["hash"], fc["assumptions"]["hash"],
              ret["assumptions"]["hash"], br["assumptions"]["hash"], plan["retirement"]["assumptions"]["hash"]}
    assert len(hashes) == 1
    positions = client.get("/api/portfolio", headers=h).json["positions"]
    assert hashes == {book_hash(rated_book(positions))}
    # stable across calls (and across a rebuild)
    app.extensions["ledger"]._bump()
    assert client.get("/api/assumptions", headers=h).json["hash"] == view["hash"]
    assert client.get("/api/plan", headers=h).json["assumptions"]["hash"] == view["hash"]


def test_assumptions_view_shape(app, client, offline_prices):
    from tracker.analytics.assumptions import CORR_NOTE, KEYS
    h, _ = full_p1(client, app, offline_prices)
    v = client.get("/api/assumptions", headers=h).json
    assert {"segments", "corr", "portfolio", "inflation_pct", "risk_free_pct", "typical_bands", "hash", "honesty",
            "note"} <= set(v)
    assert "proposed" not in v
    assert [s["key"] for s in v["segments"]] == list(KEYS)
    debt = next(s for s in v["segments"] if s["key"] == "MF_DEBT")
    assert debt["label"] == "Mutual Funds (debt)" and debt["return_pct"] == 7.0
    fd = next(s for s in v["segments"] if s["key"] == "Fixed Deposits")
    assert fd["source"] == "holding rates" and fd["return_pct"] == 7.1 and fd["value"] > 0
    assert sum(s["weight_pct"] for s in v["segments"]) == pytest.approx(100, abs=0.05)
    assert all(s["typical_pct"] <= s["return_pct"] for s in v["segments"])
    assert len(v["corr"]["matrix"]) == 9 and all(len(r) == 9 for r in v["corr"]["matrix"])
    assert v["corr"]["note"] == CORR_NOTE and v["corr"]["labels"][-1] == "Mutual Funds (debt)"
    assert [b["years"] for b in v["typical_bands"]] == [1, 3, 5]
    assert all(b["lo"] < b["typical"] < b["hi"] for b in v["typical_bands"])
    assert v["typical_bands"][0]["typical"] == pytest.approx(v["portfolio"]["typical_pct"], abs=0.01)
    assert "1,000" in v["honesty"]["p50"] and v["note"] == "Long-run assumptions, not predictions."
    assert v["inflation_pct"] == 6.0 and v["risk_free_pct"] == 6.5
    # the drawer lists every label: none may carry a raw {template} placeholder (W4 review)
    assert not [k for k, s in v["honesty"].items() if "{" in s or "}" in s]
    assert v["honesty"]["probability"] == "Chances are given as N of 100 simulated futures"


def test_assumptions_with_no_holdings_match_the_forecast(app, client, offline_prices):
    """W4 review: goals but nothing held. The chip and the bands are the diversified mutual fund the forecast
    assumes (same hash), not '0.0% avg · 0.0% typical · ±0.0%'."""
    h = auth(USER, "user")
    assert client.post("/api/goals", headers=h, json={
        "name": "House", "target_amount": 2_000_000, "target_date": (TODAY + timedelta(days=5 * 365)).isoformat(),
        "monthly_contribution": 10000, "allocation": {"Equity (India)": 100}}).status_code == 201
    fc = client.get("/api/forecast", headers=h).json["assumptions"]
    plan = client.get("/api/plan", headers=h).json["assumptions"]
    view = client.get("/api/assumptions", headers=h).json
    for chip in (plan, view["portfolio"]):
        assert chip["return_pct"] == fc["return_pct"] == 11.0 and chip["volatility_pct"] == fc["volatility_pct"]
        assert chip["basis"] == fc["basis"] == "diversified mutual fund (no holdings yet)"
        assert chip["hash"] == fc["hash"] and chip["text"].startswith("11.0% avg")
    assert all(b["lo"] < b["typical"] < b["hi"] for b in view["typical_bands"])
    assert view["typical_bands"][0]["typical"] == pytest.approx(view["portfolio"]["typical_pct"], abs=0.01)
    assert sum(s["weight_pct"] for s in view["segments"]) == 0     # the rows still show what is held: nothing


def test_assumptions_mix(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    ok = client.get("/api/assumptions", headers=h, query_string={"mix": "Equity (India):60,Fixed Deposits:40"})
    assert ok.status_code == 200
    prop = ok.json["proposed"]
    assert prop["text"] == prop["chip"] and prop["hash"] == ok.json["hash"]
    allin = client.get("/api/assumptions", headers=h, query_string={"mix": "Equity (India):100"}).json["proposed"]
    assert allin["return_pct"] == 12.0 and allin["volatility_pct"] == 18.0
    assert prop["volatility_pct"] < allin["volatility_pct"]
    for bad in ("Equity (India):60", "Bonds:100", "Equity (India):101,P2P:-1", "Equity (India):abc",
                "Equity (India)", "Equity (India):50,Equity (India):50"):
        assert client.get("/api/assumptions", headers=h, query_string={"mix": bad}).status_code == 400, bad
    assert client.get("/api/assumptions", headers=h,
                      query_string={"mix": "Equity (India):60.3,Fixed Deposits:40"}).status_code == 200   # ± 0.5


# ── /tax/what-if (H8, §7.9) ──

def _whatif(client, who, **params):
    return client.get("/api/tax/what-if", headers=who, query_string=params)


def test_what_if_cases(app, client):
    h = auth(USER, "user")
    lt = buy(client, h, name="Infy LT", qty=100, amount=100000, day=TODAY - timedelta(days=400)).json["instrument_id"]
    st = buy(client, h, name="Infy ST", qty=100, amount=100000, day=TODAY - timedelta(days=60)).json["instrument_id"]
    soon = buy(client, h, name="Infy soon", qty=100, amount=100000, day=TODAY - timedelta(days=340)).json["instrument_id"]
    r = _whatif(client, h, instrument_id=lt, qty=100, price=1500)
    assert r.status_code == 200 and r.json["tax_now"] == 0 and r.json["gain"] == pytest.approx(50000)
    r = _whatif(client, h, instrument_id=st, qty=100, price=1500).json
    assert r["tax_now"] == pytest.approx(10400) and r["lots"][0]["term"] == "STCG"
    w = _whatif(client, h, instrument_id=soon, qty=100, price=1500).json["wait"]
    assert w is not None and w["saving"] > 0
    held = _whatif(client, h, instrument_id=st, qty=101, price=1500)
    assert held.status_code == 400 and "hold only" in held.json["error"]
    # a guest may ask: it is a read
    assert _whatif(client, auth(GUEST, "guest"), instrument_id=lt, qty=10, price=1500).status_code == 200


def test_what_if_elss_locked_and_usd_fx(app, client):
    h = auth(USER, "user")
    elss = buy(client, h, name="Tax Saver", ac="mutual_fund", qty=100, amount=5000,
               day=TODAY - timedelta(days=100), category="ELSS").json["instrument_id"]
    locked = _whatif(client, h, instrument_id=elss, qty=10, price=60)
    assert locked.status_code == 400 and "lock" in locked.json["error"].lower()
    ledger = app.extensions["ledger"]
    ledger.set_system_value("fx:USDINR", json.dumps({"price": 90.0, "at": "2026-01-01T00:00:00+00:00"}))
    ledger._bump()
    usd = client.post("/api/transactions", headers=h, json={
        "type": "BUY", "date": (TODAY - timedelta(days=100)).isoformat(), "quantity": 2, "amount": 17000, "amount_fc": 200,
        "instrument": {"asset_class": "equity", "name": "NVDA", "market": "USA", "currency": "USD"}}).json["instrument_id"]
    r = _whatif(client, h, instrument_id=usd, qty=1, price=110).json
    assert r["currency"] == "USD" and r["proceeds"] == pytest.approx(110 * 90) and r["amount_fc"] == pytest.approx(110)


def test_what_if_parameter_errors(client):
    h = auth(USER, "user")
    iid = buy(client, h, name="Infy", qty=100, amount=100000).json["instrument_id"]
    past = (TODAY - timedelta(days=3)).isoformat()
    for params in ({"qty": 1}, {"instrument_id": "x", "qty": 1}, {"instrument_id": iid}, {"instrument_id": iid, "qty": 0},
                   {"instrument_id": iid, "qty": "abc"}, {"instrument_id": iid, "qty": "nan"},
                   {"instrument_id": iid, "qty": 1, "price": -5}, {"instrument_id": iid, "qty": 1, "date": "2026-13-01"},
                   {"instrument_id": iid, "qty": 1, "price": 10, "date": past},
                   {"instrument_id": 99999, "qty": 1, "price": 10}):
        assert _whatif(client, h, **params).status_code == 400, params
    other = buy(client, auth(OTHER, "user"), name="Other's", qty=5, amount=500).json["instrument_id"]
    assert _whatif(client, h, instrument_id=other, qty=1, price=10).status_code == 400   # not in this scope


def test_tax_carries_the_harvest_plan(client):
    h = auth(USER, "user")
    buy(client, h, name="Infy", qty=100, amount=100000, day=TODAY - timedelta(days=400), last_price=1500)
    opp = client.get("/api/tax", headers=h).json["opportunities"]
    assert {"rows", "total_gain", "future_tax_saved", "note"} <= set(opp["harvest_plan"])


# ── emergencyFund (H10) ──

def test_emergency_fund_validation(client):
    h = auth(USER, "user")
    mine = buy(client, h, name="Liquid Fund", ac="mutual_fund", category="Liquid", qty=100, amount=50000).json["instrument_id"]
    theirs = buy(client, auth(OTHER, "user"), name="Other's FD", qty=1, amount=1000).json["instrument_id"]

    def put(value):
        return client.put("/api/settings/emergencyFund", headers=h, json={"value": value})

    bad = put({"instrument_ids": [theirs]})
    assert bad.status_code == 400 and f"Instrument {theirs} is not in this portfolio" in bad.json["error"]
    for value in ("six months", {"months_target": 2}, {"months_target": 25}, {"months_target": 6.5},
                  {"monthly_expenses": -1}, {"monthly_expenses": 2e7}, {"cash_amount": 2e8},
                  {"instrument_ids": "1"}, {"instrument_ids": [True]}, {"instrument_ids": ["1"]}):
        assert put(value).status_code == 400, value
    ok = put({"monthly_expenses": 40000, "instrument_ids": [mine, mine], "cash_amount": 10000, "colour": "red"})
    assert ok.status_code == 200
    assert ok.json["value"] == {"months_target": 6, "monthly_expenses": 40000.0, "instrument_ids": [mine],
                                "cash_amount": 10000.0}
    s = client.get("/api/settings", headers=h).json
    assert s["emergencyFund"]["instrument_ids"] == [mine]
    sug = s["emergencyFundSuggest"]
    assert [c["instrument_id"] for c in sug["candidates"]] == [mine] and sug["candidates_amount"] > 0
    assert sug["monthly_expenses_hint"] is None
    client.put("/api/settings/retirementPlan", headers=h, json={"value": {"monthly_expenses": 55000}})
    assert client.get("/api/settings", headers=h).json["emergencyFundSuggest"]["monthly_expenses_hint"] == 55000
    assert put({"instrument_ids": [mine]}).status_code == 200
    assert client.put("/api/settings/emergencyFund", headers=auth(GUEST, "guest"), json={"value": {}}).status_code == 403


def test_brief_cushion_vital_reads_the_emergency_fund(app, client, offline_prices):
    h, ids = full_p1(client, app, offline_prices)
    cushion = next(v for v in client.get("/api/brief", headers=h).json["vitals"] if v["key"] == "cushion")
    assert cushion["status"] in ("good", "watch", "act") and "months of expenses" in cushion["value"]


# ── /sips (H9) and skipping an instalment (A11, H2) ──

def test_sips_arriving_equals_the_brief_deploy(app, client, offline_prices):
    h, ids = full_p1(client, app, offline_prices)
    s = client.get("/api/sips", headers=h).json
    assert set(s) == {"plans", "monthly_total", "adherence", "arriving", "arriving_total", "history"}   # R3
    assert s["monthly_total"] == 10000 and s["adherence"]["plans"][0]["id"] == ids["sip"]
    b = client.get("/api/brief", headers=h).json
    assert s["arriving_total"] == b["deploy"]["suggested"] and s["arriving_total"] > 0
    assert [a["amount"] for a in s["arriving"]] == [x["amount"] for x in b["deploy"]["sources"]]
    fd = next(a for a in s["arriving"] if a["kind"] == "fd")
    assert fd["link"] == "/fixed-deposits" and fd["instrument_id"] == ids["fd"]
    assert set(fd) == {"kind", "label", "date", "amount", "instrument_id", "link"}


def test_skipping_an_instalment_shows_as_skipped_without_a_ledger_bump(app, client, offline_prices):
    h, ids = full_p1(client, app, offline_prices)
    ledger = app.extensions["ledger"]
    months = client.get("/api/sips", headers=h).json["adherence"]["plans"][0]["months"]
    inst = next(m for m in months if m["status"] in ("missed", "upcoming"))
    kind = "missed" if inst["status"] == "missed" else "due"
    version = ledger._version
    r = status(client, h, f"sip:{kind}:{ids['sip']}:{inst['due']}", status="dismissed", reason="skipped")
    assert r.status_code == 200
    after = client.get("/api/sips", headers=h).json["adherence"]["plans"][0]["months"]
    assert next(m for m in after if m["due"] == inst["due"])["status"] == "skipped"
    assert ledger._version == version
    # the plans rule no longer offers that instalment
    acts = client.get("/api/actions", headers=h).json
    assert not any(a["id"].endswith(f":{ids['sip']}:{inst['due']}") for a in acts["actions"] + acts["planned"])
    # a dismissal with another reason is not a skip
    other = next((m for m in after if m["status"] in ("missed", "upcoming")), None)
    if other is not None:
        k = "missed" if other["status"] == "missed" else "due"
        status(client, h, f"sip:{k}:{ids['sip']}:{other['due']}", status="dismissed", reason="not relevant")
        again = client.get("/api/sips", headers=h).json["adherence"]["plans"][0]["months"]
        assert next(m for m in again if m["due"] == other["due"])["status"] != "skipped"


def test_actions_carry_adherence_upcoming_and_twelve_month_follow_through(app, client, offline_prices):
    h, ids = full_p1(client, app, offline_prices)
    svc, ledger = app.extensions["services"], app.extensions["ledger"]
    settings = ledger.get_settings(USER, "user")
    acts = client.get("/api/actions", headers=h).json
    adh12 = svc.adherence(USER, settings, USER, months=12)
    assert acts["follow_through"]["sip_adherence_12m"] == adh12["adherence_6m_pct"]
    built = svc._actions_build(USER, settings, USER)
    assert built["adherence"] is svc.adherence(USER, settings, USER) and built["upcoming"] is not None
    # A9: with adherence present the sip:missed insight is not mapped; every sip action names an instalment
    assert all(a["id"].count(":") == 3 for a in acts["actions"] if a["id"].startswith(("sip:missed:", "sip:due:")))
    ctx = svc.context(USER, settings)
    assert ctx["adherence"] is None   # H2: never assigned into the memoised context


# ── H13: one insight list ──

def test_bell_and_actions_share_one_insight_build(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    svc, ledger = app.extensions["services"], app.extensions["ledger"]
    settings = ledger.get_settings(USER, "user")
    assert client.get("/api/actions", headers=h).status_code == 200
    quick = svc.insights(USER, settings, with_performance=False)["insights"]
    assert quick is svc._action_inputs(USER, settings)["insights"]
    assert client.get("/api/insights?performance=0", headers=h).json["insights"] == quick
    assert not any(a["id"].startswith("perf:") for a in client.get("/api/actions", headers=h).json["actions"])


def test_open_concentration_rows_reach_build_insights(app, client, offline_prices, monkeypatch):
    import tracker.services as services
    h = auth(USER, "user")
    iid = buy(client, h, symbol="TCS.NS").json["instrument_id"]
    ledger = app.extensions["ledger"]
    ledger.set_action_status(USER, f"concentration:{iid}", "open")
    ledger.set_action_status(USER, "sector:IT", "planned")
    ledger.set_action_status(USER, "concentration:999", "dismissed")
    seen = {}
    real = services.build_insights
    monkeypatch.setattr(services, "build_insights", lambda *a, **k: seen.update(k) or real(*a, **k))
    assert client.get("/api/actions", headers=h).status_code == 200
    assert sorted(seen["open_ids"]) == sorted([f"concentration:{iid}", "sector:IT"])
    assert {"cushion", "risk_est", "stress", "snapshot_then", "book"} <= set(seen) and "adherence" not in seen


# ── market state (H4) ──

def test_markets_and_brief_market_state_need_200_stored_closes(app, client, offline_prices, monkeypatch):
    from tracker import markets as mk
    monkeypatch.setattr(mk, "build_overview", lambda *a, **k: {"indices": [], "ideas": {}})
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    ledger = app.extensions["ledger"]
    store_closes(ledger, "^NSEI", offline_prices["^NSEI"][-150:])
    m = client.get("/api/markets", headers=h).json
    assert "market_state" in m and m["market_state"] is None and m["indices"] == []
    assert client.get("/api/brief", headers=h).json["market_state"] is None
    store_closes(ledger, "^NSEI", offline_prices["^NSEI"])
    ledger._bump()
    m = client.get("/api/markets", headers=h).json
    assert m["market_state"]["nifty"]["price"] == pytest.approx(offline_prices["^NSEI"][-1][1], abs=0.01)
    assert client.get("/api/brief", headers=h).json["market_state"] == m["market_state"]


def test_stale_stored_closes_give_no_market_state(app, client, offline_prices, monkeypatch):
    """W4 review: closes that stopped 60 days ago, the last week 14% under the high, are not "Nifty is 14% below
    its high" today: no market_state, no market context line (and so no Markets dot)."""
    from conftest import walk
    from tracker import markets as mk
    monkeypatch.setattr(mk, "build_overview", lambda *a, **k: {"indices": [], "ideas": {}})
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    end = TODAY - timedelta(days=60)
    while end.weekday() >= 5:   # the walk has weekday closes only; end on one so the ages below are exact
        end -= timedelta(days=1)
    pts = walk(24000, 300, drift=0.0, vol=0.001, seed=3, end=end)
    pts = pts[:-5] + [(dt, round(max(c for _, c in pts) * 0.86, 2)) for dt, c in pts[-5:]]
    store_closes(app.extensions["ledger"], "^NSEI", pts)
    assert mk.market_state(pts, None, None, end)["mode"] == "crash"     # fresh on its own day (w1 -14%)
    assert mk.market_state(pts, None, None, end + timedelta(days=mk.STATE_MAX_AGE_DAYS))["mode"] == "crash"
    assert mk.market_state(pts, None, None, end + timedelta(days=mk.STATE_MAX_AGE_DAYS + 1)) is None
    b = client.get("/api/brief", headers=h).json
    assert b["market_state"] is None and (b["context_line"] or {}).get("kind") != "market"
    assert client.get("/api/markets", headers=h).json["market_state"] is None


def test_a_correction_sets_the_brief_context_line(app, client, offline_prices):
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    pts = [(d_, c) for d_, c in offline_prices["^NSEI"][-300:]]
    high = max(c for _, c in pts)
    for i in range(1, 7):                             # a week flat at 14% below the 52-week high: correction, not crash
        pts[-i] = (pts[-i][0], round(high * 0.86, 2))
    store_closes(app.extensions["ledger"], "^NSEI", pts)
    app.extensions["ledger"]._bump()
    b = client.get("/api/brief", headers=h).json
    assert b["market_state"]["mode"] == "correction"
    assert b["context_line"]["kind"] == "market" and b["context_line"]["link"] == "/markets"


# ── snapshots (H12), rebalance (D2), outlook (H14) ──

def test_snapshot_adds_book_hash_and_projection_once(app, client, offline_prices, monkeypatch):
    import tracker.services as services
    h, _ = full_p1(client, app, offline_prices)
    calls = []
    real = services.forecast.project_portfolio
    monkeypatch.setattr(services.forecast, "project_portfolio", lambda *a, **k: calls.append(k) or real(*a, **k))
    b = client.get("/api/brief", headers=h).json
    client.get(f"/api/brief?since={TODAY.isoformat()}", headers=h)    # another memo entry, same day: no new write
    assert len(calls) == 1 and calls[0]["years"] == 1 and calls[0]["monthly_sip"] == 0 and calls[0]["sims"] == 1000
    ledger = app.extensions["ledger"]
    data = json.loads(ledger.db.one("SELECT data FROM kpi_snapshots WHERE owner = ?", (USER,))["data"])
    assert data["book_hash"] == b["assumptions"]["hash"]
    p = data["projection_1y"]
    assert set(p) == {"p10", "p50", "p90"} and p["p10"] < p["p50"] < p["p90"] and 0.5 < p["p50"] < 1.5
    assert "projection_1y" not in app.extensions["services"].brief(USER, ledger.get_settings(USER, "user"), None, USER)


def test_rebalance_months_to_fix(app, client, offline_prices):
    h, _ = full_p1(client, app, offline_prices)
    assert client.get("/api/rebalance", headers=h).json["months_to_fix"] is None    # no targets: the plan errors
    client.put("/api/settings/targetAllocation", headers=h, json={"value": {"Equity (India)": 20, "Fixed Deposits": 80}})
    plan = client.get("/api/rebalance", headers=h).json
    svc, ledger = app.extensions["services"], app.extensions["ledger"]
    settings = ledger.get_settings(USER, "user")
    need = plan["money_to_fix_without_selling"]
    inflow = svc.upcoming(USER, settings, USER)["inflow_90d"] or 0
    import math
    assert need > 0 and plan["months_to_fix"] == math.ceil(need / max(1, 10000 + inflow / 3))
    assert svc._months_to_fix(USER, settings, {"money_to_fix_without_selling": 0}) == 0
    assert svc._months_to_fix(USER, settings, {"error": "Set a target allocation first"}) is None


def test_outlook_cone_uses_the_debt_fund_book_row(client, offline_prices):
    h = auth(USER, "user")
    iid = buy(client, h, name="Gilt Fund", ac="mutual_fund", category="Debt", symbol="INFY.NS").json["instrument_id"]
    out = client.get(f"/api/instruments/{iid}/outlook", headers=h).json
    assert out["available"] is True and out["assumptions"]["drift_pct"] == 7.0   # MF_DEBT, not the 11% MF row
