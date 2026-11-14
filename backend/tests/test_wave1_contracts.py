"""Wave-1 integration: the pure engines composed the way services will compose them (AMENDMENTS A6, A7, A24, A28).

actions.py and brief.py were built in parallel against the A6 contract. These tests feed one real
`compute_portfolio` output through insights -> actions -> brief and check the seams: shapes, JSON safety,
shared thresholds, the A28 detection both modules make, and that every link is an allowed route.
"""
import json
from datetime import date, datetime, timezone

import pytest

from test_links import route_ok
from tracker import domain as d
from tracker.analytics import actions as A
from tracker.analytics import brief as B
from tracker.analytics.forecast import cash_flow_forecast
from tracker.analytics.insights import build_insights
from tracker.analytics.portfolio import compute_portfolio
from tracker.analytics.tax import compute_tax

TODAY = date(2026, 11, 14)
NOW = datetime(2026, 11, 14, 9, 0, tzinfo=timezone.utc)
ME = "me@example.com"

# The keys models.ts `Action` requires (optional ones: done_at, reason, note, days_late, meta).
TS_ACTION_KEYS = {"id", "kind", "tier", "severity", "status", "category", "title", "detail", "why", "assumptions",
                  "impact", "due", "days", "confidence", "score", "owner", "instrument_id", "cta", "link", "first_seen",
                  "is_new", "done_via", "evidence", "planned_for", "snooze_until"}
# A6 `Brief`.
BRIEF_KEYS = {"status", "hero", "vitals", "actions", "on_track", "why", "allocation", "upcoming", "tax", "deploy",
              "freshness", "pending", "empty", "context_line", "assumptions_check", "market_state"}


def I(id_, ac, name, **kw):
    base = {"id": id_, "owner": ME, "asset_class": ac, "name": name, "currency": "INR", "status": "active",
            "tax_class": d.default_tax_class(ac, kw.get("market"), kw.get("category"), name)}
    base.update(kw)
    return base


def T(id_, iid, date_, type_, qty=None, amount=0.0):
    return {"id": id_, "instrument_id": iid, "date": date_, "type": type_, "quantity": qty, "amount": amount,
            "amount_fc": None, "principal": None, "fees": None, "owner": ME}


def ledger():
    """Three equity MFs (one well over its target), an FD that matured a month ago with no MATURITY row,
    and an FD maturing in 10 days."""
    inst = [I(1, d.MUTUAL_FUND, "Alpha Flexi Cap", category="Equity", last_price=30.0, prev_close=29.8),
            I(2, d.MUTUAL_FUND, "Bravo Index", category="Equity", last_price=12.0, prev_close=12.1),
            I(3, d.MUTUAL_FUND, "Charlie Small Cap", category="Equity", last_price=8.0, prev_close=8.2),
            I(4, d.FIXED_DEPOSIT, "Old FD", rate=7.0, maturity_date="2026-10-10"),
            I(5, d.FIXED_DEPOSIT, "Near FD", rate=7.25, maturity_date="2026-11-24")]
    txns = [T(1, 1, "2023-01-10", d.BUY, 10000, 200000.0), T(2, 2, "2024-03-01", d.BUY, 10000, 150000.0),
            T(3, 3, "2025-12-01", d.BUY, 10000, 100000.0), T(4, 4, "2025-10-10", d.BUY, None, 100000.0),
            T(5, 5, "2025-11-24", d.BUY, None, 80000.0)]
    return inst, txns


SETTINGS = {"riskProfile": "balanced", "lastReviewDate": "2026-10-01", "targetAllocation": {d.SEG_MF: 50, d.SEG_FD: 50}}


def compose(risk_est=None, inst_txns=None):
    """insights -> actions -> brief, wired as A6 says services will (W2-B1)."""
    inst, txns = inst_txns or ledger()
    port = compute_portfolio(inst, txns, None, SETTINGS["targetAllocation"], today=TODAY)
    port["prices"] = {"last_refresh": "2026-11-14T08:30:00+00:00", "usd_inr": None}
    port["contributions"] = {"p2p_escrow_balance": 0.0}
    fy = d.fy_of(TODAY.isoformat())
    tax = compute_tax(port, txns, inst, fy, 0.3, today=TODAY)
    ctx = {"port": port, "data": {"instruments": inst, "transactions": txns}, "fy": fy, "tax": tax, "goals": [],
           "sips": [], "adherence": None}
    ins = build_insights(port, tax, [], SETTINGS, today=TODAY, sips=[], txns=txns)
    cf = cash_flow_forecast(port["positions"], inst, txns, [], 3, TODAY)
    cushion = B.cushion_state(port, SETTINGS, TODAY)
    deploy = B.deploy_state(port, cf["events"], TODAY)
    src = {"owner": ME, "port": port, "txns": txns, "sips": [], "settings": SETTINGS, "insights": ins,
           "cashflow_events": cf["events"], "tax": tax, "cushion": cushion, "deploy": deploy, "risk_est": risk_est}
    acts = A.build_actions(src, {}, TODAY)
    probe = B.build_brief(ctx, None, None, None, risk_est, None, None, None, None, None, SETTINGS, TODAY,
                          cushion=cushion, deploy=deploy, now=NOW)
    ranked = A.rank(acts, probe["vitals"])
    data_status = next(v["status"] for v in probe["vitals"] if v["key"] == "data")
    top = A.for_home(ranked, port["totals"]["value"], data_status)
    summary = A.summary(ranked)
    br = B.build_brief(ctx, {"top": top, "summary": summary}, None, None, risk_est, None, None, None, None, None,
                       SETTINGS, TODAY, cushion=cushion, deploy=deploy, now=NOW)
    return ranked, summary, br


def links_of(br, acts):
    out = [v["link"] for v in br["vitals"]]
    if br["context_line"]:
        out.append(br["context_line"]["link"])
    for a in [*acts, *br["actions"]]:
        out.append(a["link"])
        href = A.cta_href(a["cta"])
        if href:
            out.append(href)
    return [x for x in out if x is not None]


def test_actions_feed_the_brief_and_both_are_json_safe():
    acts, summary, br = compose({"vol_pct": 14.0, "target_vol_pct": 9.0, "profile": "balanced",
                                 "closest_profile": "growth"})
    json.dumps(acts, allow_nan=False)
    json.dumps(br, allow_nan=False)
    assert set(br) == BRIEF_KEYS
    assert acts and all(TS_ACTION_KEYS <= set(a) for a in acts)
    assert not any(k.startswith("_") for a in acts for k in a)
    assert all(a["id"].startswith(A.ACTION_PREFIXES) for a in acts)
    assert len(br["actions"]) <= 5 and {a["id"] for a in br["actions"]} <= {a["id"] for a in acts}
    assert_counts_match(br, acts)
    bad = [x for x in links_of(br, acts) if not route_ok(x)]
    assert not bad, bad


def assert_counts_match(br, acts):
    """The brief's counts against a tally made here, not through actions.summary: every visible action re-tiered
    against the brief's own final vitals (so a Data vital at act re-ranks data actions), counted by tier, with
    the lump impacts of now + month summed."""
    tiers = A.rank([a for a in acts if a["status"] in A.OPEN_STATUSES], br["vitals"])
    now = [a for a in tiers if a["tier"] == "now"]
    month = [a for a in tiers if a["tier"] == "month"]
    lump = sum(a["impact"]["amount"] for a in now + month if a["impact"] and a["impact"]["kind"] == "lump")
    assert (br["status"]["count_now"], br["status"]["count_month"]) == (len(now), len(month))
    assert br["status"]["impact_total"] == pytest.approx(lump, abs=0.01)
    return now


def test_an_act_data_vital_moves_data_actions_into_now_and_the_counts_follow():
    inst, txns = ledger()
    for i in inst[:3]:
        i["last_price_at"] = "2026-10-01T00:00:00+00:00"   # weeks old, whatever the global refresh stamp says
    acts, _, br = compose(None, (inst, txns))
    assert next(v for v in br["vitals"] if v["key"] == "data")["status"] == "act"
    stale = next(a for a in acts if a["id"] == "data:stale-prices")
    assert A.rank([stale])[0]["tier"] == "month"          # on its own a warn data action is a month item ...
    now = assert_counts_match(br, acts)
    assert "data:stale-prices" in {a["id"] for a in now}  # ... the act Data vital puts it in now
    assert br["status"]["status"] == "act"
    assert "data:stale-prices" in {a["id"] for a in br["actions"]}


def test_fd_matured_unrecorded_is_seen_by_both_engines():
    acts, _, br = compose()
    fd = next(a for a in acts if a["id"] == "fd:matured-unrecorded:4")
    assert fd["cta"]["type"] == "fd_mature" and fd["instrument_id"] == 4 and fd["link"] == "/fixed-deposits"
    mar = next(v for v in br["vitals"] if v["key"] == "money_at_risk")
    assert mar["status"] in ("watch", "act") and "1 FD matured unrecorded" in mar["value"]
    # the near FD is a maturing action, not money at risk
    assert any(a["id"] == "fd:maturing:5" for a in acts)


@pytest.mark.parametrize("vol,vital,severity", [(11.0, "good", None), (12.0, "watch", "warn"), (14.01, "act", "crit")])
def test_risk_vital_and_risk_action_share_thresholds(vol, vital, severity):
    """A24 with t = 9: v ≤ 11 good / no action; ≤ 14 watch / warn; above act / crit."""
    inst, txns = ledger()
    # equal weights well under the concentration limits, so only volatility drives the vital
    inst = [i for i in inst if i["id"] in (4, 5)] + [
        I(10 + k, d.MUTUAL_FUND, f"Fund {k}", category="Equity", last_price=10.0, prev_close=10.0) for k in range(8)]
    txns = [t for t in txns if t["instrument_id"] in (4, 5)] + [
        T(10 + k, 10 + k, "2024-01-10", d.BUY, 2000, 20000.0) for k in range(8)]
    acts, _, br = compose({"vol_pct": vol, "target_vol_pct": 9.0, "profile": "balanced", "closest_profile": "growth"},
                          (inst, txns))
    risk = next(v for v in br["vitals"] if v["key"] == "risk")
    assert risk["status"] == vital
    act = next((a for a in acts if a["id"] == "risk:above-profile"), None)
    assert (act["severity"] if act else None) == severity


def test_onboard_actions_have_the_action_shape():
    port = compute_portfolio([], [], None, {}, today=TODAY)
    port["prices"] = {"last_refresh": None, "usd_inr": None}
    ctx = {"port": port, "data": {"instruments": [], "transactions": []}, "fy": d.fy_of(TODAY.isoformat()),
           "tax": {}, "goals": [], "sips": [], "adherence": None}
    br = B.build_brief(ctx, None, None, None, None, None, None, None, None, None, {}, TODAY, now=NOW)
    assert br["empty"] is True
    acts, _, _ = compose()
    keys = set(acts[0])
    for a in br["actions"]:
        assert set(a) == keys and a["id"].startswith(A.ACTION_PREFIXES)
        assert route_ok(a["link"])
    json.dumps(br, allow_nan=False)
