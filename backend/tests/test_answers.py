"""The question-led answers (analytics/answers.py) and GET /api/answers."""
from tracker import domain as d
from tracker.analytics import answers as an
from tracker.analytics import overview as ov
from tracker.analytics.portfolio import compute_portfolio

from conftest import USER, auth
from demo_book import BENCH_HIST, FX_HIST, TODAY, USD_INR, book

TARGETS = {"groupTargets": {d.GRP_EQ_IN: 30, d.GRP_EQ_GLOBAL: 10, d.GRP_MF: 30, d.GRP_P2P: 5, d.GRP_COMMODITY: 5,
                            d.GRP_EPF: 10, d.GRP_OTHERS: 10}}


def build(settings=None, goals=None, retirement=None, checks=None, tax=None):
    insts, txns = book()
    port = compute_portfolio(insts, txns, USD_INR, today=TODAY)
    view = ov.group_view(port, txns, settings or {}, BENCH_HIST, FX_HIST, today=TODAY)
    return view, port, an.build(view, port, tax, checks or [], goals or [], retirement, TODAY, 0.3)


def q(res, qid):
    return next(x for x in res["questions"] if x["id"] == qid)


def test_money_answer_reads_the_overview_totals():
    view, _, res = build()
    m = q(res, "money")
    assert m["answer"].startswith("Yes · ") if view["totals"]["gain"] > 0 else m["answer"].startswith("Not yet")
    assert f"{view['totals']['xirr']:.1f}% a year" in m["detail"]


def test_mix_without_targets_asks_for_them():
    _, _, res = build()
    assert q(res, "mix")["answer"] == "No targets set yet"
    assert not any(t["id"] == "flow:invest" for t in res["todo"])


def test_mix_names_the_largest_gap_and_the_invest_flow_fills_the_short_groups():
    view, _, res = build(TARGETS)
    off = sorted((g for g in view["groups"] if g["gap"] is not None and abs(g["gap"]) >= an.MIX_BAND), key=lambda g: -abs(g["gap"]))
    assert q(res, "mix")["answer"].startswith(off[0]["label"])
    inv = next(t for t in res["todo"] if t["id"] == "flow:invest")
    assert inv["link"].startswith("/flow/invest?amount=") and inv["flow"] == "invest"
    assert not any(t["id"].startswith("mix:under:") for t in res["todo"])     # one flow, not one item per group


def test_dragging_lists_late_loans_and_losers_largest_first():
    _, port, res = build()
    drag = res["dragging"]
    assert [x["amount"] for x in drag] == sorted((x["amount"] for x in drag), reverse=True)
    late = [p for p in port["positions"] if p.get("is_open") and p["asset_class"] == d.P2P and (p.get("overdue_days") or 0) > 30]
    assert {p["id"] for p in late} <= {x.get("id") for x in drag if x["kind"] == "p2p"}
    if drag:
        assert drag[0]["name"] in q(res, "dragging")["answer"]


def test_goals_short_by_a_monthly_amount():
    goals = [{"id": 1, "name": "House", "target_amount": 2500000, "target_date": "2029-03-01", "monthly_contribution": 10000,
              "projection": {"status": "at_risk", "required_sip": 16130, "current": 900000, "p50": 1960000,
                             "linked_monthly": 0, "probability": 52, "progress_pct": 36}},
             {"id": 2, "name": "School", "target_amount": 400000, "target_date": "2038-01-01", "monthly_contribution": 5000,
              "projection": {"status": "on_track", "required_sip": 3000, "current": 100000, "p50": 460000,
                             "linked_monthly": 0, "probability": 90, "progress_pct": 25}}]
    _, _, res = build(goals=goals)
    house = next(g for g in res["goals"] if g["name"] == "House")
    assert house["extra"] == 6200 and res["goals"][0]["name"] == "House"     # short ones first, rounded up to ₹100
    a = q(res, "goals")
    assert a["answer"] == "1 of 2 on track" and "House needs ₹6.2K more a month" == a["detail"]


def test_checks_become_one_todo():
    checks = [{"id": "p2p-no-split", "severity": "warn", "title": "Repayments without a split", "count": 2, "items": []}]
    _, _, res = build(checks=checks)
    item = next(t for t in res["todo"] if t["id"] == "data:checks")
    assert item["title"] == "Fix 2 data problems" and item["link"] == "/activity?tab=checks"


def test_answers_and_explain_all_api(client):
    h = auth(USER, "user")
    client.post("/api/transactions", headers=h, json={"type": "BUY", "date": "2025-01-10", "quantity": 10, "amount": 15000,
                                                      "instrument": {"asset_class": "mutual_fund", "name": "Index Fund"}})
    r = client.get("/api/answers", headers=h)
    assert r.status_code == 200
    ids = [x["id"] for x in r.json["questions"]]
    assert ids[:4] == ["money", "market", "mix", "goals"] and "dragging" in ids
    e = client.get("/api/overview/group/all", headers=h)
    assert e.status_code == 200 and e.json["label"] == "Everything" and "issues" in e.json
    assert client.get("/api/overview/group/nope", headers=h).status_code == 400


def test_retirement_plan_joins_the_goals(client):
    h = auth(USER, "user")
    client.post("/api/transactions", headers=h, json={"type": "BUY", "date": "2024-01-10", "quantity": 10, "amount": 150000,
                                                      "instrument": {"asset_class": "mutual_fund", "name": "Index Fund"}})
    assert client.get("/api/answers", headers=h).json["goals"] == []
    r = client.put("/api/settings/retirementPlan", headers=h, json={"value": {"current_age": 35, "retire_age": 55, "monthly_expenses": 50000}})
    assert r.status_code == 200
    goals = client.get("/api/answers", headers=h).json["goals"]
    ret = next(g for g in goals if g["kind"] == "retirement")
    assert ret["name"] == "Retire at 55" and ret["target"] > 0 and ret["status"] in ("on_track", "at_risk", "off_track", "achieved")
    if ret["status"] not in ("on_track", "achieved"):
        assert ret["extra"] > 0 and ret["extra"] % 100 == 0
