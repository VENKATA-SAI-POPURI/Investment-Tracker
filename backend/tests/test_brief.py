"""The pure Home brief composer (SPEC §4, §7.8, §7.9 test_brief row; AMENDMENTS A6, A16, A23–A26, A28).

Fixtures are real `compute_portfolio` outputs, so the brief is tested against the shapes services hands it.
"""
from datetime import date, datetime, timedelta, timezone

import pytest

from tracker import domain as d
from tracker.analytics.brief import (VITAL_ORDER, build_brief, cushion_state, deploy_state, status_from_excess)
from tracker.analytics.portfolio import compute_portfolio

TODAY = date(2026, 6, 15)  # outside the Jan–Mar FY window
NOW = datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc)
FRESH = "2026-06-15T09:48:00+00:00"  # 12 minutes before NOW
ACTION_KEYS = {"id", "kind", "tier", "severity", "status", "category", "title", "detail", "why", "assumptions", "impact",
               "due", "days", "confidence", "score", "owner", "instrument_id", "cta", "link", "first_seen", "is_new",
               "done_via", "evidence", "planned_for", "snooze_until", "days_late", "meta"}  # actions._new keys


def T(id_, iid, date_, type_, qty=None, amount=0.0, **kw):
    return {"id": id_, "instrument_id": iid, "date": date_, "type": type_, "quantity": qty, "amount": amount,
            "amount_fc": kw.get("fc"), "principal": kw.get("principal"), "fees": kw.get("fees"), "owner": "a"}


def I(id_, ac, name, **kw):
    base = {"id": id_, "owner": "a", "asset_class": ac, "name": name, "currency": "INR", "status": "active",
            "tax_class": d.default_tax_class(ac, kw.get("market"), kw.get("category"), name)}
    base.update(kw)
    return base


def ledger():
    """Five equity MFs of ₹1 L each (≈14% apiece, under the 25% MF limit) and a ₹2 L FD: ≈ ₹7.14 L in all."""
    inst = [I(i, d.MUTUAL_FUND, f"{n} Flexi Cap", category="Equity", last_price=20.0, prev_close=19.9)
            for i, n in enumerate(("Alpha", "Bravo", "Charlie", "Delta", "Echo"), start=1)]
    inst.append(I(6, d.FIXED_DEPOSIT, "HDFC FD", rate=7.0, maturity_date="2027-06-01"))
    txns = [T(i, i, "2024-01-10", d.BUY, 5000, 100000.0) for i in range(1, 6)]
    txns.append(T(6, 6, "2025-06-01", d.BUY, None, 200000.0))
    return inst, txns


def make_ctx(inst, txns, targets=None, last_refresh=FRESH, escrow=0.0, goals=None, sips=None, tax=None):
    targets = {d.SEG_MF: 70, d.SEG_FD: 30} if targets is None else targets
    port = compute_portfolio(inst, txns, None, targets, today=TODAY)
    port["prices"] = {"last_refresh": last_refresh, "usd_inr": None}
    port["contributions"] = {"p2p_escrow_balance": escrow}
    return {"port": port, "data": {"instruments": inst, "transactions": txns}, "fy": d.fy_of(TODAY.isoformat()),
            "tax": tax or {"fy": d.fy_of(TODAY.isoformat()), "estimate": {"total": 1234.0}, "opportunities": {}},
            "goals": goals or [], "sips": sips or [], "adherence": None}


SETTINGS = {"riskProfile": "balanced", "lastReviewDate": "2026-06-01",
            "emergencyFund": {"months_target": 6, "monthly_expenses": 50000, "instrument_ids": [6], "cash_amount": 100000}}
RISK = {"vol_pct": 10.0, "target_vol_pct": 9.0, "profile": "balanced", "closest_profile": "balanced"}
PERF = {"metrics": {"xirr": 12.0, "start": "2024-01-10"},
        "benchmarks": [{"key": "NIFTY50", "label": "Nifty 50", "xirr": 11.0, "end_value": 700000.0, "excess_xirr": 1.0}]}


def brief(ctx, actions=None, settings=None, risk=RISK, perf=PERF, snapshot=None, quote=None, today=TODAY, **kw):
    return build_brief(ctx, actions, None, None, risk, None, perf, snapshot, None, quote,
                       SETTINGS if settings is None else settings, today, now=NOW, **kw)


def vital(b, key):
    return next(v for v in b["vitals"] if v["key"] == key)


# ── the §7.9 fixtures ──

def test_all_good_is_all_clear():
    b = brief(make_ctx(*ledger()))
    assert b["empty"] is False and b["pending"] == []
    assert [v["key"] for v in b["vitals"]] == list(VITAL_ORDER)
    assert {v["key"]: v["status"] for v in b["vitals"]} == dict.fromkeys(VITAL_ORDER, "good")
    assert b["status"]["status"] == "good"
    assert b["status"]["headline"].startswith("All clear")
    assert b["status"]["count_now"] == 0 and b["status"]["count_month"] == 0 and b["status"]["impact_total"] == 0
    assert b["actions"] == [] and b["context_line"] is None
    for v in b["vitals"]:
        assert set(v) == {"key", "status", "label", "value", "note", "link"}
    assert vital(b, "data")["value"] == "Prices 12 min old · all priced"
    assert vital(b, "money_at_risk")["value"] == "None"
    assert b["freshness"] == {"last_refresh": FRESH, "age_minutes": 12, "missing_prices": [], "missing_weight_pct": 0.0,
                              "stale": False}
    assert b["tax"] == {"fy": "FY2026-27", "estimate_total": 1234.0}
    assert b["assumptions_check"] is None and b["market_state"] is None


def test_two_percent_defaulted_acts_with_rupees_in_the_headline():
    inst, txns = ledger()
    inst.append(I(7, d.P2P, "LenDen loan", status="defaulted", rate=12.0, tenure_months=12))
    txns.append(T(7, 7, "2025-09-01", d.BUY, None, 15000.0))  # ≈ 2% of ≈ ₹7.3 L
    b = brief(make_ctx(inst, txns))
    mar = vital(b, "money_at_risk")
    assert mar["status"] == "act" and mar["value"] == "₹15,000 defaulted" and mar["link"] == "/p2p?tab=defaulted"
    assert mar["note"] == "2.1% of your portfolio"
    assert b["status"]["status"] == "act"
    assert b["status"]["headline"] == "₹15,000 of P2P loans are in default"


def test_six_percent_unpriced_acts_on_data_and_blames_the_data():
    inst, txns = ledger()
    inst.append(I(8, d.MUTUAL_FUND, "Unlisted Fund", category="Equity"))  # no price: valued at cost
    txns.append(T(8, 8, "2025-01-10", d.BUY, 1000, 46000.0))
    b = brief(make_ctx(inst, txns, targets={}))
    data = vital(b, "data")
    assert data["status"] == "act"
    assert b["freshness"]["missing_prices"] == ["Unlisted Fund"]
    assert b["freshness"]["missing_weight_pct"] == pytest.approx(6.05, abs=0.05)
    assert data["value"].startswith("1 holding at cost (6.")
    assert b["status"]["status"] == "act"
    assert "no live price" in b["status"]["headline"] and "values may be off" in b["status"]["headline"]


def test_stale_prices_headline_blames_the_data():
    old = (NOW - timedelta(days=5, hours=1)).isoformat()
    b = brief(make_ctx(*ledger(), last_refresh=old))
    assert vital(b, "data")["status"] == "act" and b["freshness"]["stale"] is True
    assert b["status"]["headline"] == "Prices are 5 days old — values may be off"


def test_outage_with_a_fresh_global_stamp_still_acts_on_old_holding_prices():
    """A refresh where every quote failed (or another owner's refresh) leaves a fresh global stamp, but this
    portfolio's holdings still carry their old price_at: the Data vital reads the holdings (SPEC §7.8)."""
    inst, txns = ledger()
    old = (NOW - timedelta(days=10)).isoformat(timespec="seconds")
    for i in inst[:5]:
        i["last_price_at"] = old
    b = brief(make_ctx(inst, txns, last_refresh=FRESH))
    assert vital(b, "data")["status"] == "act" and b["freshness"]["stale"] is True
    assert b["freshness"]["last_refresh"] == old and b["freshness"]["age_minutes"] == 10 * 24 * 60
    assert b["status"]["headline"] == "Prices are 10 days old — values may be off"


def test_the_oldest_holding_price_sets_the_age():
    inst, txns = ledger()
    for i in inst[:4]:
        i["last_price_at"] = FRESH
    inst[4]["last_price_at"] = (NOW - timedelta(hours=30)).isoformat()
    b = brief(make_ctx(inst, txns))
    assert vital(b, "data")["status"] == "watch" and b["freshness"]["age_minutes"] == 30 * 60


def test_data_watch_between_26_hours_and_4_days():
    b = brief(make_ctx(*ledger(), last_refresh=(NOW - timedelta(hours=30)).isoformat()))
    assert vital(b, "data")["status"] == "watch" and b["freshness"]["stale"] is True


def test_no_targets_leaves_mix_unset_and_never_raises_the_status():
    b = brief(make_ctx(*ledger(), targets={}))
    mix = vital(b, "mix")
    assert mix["status"] == "unset" and mix["note"] and mix["link"] == "/risk#mix"
    assert b["status"]["status"] == "good" and b["status"]["headline"].startswith("All clear")
    assert all(a["drift_status"] == "unset" and a["target"] is None for a in b["allocation"])


def test_two_months_of_cushion_acts():
    settings = {**SETTINGS, "emergencyFund": {"months_target": 6, "monthly_expenses": 50000, "instrument_ids": [],
                                              "cash_amount": 100000}}
    b = brief(make_ctx(*ledger()), settings=settings)
    c = vital(b, "cushion")
    assert c["status"] == "act" and c["value"] == "2.0 months of expenses" and c["link"] == "/settings#cushion"
    assert c["note"] == "Target 6 months · ₹2.0 L short"
    assert b["status"]["status"] == "act"
    assert not b["status"]["headline"].startswith("All clear") and "Cushion" in b["status"]["headline"]


def test_perf_none_is_pending_market():
    b = brief(make_ctx(*ledger()), perf=None)
    assert b["pending"] == ["market"]
    assert b["on_track"]["market"] == {"status": "pending", "excess": None, "diff_value": None, "since": None, "days": None}
    assert b["status"]["status"] == "good"  # a pending card never raises the page status


def test_since_delta():
    ctx = make_ctx(*ledger())
    value = ctx["port"]["totals"]["value"]
    snap = {"date": "2026-06-01", "data": {"value": value - 10000, "action_ids": ["fd:maturing:6"]}}
    top = [{"id": "fd:maturing:6", "title": "FD matures", "category": "fd"},
           {"id": "drift:Mutual Funds", "title": "Mix drift", "category": "allocation"}]
    acts = {"top": top, "summary": {"now": 0, "month": 2, "consider": 0, "good": 0, "impact_total": 5000}}
    b = brief(ctx, actions=acts, snapshot=snap)
    s = b["hero"]["since_last"]
    assert s["date"] == "2026-06-01" and s["change"] == pytest.approx(10000)
    assert s["change_pct"] == pytest.approx(10000 / (value - 10000) * 100, abs=0.01)
    assert s["actions_new"] == 1
    # with actions.summary's `new` (every visible action, not just the Home five) that count wins
    many = {**acts, "summary": {**acts["summary"], "new": 7}}
    assert brief(ctx, actions=many, snapshot=snap)["hero"]["since_last"]["actions_new"] == 7
    assert brief(ctx)["hero"]["since_last"] is None


def test_empty_ledger():
    inst = [I(1, d.MUTUAL_FUND, "Alpha Flexi Cap", category="Equity")]
    b = brief(make_ctx(inst, [], targets={}))
    assert b["empty"] is True and b["vitals"] == []
    assert [a["id"] for a in b["actions"]] == ["onboard:import", "onboard:add"]
    for a in b["actions"]:
        assert set(a) == ACTION_KEYS
        assert a["link"].startswith(("/import", "/transactions"))
    assert b["actions"][0]["cta"] == {"label": "Import", "type": "route", "route": "/import"}
    assert b["actions"][1]["cta"]["type"] == "dialog"
    assert b["on_track"]["plan"]["status"] == "unset"
    assert b["status"]["headline"] == "Let's add your first investment"


# ── headline ladder and counts from the actions summary ──

def test_counts_and_impact_come_from_the_summary():
    top = [{"id": "sip:due:1:2026-06-18", "title": "Record your ₹10,000 SIP", "category": "habit"}]
    b = brief(make_ctx(*ledger()), actions={"top": top, "summary": {"now": 2, "month": 3, "consider": 1, "good": 0,
                                                                     "impact_total": 48200.4}})
    assert b["status"]["count_now"] == 2 and b["status"]["count_month"] == 3 and b["status"]["impact_total"] == 48200.4
    assert b["status"]["headline"] == "2 things need you this week · top: Record your ₹10,000 SIP"
    assert b["status"]["status"] == "act" and b["actions"] == top

    b = brief(make_ctx(*ledger()), actions={"top": top, "summary": {"now": 0, "month": 3, "impact_total": 0}})
    assert b["status"]["headline"] == "3 things to look at this month" and b["status"]["status"] == "watch"


def test_actions_capped_at_five():
    top = [{"id": f"x:{i}", "title": f"T{i}", "category": "risk"} for i in range(7)]
    b = brief(make_ctx(*ledger()), actions={"top": top, "summary": {"now": 7}})
    assert len(b["actions"]) == 5


# ── vitals ──

@pytest.mark.parametrize("vol,status", [(11.0, "good"), (11.01, "watch"), (14.0, "watch"), (14.01, "act")])
def test_risk_vital_boundaries_at_t_plus_2_and_t_plus_5(vol, status):
    b = brief(make_ctx(*ledger()), risk={**RISK, "vol_pct": vol})
    r = vital(b, "risk")
    assert r["status"] == status and r["link"] == "/risk"
    assert r["value"].startswith(f"Est. volatility {vol:.1f}% · Balanced target 9%")


def test_risk_target_falls_back_to_the_profile():
    b = brief(make_ctx(*ledger()), risk={"vol_pct": 14.5, "target_vol_pct": None, "profile": None, "closest_profile": None},
              settings={**SETTINGS, "riskProfile": "growth"})
    assert vital(b, "risk")["status"] == "watch"  # growth target 12: 14.5 ≤ 17


def test_risk_vital_concentration_lifts_to_watch():
    inst, txns = ledger()
    inst.append(I(9, d.EQUITY, "Big Stock", last_price=100.0, sector="IT"))
    txns.append(T(9, 9, "2025-01-10", d.BUY, 1500, 150000.0))  # ≈ 17% of ≈ ₹8.6 L
    b = brief(make_ctx(inst, txns, targets={}))
    r = vital(b, "risk")
    assert r["status"] == "watch" and "Top holding 17%" in r["value"] and "Big Stock" in r["note"]


def test_risk_vital_unset_without_profile_or_estimate():
    no_profile = {**SETTINGS}
    no_profile.pop("riskProfile")
    b = brief(make_ctx(*ledger()), settings=no_profile, risk={**RISK, "profile": None, "closest_profile": "growth"})
    r = vital(b, "risk")
    assert r["status"] == "unset" and r["note"] == "Looks like Growth"
    r = vital(brief(make_ctx(*ledger()), risk=None), "risk")
    assert r["status"] == "unset" and r["note"]
    assert brief(make_ctx(*ledger()), risk=None)["status"]["status"] == "good"


def test_mix_vital_thresholds():
    ctx = make_ctx(*ledger(), targets={d.SEG_MF: 66, d.SEG_FD: 34})  # MF ≈ 69.9% → +3.9 pts
    m = vital(brief(ctx), "mix")
    assert m["status"] == "watch" and m["value"] == "Mutual Funds +3.9 pts over"
    ctx = make_ctx(*ledger(), targets={d.SEG_MF: 60, d.SEG_FD: 40})
    assert vital(brief(ctx), "mix")["status"] == "act"
    alloc = {a["segment"]: a for a in brief(ctx)["allocation"]}
    assert alloc[d.SEG_MF]["drift_status"] == "act" and alloc[d.SEG_MF]["target"] == 60


def test_money_at_risk_counts_overdue_and_matured_unrecorded_fds():
    inst, txns = ledger()
    inst.append(I(10, d.P2P, "Late loan", rate=12.0, maturity_date="2026-04-01"))  # 75 days past maturity
    txns.append(T(10, 10, "2025-04-01", d.BUY, None, 3000.0))
    inst.append(I(11, d.FIXED_DEPOSIT, "SBI FD", rate=7.0, maturity_date="2026-06-01"))  # matured, no MATURITY row
    txns.append(T(11, 11, "2025-06-01", d.BUY, None, 100000.0))
    b = brief(make_ctx(inst, txns, targets={}))
    mar = vital(b, "money_at_risk")
    assert mar["status"] == "act"
    assert mar["value"] == "₹3,000 overdue · 1 FD matured unrecorded" and mar["link"] == "/p2p?tab=overdue"
    assert b["status"]["headline"] == "₹3,000 of P2P loans are over 30 days overdue"


def test_money_at_risk_small_share_is_watch():
    inst, txns = ledger()
    inst.append(I(10, d.P2P, "Late loan", rate=12.0, maturity_date="2026-04-01"))
    txns.append(T(10, 10, "2025-04-01", d.BUY, None, 3000.0))  # ≈ 0.4% of value
    b = brief(make_ctx(inst, txns))
    assert vital(b, "money_at_risk")["status"] == "watch"


# ── cushion and deploy helpers (A6, A15, A25) ──

def test_cushion_counts_cash_amount():
    ctx = make_ctx(*ledger())
    fd_value = next(p["value"] for p in ctx["port"]["positions"] if p["id"] == 6)
    c = cushion_state(ctx["port"], SETTINGS, TODAY)
    assert c["set"] is True and c["cash_amount"] == 100000 and c["instrument_ids"] == [6]
    assert c["amount"] == pytest.approx(fd_value + 100000, abs=0.01)
    assert c["months"] == pytest.approx((fd_value + 100000) / 50000, abs=0.01)
    assert set(c) == {"set", "months", "target_months", "monthly_expenses", "amount", "cash_amount", "instrument_ids",
                      "candidates", "candidates_amount"}


def test_cushion_unset_names_candidates():
    port = {"positions": [
        {"id": 1, "asset_class": d.FIXED_DEPOSIT, "name": "FD late", "value": 100000, "is_open": True, "total_return": 0,
         "days_to_maturity": 300, "maturity_date": "2027-04-11", "segment": d.SEG_FD},
        {"id": 2, "asset_class": d.FIXED_DEPOSIT, "name": "FD far", "value": 500000, "is_open": True, "total_return": 0,
         "days_to_maturity": 900, "maturity_date": "2028-12-01", "segment": d.SEG_FD},
        {"id": 3, "asset_class": d.MUTUAL_FUND, "name": "Gilt Fund", "category": "Debt", "value": 50000, "is_open": True, "total_return": 0,
         "segment": d.SEG_MF},
        {"id": 4, "asset_class": d.MUTUAL_FUND, "name": "Cash Fund", "category": "Liquid", "value": 70000, "is_open": True, "total_return": 0,
         "segment": d.SEG_MF},
        {"id": 5, "asset_class": d.MUTUAL_FUND, "name": "Flexi Cap", "category": "Equity", "value": 90000, "is_open": True, "total_return": 0,
         "segment": d.SEG_MF},
        {"id": 6, "asset_class": d.CASH, "name": "Vested wallet", "value": 30000, "is_open": True, "total_return": 0,
         "segment": d.SEG_EQ_US},
    ]}
    c = cushion_state(port, {}, TODAY)
    assert c["set"] is False and c["months"] is None and c["target_months"] == 6
    assert [x["instrument_id"] for x in c["candidates"]] == [6, 4, 3, 1]  # wallet, liquid, debt, FD ≤ 1 year
    assert c["candidates_amount"] == 250000
    ctx = make_ctx(*ledger())
    ctx = {**ctx, "port": {**ctx["port"], "positions": ctx["port"]["positions"] + port["positions"]}}
    v = vital(brief(ctx, settings={"riskProfile": "balanced", "lastReviewDate": "2026-06-01"}), "cushion")
    # the ledger's own FD (351 days to maturity, ≈ ₹2.14 L) is a candidate too: ≈ ₹4.6 L in all
    assert cushion_state(ctx["port"], {}, TODAY)["candidates_amount"] == pytest.approx(464900, abs=1000)
    assert v["status"] == "unset" and v["note"] == "Mark your emergency money — we found ₹4.6 L of candidates"


def test_deploy_sources_carry_held_value():
    port = {"positions": [
        {"id": 1, "asset_class": d.CASH, "name": "Vested", "value": 40000.0, "is_open": True, "segment": d.SEG_EQ_US},
        {"id": 2, "asset_class": d.FIXED_DEPOSIT, "name": "HDFC FD", "value": 104000.0, "maturity_value": 105000.0,
         "days_to_maturity": 20, "maturity_date": "2026-07-05", "is_open": True, "segment": d.SEG_FD},
        {"id": 3, "asset_class": d.FIXED_DEPOSIT, "name": "Far FD", "value": 50000.0, "maturity_value": 60000.0,
         "days_to_maturity": 200, "maturity_date": "2027-01-01", "is_open": True, "segment": d.SEG_FD},
    ], "contributions": {"p2p_escrow_balance": 2500.0}}
    events = [{"date": "2026-07-01", "kind": "p2p_close", "name": "3 P2P loans", "amount": 12000.0, "instrument_id": None},
              {"date": "2026-09-01", "kind": "p2p_close", "name": "later", "amount": 9000.0, "instrument_id": None},
              {"date": "2026-07-05", "kind": "fd_maturity", "name": "HDFC FD", "amount": 105000.0, "instrument_id": 2}]
    dep = deploy_state(port, events, TODAY)
    by_kind = {s["kind"]: s for s in dep["sources"]}
    assert set(by_kind) == {"usd", "fd", "p2p_principal", "escrow"}
    assert by_kind["usd"]["amount"] == 40000 and by_kind["usd"]["held_value"] == 40000
    assert by_kind["fd"]["amount"] == 105000 and by_kind["fd"]["held_value"] == 104000
    assert by_kind["fd"]["instrument_id"] == 2 and by_kind["fd"]["date"] == "2026-07-05"
    assert by_kind["p2p_principal"]["amount"] == 12000 and by_kind["p2p_principal"]["segment"] == d.SEG_P2P
    assert by_kind["escrow"]["held_value"] == 0 and by_kind["escrow"]["segment"] is None
    for s in dep["sources"]:
        assert set(s) == {"kind", "label", "segment", "instrument_id", "date", "amount", "held_value"}
    assert dep["suggested"] == 40000 + 105000 + 12000 + 2500
    no_events = deploy_state(port, None, TODAY)
    assert "p2p_principal" not in {s["kind"] for s in no_events["sources"]}
    assert no_events["suggested"] == 40000 + 105000 + 2500


def test_brief_uses_given_cushion_and_deploy():
    dep = {"suggested": 7.0, "sources": []}
    b = brief(make_ctx(*ledger()), deploy=dep, cushion={"set": True, "months": 7.0, "target_months": 6,
                                                        "monthly_expenses": 1.0, "candidates_amount": 0})
    assert b["deploy"] is dep and vital(b, "cushion")["status"] == "good"
    assert brief(make_ctx(*ledger()))["deploy"]["suggested"] == 0  # no wallet, no FD within 30 days, no escrow


# ── on track, why, hero, context line ──

@pytest.mark.parametrize("excess,days,status", [(1.0, 400, "good"), (0.0, 400, "good"), (-2.9, 400, "watch"),
                                                (-3.0, 400, "act"), (5.0, 179, "unset"), (None, 400, "unset")])
def test_market_status_rule(excess, days, status):
    assert status_from_excess(excess, days) == status


def test_market_card_reads_the_nifty_row():
    ctx = make_ctx(*ledger())
    m = brief(ctx)["on_track"]["market"]
    assert m["status"] == "good" and m["excess"] == 1.0 and m["since"] == "2024-01-10"
    assert m["days"] == (TODAY - date(2024, 1, 10)).days
    assert m["diff_value"] == pytest.approx(ctx["port"]["totals"]["value"] - 700000.0)
    young = {**PERF, "metrics": {"xirr": 12.0, "start": "2026-03-01"}}
    assert brief(ctx, perf=young)["on_track"]["market"]["status"] == "unset"


def test_plan_track_from_context_goals_and_snapshot_delta():
    goals = [{"id": 1, "name": "House", "target_amount": 5e6, "target_date": "2030-01-01",
              "projection": {"probability": 80.0, "status": "on_track"}},
             {"id": 2, "name": "Car", "target_amount": 1e6, "target_date": "2027-01-01",
              "projection": {"probability": 30.0, "status": "off_track"}}]
    ctx = make_ctx(*ledger(), goals=goals)
    snap = {"date": "2026-06-01", "data": {"value": 1.0, "goal_probs": {"1": 85.0}}}
    p = brief(ctx, snapshot=snap)["on_track"]["plan"]
    assert p["status"] == "act" and p["on_track"] == 1 and p["total"] == 2
    assert [r["name"] for r in p["rows"]] == ["Car", "House"]  # worst first
    assert p["rows"][1]["delta"] == -5.0 and p["rows"][0]["delta"] is None
    assert brief(make_ctx(*ledger()))["on_track"]["plan"]["status"] == "unset"


def test_habit_is_unset_with_invested_vs_planned():
    inst, txns = ledger()
    txns.append(T(20, 1, "2026-06-05", d.BUY, 500, 10000.0))
    sips = [{"id": 1, "name": "Alpha SIP", "amount": 10000, "frequency": "monthly", "active": 1, "day_of_month": 5},
            {"id": 2, "name": "Quarterly", "amount": 9000, "frequency": "quarterly", "active": 1},
            {"id": 3, "name": "Paused", "amount": 5000, "frequency": "monthly", "active": 0}]
    h = brief(make_ctx(inst, txns, sips=sips))["on_track"]["habit"]
    milestone = h.pop("milestone")
    assert h == {"status": "unset", "invested_month": 10000.0, "planned_month": 13000.0, "adherence_6m_pct": None,
                 "pace": None, "next_due": None}
    assert set(milestone) == {"label", "when", "in"} and milestone["label"] == "₹10 lakh"


def test_why_is_story_attribution():
    from tracker.analytics.story import attribution
    ctx = make_ctx(*ledger())
    assert brief(ctx)["why"] == attribution(ctx["port"])


def test_nifty_d1_from_the_quote():
    b = brief(make_ctx(*ledger()), quote={"price": 24240.0, "prev_close": 24000.0, "date": "2026-06-15"})
    assert b["hero"]["nifty_d1"] == 1.0
    assert brief(make_ctx(*ledger()))["hero"]["nifty_d1"] is None
    assert brief(make_ctx(*ledger()), quote={"price": 1.0, "prev_close": None})["hero"]["nifty_d1"] is None


def test_context_line_fy_window_then_review():
    feb = date(2027, 2, 11)
    tax = {"fy": "FY2026-27", "estimate": {"total": 0},
           "opportunities": {"ltcg_harvest": {"suggested_booking": 50000, "remaining_exemption": 110000}}}
    ctx = make_ctx(*ledger(), tax=tax)
    tax_open = {"top": [], "summary": {"now": 0, "month": 1, "consider": 0, "good": 0, "impact_total": 0, "tax_open": 1}}
    line = brief(ctx, actions=tax_open, today=feb)["context_line"]
    assert line["kind"] == "fy_window" and line["link"] == "/tax?tab=save"
    assert line["text"].startswith("48 days left in FY2026-27 · ₹1.1 L tax-free gains unused")
    # SPEC §4.1: only with an open tax action (one closed, dismissed or snoozed does not keep the line up)
    assert brief(ctx, actions={**tax_open, "summary": {**tax_open["summary"], "tax_open": 0}}, today=feb)["context_line"]["kind"] == "review"
    # under the A12 floor the unused-exemption figure is not quoted (tax:ltcg-harvest has closed as done)
    small = make_ctx(*ledger(), tax={**tax, "opportunities": {"ltcg_harvest": {"suggested_booking": 1500,
                                                                               "remaining_exemption": 1500}}})
    assert brief(small, today=feb)["context_line"]["kind"] == "review"   # no tax action: the overdue review
    line = brief(small, actions=tax_open, today=feb)["context_line"]
    assert line["text"] == "48 days left in FY2026-27 · tax moves still open · Plan the sales"
    # outside Jan–Mar the FY window gives way to an overdue review
    line = brief(ctx, settings={**SETTINGS, "lastReviewDate": "2026-01-01"})["context_line"]
    assert line["kind"] == "review" and line["link"].startswith("/actions")
    assert brief(ctx)["context_line"] is None


def test_a_failing_vital_becomes_unset():
    b = brief(make_ctx(*ledger()), risk={"vol_pct": "not a number", "target_vol_pct": 9, "profile": "balanced"})
    r = vital(b, "risk")
    assert r["status"] == "unset" and r["note"]
    assert b["status"]["status"] == "good"


# ── P1 (AMENDMENTS G15, H11) ──

def adherence(pct, planned=10000.0, invested=5000.0, active=True, next_due=None):
    return {"adherence_6m_pct": pct, "plans": [{"id": 1, "active": active}], "planned_this_month": planned,
            "invested_this_month": invested,
            "next_due": next_due if next_due is not None else [{"date": "2026-06-20", "plan_id": 1, "name": "Alpha SIP",
                                                                "amount": 10000.0}]}


@pytest.mark.parametrize("pct,status", [(95.0, "good"), (90.0, "good"), (89.9, "watch"), (60.0, "watch"),
                                        (59.9, "act"), (None, "unset")])
def test_habit_is_scored_from_adherence(pct, status):
    ctx = {**make_ctx(*ledger()), "adherence": adherence(pct)}
    h = brief(ctx)["on_track"]["habit"]
    assert h["status"] == status and h["adherence_6m_pct"] == pct
    assert h["pace"] == 50.0
    assert h["next_due"] == {"date": "2026-06-20", "plan_id": 1, "name": "Alpha SIP", "amount": 10000.0}
    assert set(h["milestone"]) == {"label", "when", "in"}


def test_habit_unset_without_active_plans_and_pace_none_without_plan_this_month():
    paused = {**make_ctx(*ledger()), "adherence": adherence(100.0, active=False)}
    assert brief(paused)["on_track"]["habit"]["status"] == "unset"
    quiet = {**make_ctx(*ledger()), "adherence": adherence(100.0, planned=0.0, next_due=[])}
    h = brief(quiet)["on_track"]["habit"]
    assert h["pace"] is None and h["next_due"] is None and h["status"] == "good"


def correction(mode="correction", dd=-6.0, inr=-45000.0):
    return {"mode": mode, "nifty": {"price": 21000.0, "d1": -0.4, "w1": -2.0, "from_high_pct": -12.3},
            "you": {"from_peak_pct": dd, "from_peak_inr": inr},
            "comparable": {"key": "correction", "label": "Market correction", "impact": -60000.0, "impact_pct": -8.0,
                           "smaller": True},
            "playbook": [], "since": "2026-02-01"}


def test_market_context_line_comes_first():
    from tracker.markets import context_line
    feb = date(2027, 2, 11)
    tax = {"fy": "FY2026-27", "estimate": {"total": 0},
           "opportunities": {"ltcg_harvest": {"suggested_booking": 50000, "remaining_exemption": 110000}}}
    ctx = make_ctx(*ledger(), tax=tax)
    tax_open = {"top": [], "summary": {"now": 0, "month": 1, "consider": 0, "good": 0, "impact_total": 0, "tax_open": 1}}
    state = correction()
    b = build_brief(ctx, tax_open, None, None, RISK, None, PERF, None, state, None, SETTINGS, feb, now=NOW)
    assert b["context_line"] == context_line(state) and b["context_line"]["kind"] == "market"
    assert b["market_state"] is state
    # a normal market leaves the FY window in place
    calm = build_brief(ctx, tax_open, None, None, RISK, None, PERF, None, {**state, "mode": "normal"}, None, SETTINGS,
                       feb, now=NOW)
    assert calm["context_line"]["kind"] == "fy_window"


def test_upcoming_and_market_state_pass_through():
    up = {"inflow_90d": 1.0, "outflow_90d": 2.0, "theme": None, "next_festival": None, "events": []}
    b = build_brief(make_ctx(*ledger()), None, up, None, RISK, None, PERF, None, correction("normal"), None, SETTINGS,
                    TODAY, now=NOW)
    assert b["upcoming"] is up and b["market_state"]["mode"] == "normal" and b["context_line"] is None


def test_cushion_candidates_use_the_book_key_not_the_name():
    port = {"positions": [
        {"id": 1, "asset_class": d.MUTUAL_FUND, "name": "Liquid Growth Equity Fund", "category": "Equity",
         "value": 50000, "is_open": True, "segment": d.SEG_MF},
        {"id": 2, "asset_class": d.MUTUAL_FUND, "name": "Short Term Fund", "category": "Hybrid", "tax_class": d.TAX_DEBT,
         "value": 40000, "is_open": True, "segment": d.SEG_MF},
        {"id": 3, "asset_class": d.MUTUAL_FUND, "name": "Overnight Fund", "category": "Debt",
         "sub_category": "Overnight", "value": 30000, "is_open": True, "segment": d.SEG_MF},
    ]}
    c = cushion_state(port, {}, TODAY)
    # the equity fund named "Liquid" is not a candidate; the overnight fund (liquid) sorts before the other debt fund
    assert [x["instrument_id"] for x in c["candidates"]] == [3, 2]
    assert all(x["kind"] == "mf_debt" for x in c["candidates"])


# ── assumptions check and chip ──

def holdings(start="2020-06-15"):
    """₹1 L in one equity MF since `start` (σ 15%, μ 11%)."""
    inst = [I(1, d.MUTUAL_FUND, "Alpha Flexi Cap", category="Equity", last_price=20.0)]
    return make_ctx(inst, [T(1, 1, start, d.BUY, 5000, 100000.0)])


def perf_with(twr, start="2020-06-15", end="2026-06-15"):
    return {**PERF, "metrics": {"xirr": twr, "start": start, "end": end, "twr_annualised": twr}}


def test_assumptions_check_verdicts_and_link():
    from tracker.analytics.assumptions import typical_band
    ctx = holdings()
    years = (date(2026, 6, 15) - date(2020, 6, 15)).days / 365.25
    band = typical_band(0.11, 0.15, years)
    within = brief(ctx, perf=perf_with(band["typical"]))["assumptions_check"]
    assert within == {"realised_pct": band["typical"], "years": round(years, 2), "typical": band["typical"],
                      "lo": band["lo"], "hi": band["hi"], "verdict": "within", "link": None}
    above = brief(ctx, perf=perf_with(band["hi"] + 1))["assumptions_check"]
    assert above["verdict"] == "above" and above["link"] is None
    low = round(band["lo"] - 1.3, 2)
    below = brief(ctx, perf=perf_with(low))["assumptions_check"]
    assert below["verdict"] == "below" and below["link"] == f"/plan?return={round(low * 2) / 2:g}"
    # under two years a low return is shown but not linked
    young = brief(ctx, perf=perf_with(-15.0, start="2025-01-15", end="2026-06-15"))["assumptions_check"]
    assert young["verdict"] == "below" and young["link"] is None


def test_assumptions_check_too_short_and_absent():
    from tracker.analytics.assumptions import typical_band
    ctx = holdings("2026-01-10")
    short = brief(ctx, perf=perf_with(None, start="2026-01-10"))["assumptions_check"]
    one = typical_band(0.11, 0.15, 1)
    assert short["verdict"] == "too_short" and short["realised_pct"] is None and short["link"] is None
    assert (short["typical"], short["lo"], short["hi"]) == (one["typical"], one["lo"], one["hi"])
    assert brief(ctx, perf=None)["assumptions_check"] is None                        # perf not warm yet
    assert brief(ctx, perf=PERF)["assumptions_check"] is None                        # no end date in the metrics


def test_assumptions_chip_block_and_p1_fields():
    from tracker.analytics.assumptions import book_hash, chip, effective_book, rated_book, weights_from_positions
    from tracker.analytics.brief import assumptions_block, p1_fields
    ctx = make_ctx(*ledger())
    positions = ctx["port"]["positions"]
    block = assumptions_block(ctx["port"], SETTINGS)
    expected = chip(rated_book(positions, effective_book(SETTINGS)), weights_from_positions(positions))
    assert block == {**expected, "basis": "holdings mix", "chip": expected["text"]}
    assert block["hash"] == book_hash(rated_book(positions))
    f = p1_fields(ctx["port"], SETTINGS, {"set": False}, RISK)
    assert f == {"assumptions": block, "cushion": {"set": False}, "risk_est": RISK}
    assert p1_fields(ctx["port"], SETTINGS, None, None, empty=True)["assumptions"] is None
    # build_brief's own keys stay the A6 contract
    assert not {"assumptions", "cushion", "risk_est"} & set(brief(ctx))


# ── plan_track / plan_headline (H6) ──

def test_plan_headline_and_track_exports():
    from tracker.analytics.brief import plan_headline, plan_track
    goals = [{"id": 1, "name": "House", "projection": {"probability": 80.0, "status": "on_track"}},
             {"id": 2, "name": "Car", "projection": {"probability": 30.0, "status": "off_track"}}]
    ret = {"probability": 71.6, "status": "at_risk", "inputs": {"retire_age": 55}, "corpus_needed": 1e7}
    snap_row = {"date": "2026-05-15", "data": {"goal_probs": {"1": 85.0, "retirement": 70.0}}}
    track = plan_track({"goals": []}, {"goals": goals, "retirement": ret}, snap_row)   # a {date, data} row is unwrapped
    assert track == plan_track({}, {"goals": goals, "retirement": ret}, snap_row["data"])
    assert [r["name"] for r in track["rows"]] == ["Car", "Retire at 55", "House"]
    assert {r["name"]: r["delta"] for r in track["rows"]} == {"Car": None, "Retire at 55": 1.6, "House": -5.0}
    assert plan_headline(track) == "1 of 2 goals on track · retirement 72% likely"
    assert plan_headline(plan_track({}, {"goals": goals[:1], "retirement": None}, None)) == "1 of 1 goal on track"
    assert plan_headline(plan_track({}, {"goals": [], "retirement": ret}, None)) == "Retirement 72% likely"
    empty = plan_track({}, {"goals": [], "retirement": None}, None)
    assert plan_headline(empty) == "No goals yet" and empty["status"] == "unset"
