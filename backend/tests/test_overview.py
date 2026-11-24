"""The group read model (analytics/overview.py) and its API."""
from datetime import date

import pytest

from tracker import domain as d
from tracker.analytics import overview as ov
from tracker.analytics.portfolio import compute_portfolio
from tracker.analytics.xirr import xirr

from conftest import ADMIN, USER, auth
from demo_book import BENCH_HIST, FX_HIST, TODAY, USD_INR, book


def view(settings=None):
    insts, txns = book()
    port = compute_portfolio(insts, txns, USD_INR, today=TODAY)
    return port, txns, ov.group_view(port, txns, settings or {}, BENCH_HIST, FX_HIST, today=TODAY)


def test_groups_partition_the_portfolio():
    port, _, v = view()
    assert {g["key"] for g in v["groups"]} == set(d.GROUPS)
    assert sum(g["value"] for g in v["groups"]) == pytest.approx(port["totals"]["value"], abs=0.05)
    assert sum(g["pct"] for g in v["groups"]) == pytest.approx(100, abs=0.05)
    by = {g["key"]: g for g in v["groups"]}
    # the USD wallet is the cash of the US broker account, so it sits with Global stocks
    assert by[d.GRP_EQ_GLOBAL]["value"] == pytest.approx(102544 + 7956, abs=0.5)
    # FDs and NPS are Others
    assert by[d.GRP_OTHERS]["value"] == pytest.approx(111810.97 + 53130.8 + 52000, abs=0.5)


def test_group_return_matches_its_segment_when_one_to_one():
    port, _, v = view()
    seg = {s["segment"]: s for s in port["segments"]}
    by = {g["key"]: g for g in v["groups"]}
    assert by[d.GRP_EQ_IN]["xirr"] == seg[d.SEG_EQ_IN]["xirr"]
    assert by[d.GRP_MF]["xirr"] == seg[d.SEG_MF]["xirr"]


def test_totals_gain_is_value_less_money_put_in():
    _, _, v = view()
    t = v["totals"]
    assert t["gain"] == pytest.approx(t["value"] - t["put_in"], abs=0.02)
    assert t["put_in"] == pytest.approx(sum(g["put_in"] for g in v["groups"]), abs=0.05)


def test_market_comparison_uses_the_same_flows():
    """A fixed-rate benchmark on one deposit grows at exactly that rate."""
    prices = ov.Prices({}, [], fd_rate=7.0)
    d0, d1 = date(2025, 1, 1), date(2026, 1, 1)
    end = ov._pme([(d0, -1000.0, "FD")], prices, d1)
    assert end == pytest.approx(1000 * 1.07, rel=1e-6)
    assert xirr([(d0, -1000.0), (d1, end)]) == pytest.approx(0.07, abs=1e-4)


def test_market_comparison_needs_every_price():
    prices = ov.Prices({}, [])
    assert ov._pme([(date(2025, 1, 1), -1000.0, "NIFTY500")], prices, date(2026, 1, 1)) is None


def test_bench_verdicts_and_labels():
    _, _, v = view()
    by = {g["key"]: g for g in v["groups"]}
    assert by[d.GRP_EQ_IN]["bench"]["label"] == "Nifty 500"
    assert by[d.GRP_EPF]["bench"]["label"] == "EPFO rate"
    assert by[d.GRP_MF]["bench"]["label"].endswith("mix")      # one equity fund, one debt fund
    for g in v["groups"]:
        b = g["bench"]
        if b and b["diff"] is not None:
            assert b["verdict"] == ("same" if abs(b["diff"]) <= ov.EQUIVALENT_PP else "ahead" if b["diff"] > 0 else "behind")
    assert v["market"]["groups_compared"] >= 5


def test_targets_from_old_segment_targets():
    old = {d.SEG_EQ_IN: 20, d.SEG_EQ_US: 10, d.SEG_MF: 30, d.SEG_COMMODITY: 10, d.SEG_P2P: 5, d.SEG_FD: 10,
           d.SEG_EPF: 10, d.SEG_NPS: 5}
    _, _, v = view({"targetAllocation": old})
    assert v["targets"]["mine"][d.GRP_OTHERS] == 15
    by = {g["key"]: g for g in v["groups"]}
    assert by[d.GRP_OTHERS]["target"] == 15
    assert by[d.GRP_EQ_IN]["gap"] == pytest.approx(by[d.GRP_EQ_IN]["pct"] - 20, abs=0.01)


def test_group_targets_win_over_segment_targets():
    gt = {d.GRP_EQ_IN: 30, d.GRP_EQ_GLOBAL: 10, d.GRP_MF: 30, d.GRP_P2P: 0, d.GRP_COMMODITY: 10, d.GRP_EPF: 10,
          d.GRP_OTHERS: 10}
    _, _, v = view({"groupTargets": gt, "targetAllocation": {d.SEG_EQ_IN: 100}})
    assert v["targets"]["mine"] == {k: float(x) for k, x in gt.items()}


@pytest.mark.parametrize("profile,age", [("conservative", None), ("balanced", 30), ("growth", 60), ("aggressive", 80)])
def test_suggested_mix_sums_to_100(profile, age):
    s = ov.suggested_mix(profile, age, {d.GRP_EPF: 12.0})
    assert sum(s["mix"].values()) == pytest.approx(100, abs=0.05)
    assert s["mix"][d.GRP_EPF] <= 12.0
    assert s["equity"] >= 20


def test_suggested_mix_tapers_equity_with_age():
    young = ov.suggested_mix("balanced", 30, {})["equity"]
    old = ov.suggested_mix("balanced", 60, {})["equity"]
    assert young == 55 and old == 40


def test_rebalance_without_selling_spends_exactly_the_new_money():
    _, _, v = view()
    targets = ov.suggested_mix("balanced", None, {g["key"]: g["pct"] for g in v["groups"]})["mix"]
    r = ov.rebalance(v["groups"], targets, 50000, False)
    buys = [x for x in r["rows"] if x["action"] == "buy"]
    assert sum(x["amount"] for x in buys) == pytest.approx(50000, abs=1)
    assert all(x["key"] != d.GRP_EPF for x in buys)
    assert not any(x["action"] == "sell" for x in r["rows"])


def test_rebalance_with_selling_never_spends_more_than_it_frees():
    _, _, v = view()
    targets = {g: 0.0 for g in d.GROUPS} | {d.GRP_COMMODITY: 50.0, d.GRP_EPF: 10.0, d.GRP_OTHERS: 40.0}
    legs_seen = []

    def plan(legs):
        legs_seen.extend(legs)
        return {"legs": [{"segment": l["segment"], "covered": l["amount"] * 0.9, "sells": [], "tax": 100.0} for l in legs],
                "tax_total": 300.0, "note": "n"}
    r = ov.rebalance(v["groups"], targets, 0, True, plan_sales=plan)
    sold = sum(x["amount"] for x in r["rows"] if x["action"] == "sell")
    bought = sum(x["amount"] for x in r["rows"] if x["action"] == "buy")
    assert bought <= sold + 1
    assert {l["segment"] for l in legs_seen} <= {d.SEG_EQ_IN, d.SEG_EQ_US, d.SEG_MF, d.SEG_COMMODITY}
    p2p = next(x for x in r["rows"] if x["key"] == d.GRP_P2P)
    assert p2p["action"] == "hold" and p2p.get("let_mature")
    assert r["tax_total"] == 300.0


def test_suggestions_are_capped_and_ordered():
    port, _, v = view({"groupTargets": {g: 100 / 7 for g in d.GROUPS}})
    s = ov.suggestions(v, port, None, TODAY)
    assert len(s) <= 5
    assert [x["rank"] for x in s] == sorted(x["rank"] for x in s)
    for x in s:
        assert x["title"] and x["impact"] and x["cta"] and x["link"]
    # Tata Motors is down 31.5% over 13 months
    assert any(x["id"] == "review:2" for x in ov.suggestions(v, port, None, TODAY, limit=50))


# ── API ──

def _buy(client, who, name="Infosys", ac="equity", qty=10, amount=15000, day="2025-01-10", **extra):
    return client.post("/api/transactions", headers=who, json={
        "type": "BUY", "date": day, "quantity": qty, "amount": amount,
        "instrument": {"asset_class": ac, "name": name, "market": "India", **extra}})


def test_overview_api(client):
    h = auth(USER, "user")
    _buy(client, h)
    r = client.get("/api/overview", headers=h)
    assert r.status_code == 200
    body = r.json
    assert body["totals"]["value"] == 15000
    assert {g["key"] for g in body["groups"]} == {d.GRP_EQ_IN}
    assert len(body["suggestions"]) <= 5


def test_group_targets_setting_is_validated(client):
    h = auth(ADMIN, "admin")
    bad = client.put("/api/settings/groupTargets", headers=h, json={"value": {d.GRP_EQ_IN: 50}})
    assert bad.status_code == 400 and "100%" in bad.json["error"]
    unknown = client.put("/api/settings/groupTargets", headers=h, json={"value": {"crypto": 100}})
    assert unknown.status_code == 400
    ok = client.put("/api/settings/groupTargets", headers=h, json={"value": {d.GRP_EQ_IN: 60, d.GRP_MF: 40}})
    assert ok.status_code == 200
    assert client.get("/api/settings", headers=h).json["groupTargets"] == {d.GRP_EQ_IN: 60.0, d.GRP_MF: 40.0}


def test_rebalance_api(client):
    h = auth(USER, "user")
    _buy(client, h)
    _buy(client, h, name="Index Fund", ac="mutual_fund", qty=100, amount=5000)
    r = client.get("/api/overview/rebalance?new_money=10000&targets=suggested", headers=h)
    assert r.status_code == 200
    assert sum(x["amount"] for x in r.json["rows"] if x["action"] == "buy") == pytest.approx(10000, abs=1)
    assert client.get("/api/overview/rebalance?new_money=abc", headers=h).status_code == 400
