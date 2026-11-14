"""P1 insight rules (SPEC Part 2 §8.3 insight rows; AMENDMENTS G10, A8, A12, D11).

`test_links.py` pins the ids and links on a rich fixture; this file pins the thresholds: concentration and
sector with and without the action-log hysteresis (`open_ids`), the drift bands, the harvest floor and its
Q4 severity, `nps:nav-stale` and `elss:unlocked`.
"""
from datetime import date, timedelta

import pytest

from tracker import domain as d
from tracker.analytics import actions as A
from tracker.analytics import insights as ins
from tracker.analytics.insights import build_insights

TODAY = date(2026, 11, 14)


def P(id_, ac, name, value, weight, segment=None, **kw):
    return {"id": id_, "asset_class": ac, "name": name, "segment": segment or d.segment_of({"asset_class": ac}), "value": value,
            "weight": weight, "is_open": True, "unrealized_pct": None, "first_date": None, "price_at": None, **kw}


def port(positions, segments=None, total=1_000_000.0):
    return {"totals": {"value": total, "xirr": None, "missing_prices": []}, "segments": segments or [],
            "positions": positions}


def run(positions=(), segments=None, tax=None, today=TODAY, settings=None, **kw):
    settings = {"lastReviewDate": today.isoformat()} if settings is None else settings
    return build_insights(port(list(positions), segments), tax, [], settings, today=today, sips=[], txns=[], **kw)


def by_prefix(items, prefix):
    return {i["id"]: i for i in items if i["id"].startswith(prefix)}


# ── concentration (≥ 15, MF ≥ 25; an open row closes below 12, MF 22) ──

@pytest.mark.parametrize("ac,weight,fires", [
    (d.EQUITY, 14.9, False), (d.EQUITY, 15.0, True), (d.EQUITY, 22.0, True),
    (d.EQUITY, 12.0, False), (d.EQUITY, 10.0, False),             # the old 10–15 info band is gone
    (d.MUTUAL_FUND, 24.9, False), (d.MUTUAL_FUND, 25.0, True), (d.MUTUAL_FUND, 20.0, False),
    (d.COMMODITY, 15.0, True), (d.NPS, 15.0, True),
])
def test_concentration_opens_at_the_limit_as_a_warning(ac, weight, fires):
    items = by_prefix(run([P(1, ac, "Big", 150000, weight, symbol="X")]), "concentration:")
    assert ("concentration:1" in items) is fires
    if fires:
        c = items["concentration:1"]
        assert c["severity"] == "warning" and c["category"] == "risk"
        assert c["link"] == "/holding/1" and c["amount"] == 150000


@pytest.mark.parametrize("ac,weight,fires", [
    (d.EQUITY, 12.0, True), (d.EQUITY, 11.9, False), (d.EQUITY, 14.0, True),
    (d.MUTUAL_FUND, 22.0, True), (d.MUTUAL_FUND, 21.9, False), (d.MUTUAL_FUND, 24.0, True),
])
def test_an_open_concentration_row_keeps_firing_down_to_limit_minus_3(ac, weight, fires):
    pos = [P(1, ac, "Big", 150000, weight, symbol="X")]
    held = by_prefix(run(pos, open_ids={"concentration:1"}), "concentration:")
    assert ("concentration:1" in held) is fires
    if fires:
        assert held["concentration:1"]["severity"] == "warning"
    # without the action log (None) or with another row open, the open line applies
    assert "concentration:1" not in by_prefix(run(pos), "concentration:")
    assert "concentration:1" not in by_prefix(run(pos, open_ids=["concentration:2", "sector:IT"]), "concentration:")


def test_concentration_skips_p2p_fd_cash_and_closed_positions():
    pos = [P(1, d.P2P, "Loan", 300000, 30.0), P(2, d.FIXED_DEPOSIT, "FD", 300000, 30.0),
           P(3, d.CASH, "Wallet", 300000, 30.0), P(4, d.EQUITY, "Sold", 0, 30.0, is_open=False)]
    assert by_prefix(run(pos), "concentration:") == {}


def test_open_ids_accepts_any_iterable():
    pos = [P(1, d.EQUITY, "Big", 130000, 13.0, symbol="X")]
    assert "concentration:1" in by_prefix(run(pos, open_ids=(i for i in ["concentration:1"])), "concentration:")
    assert "concentration:1" in by_prefix(run(pos, open_ids=("concentration:1",)), "concentration:")


# ── sector (> 30; an open row closes below 28) ──

def sector_book(it_value):
    """Direct equity worth 1000 in all: IT holds ``it_value``, the rest spread across three other sectors."""
    rest = (1000 - it_value) / 3
    return [P(1, d.EQUITY, "IT Co", it_value, 1.0, sector="IT", symbol="A"),
            P(2, d.EQUITY, "Bank Co", rest, 1.0, sector="Banks", symbol="B"),
            P(3, d.EQUITY, "Pharma Co", rest, 1.0, sector="Pharma", symbol="C"),
            P(4, d.EQUITY, "Auto Co", rest, 1.0, sector="Auto", symbol="D")]


@pytest.mark.parametrize("it_value,fires", [(300, False), (301, True), (450, True), (280, False)])
def test_sector_fires_above_30_percent_as_a_warning(it_value, fires):
    items = by_prefix(run(sector_book(it_value)), "sector:")
    assert ("sector:IT" in items) is fires
    if fires:
        s = items["sector:IT"]
        assert s["severity"] == "warning" and s["category"] == "risk" and s["link"] == "/risk#concentration"
        assert s["amount"] == it_value  # actions.py reads the sector value from amount


@pytest.mark.parametrize("it_value,fires", [(300, True), (280, True), (279, False), (500, True)])
def test_an_open_sector_row_keeps_firing_while_share_is_at_least_28(it_value, fires):
    items = by_prefix(run(sector_book(it_value), open_ids={"sector:IT"}), "sector:")
    assert ("sector:IT" in items) is fires
    if fires:
        assert items["sector:IT"]["severity"] == "warning"


def test_unclassified_stocks_never_make_a_sector_row():
    pos = [P(1, d.EQUITY, "Mystery", 900, 1.0, symbol="A"), P(2, d.EQUITY, "IT Co", 100, 1.0, sector="IT", symbol="B")]
    assert by_prefix(run(pos, open_ids={"sector:Unclassified"}), "sector:") == {}


# ── drift (warning ≥ 5, info ≥ 2.5) ──

@pytest.mark.parametrize("drift,severity", [(5.0, "warning"), (-5.0, "warning"), (12.0, "warning"),
                                            (4.9, "info"), (-2.5, "info"), (2.5, "info"), (2.4, None), (0.0, None)])
def test_drift_bands(drift, severity):
    segs = [{"segment": d.SEG_EQ_IN, "value": 600000, "mix_pct": 60 + drift, "target": 60, "drift": drift},
            {"segment": d.SEG_FD, "value": 400000, "mix_pct": 40 - drift, "target": 40, "drift": -drift}]
    items = by_prefix(run([P(1, d.FIXED_DEPOSIT, "FD", 400000, 40.0)], segs), "drift:")
    row = items.get(f"drift:{d.SEG_EQ_IN}")
    assert (row["severity"] if row else None) == severity
    if row:
        assert row["link"] == "/risk#rebalance" and row["category"] == "allocation"
        assert row["amount"] == pytest.approx(abs(drift) / 100 * 1_000_000)


def test_off_target_rupees_use_the_targeted_value_like_the_drift_actions():
    """W5 review: Risk & mix's T0 "Off target ≈ ₹X to move" is Σ|drift| × targeted value / 200 (SPEC §5.6),
    mirrored here from `risk-mix.component.ts` `offTarget` over `brief._allocation`. An untargeted EPF balance is
    outside the mix the drift is measured in, so it must not inflate the figure past the drift actions' own."""
    from tracker.analytics.brief import _allocation
    from tracker.analytics.portfolio import compute_portfolio

    def tx(id_, iid, qty, amount):
        return {"id": id_, "instrument_id": iid, "date": "2025-01-10", "type": d.BUY, "quantity": qty, "amount": amount,
                "amount_fc": None, "principal": None, "fees": None, "owner": "a"}

    def inst(id_, ac, name, **kw):
        base = {"id": id_, "owner": "a", "asset_class": ac, "name": name, "currency": "INR", "status": "active", **kw}
        base["tax_class"] = d.default_tax_class(ac, None, None, name)
        return base

    targets = {d.SEG_EQ_IN: 50, "Mutual Funds": 50}
    p = compute_portfolio([inst(1, d.EQUITY, "Infy", last_price=100.0), inst(2, d.MUTUAL_FUND, "Index", last_price=100.0),
                           inst(3, d.EPF, "EPF", rate=8.25)],
                          [tx(1, 1, 7000, 700000), tx(2, 2, 3000, 300000), tx(3, 3, None, 1000000)],
                          None, targets=targets, today=TODAY)
    rows = _allocation(p)
    epf = next(r for r in rows if r["target"] is None)
    assert epf["value"] > 1_000_000                                  # bigger than the whole targeted mix
    targeted = sum(max(0, r["value"]) for r in rows if r["target"] is not None)
    assert targeted == pytest.approx(1_000_000)
    off_inr = sum(abs(r["drift"]) for r in rows if r["drift"] is not None) * targeted / 200
    assert off_inr == pytest.approx(200000)
    items = by_prefix(build_insights(p, None, [], {"lastReviewDate": TODAY.isoformat(), "targetAllocation": targets},
                                     today=TODAY, sips=[], txns=[]), "drift:")
    assert len(items) == 2
    assert [i["amount"] for i in items.values()] == [pytest.approx(off_inr)] * 2   # each side moves the same ₹2,00,000


def test_targets_missing_points_at_the_mix_section():
    items = run([P(1, d.FIXED_DEPOSIT, "FD", 400000, 40.0)],
                [{"segment": d.SEG_FD, "value": 400000, "mix_pct": None, "target": None, "drift": None}])
    row = next(i for i in items if i["id"] == "targets:missing")
    assert row["link"] == "/risk#mix" and row["severity"] == "info"


# ── tax:ltcg-harvest (warning in Jan–Mar; needs remaining_exemption ≥ HARVEST_FLOOR) ──

def harvest_tax(booking, remaining):
    return {"opportunities": {"ltcg_harvest": {"suggested_booking": booking, "remaining_exemption": remaining},
                              "loss_harvest_offsettable": 0, "upcoming_long_term": []}}


def test_the_harvest_floor_is_the_one_actions_uses():
    assert ins.HARVEST_FLOOR is A.HARVEST_FLOOR == 2000


@pytest.mark.parametrize("today,severity", [(date(2027, 1, 5), "warning"), (date(2027, 2, 20), "warning"),
                                            (date(2027, 3, 31), "warning"), (date(2026, 4, 1), "info"),
                                            (date(2026, 11, 14), "info"), (date(2026, 12, 31), "info")])
def test_ltcg_harvest_is_a_warning_in_q4(today, severity):
    items = by_prefix(run([P(1, d.EQUITY, "Stock", 1000, 1.0, symbol="A")], tax=harvest_tax(50000, 50000),
                          today=today), "tax:ltcg")
    assert items["tax:ltcg-harvest"]["severity"] == severity
    assert items["tax:ltcg-harvest"]["link"] == "/tax" and items["tax:ltcg-harvest"]["amount"] == 50000


@pytest.mark.parametrize("booking,remaining,fires", [
    (50000, A.HARVEST_FLOOR, True), (50000, A.HARVEST_FLOOR - 1, False), (1500, A.HARVEST_FLOOR, True),
    (1000, 50000, False), (1001, 50000, True), (50000, 0, False),
])
def test_ltcg_harvest_needs_the_floor_and_a_booking_over_1000(booking, remaining, fires):
    items = run([P(1, d.EQUITY, "Stock", 1000, 1.0, symbol="A")], tax=harvest_tax(booking, remaining),
                today=date(2027, 2, 1))
    assert ("tax:ltcg-harvest" in {i["id"] for i in items}) is fires


# ── nps:nav-stale:<iid> (hand-priced NPS, NAV > 30 days old) ──

def nps(id_=8, days_old=31, value=50000.0, **kw):
    return P(id_, d.NPS, "NPS Tier I", value, 5.0, price_at=(TODAY - timedelta(days=days_old)).isoformat() + "T00:00:00Z",
             **kw)


def test_nps_nav_stale_fires_after_30_days_not_at_30():
    stale = {i["id"]: i for i in run([nps(days_old=31)])}
    row = stale["nps:nav-stale:8"]
    assert (row["severity"], row["category"], row["link"], row["amount"]) == ("info", "data", "/nps", 50000)
    assert "31 days" in row["title"]
    assert "nps:nav-stale:8" not in {i["id"] for i in run([nps(days_old=30)])}
    assert "nps:nav-stale:8" not in {i["id"] for i in run([nps(days_old=0)])}


def test_hand_priced_nps_leaves_stale_prices():
    # 31 days old against TODAY is far more than 4 days against the wall clock, yet data:stale-prices stays quiet
    ids = {i["id"] for i in run([nps(days_old=31)])}
    assert "data:stale-prices" not in ids
    ids = {i["id"] for i in run([nps(days_old=400)])}
    assert ids >= {"nps:nav-stale:8"} and "data:stale-prices" not in ids


def test_symbol_priced_nps_stays_under_stale_prices():
    items = {i["id"]: i for i in run([nps(days_old=31, symbol="SM001001")])}
    assert not by_prefix(items.values(), "nps:nav-stale:")
    assert items["data:stale-prices"]["link"] == "/settings#prices"


@pytest.mark.parametrize("kw", [{"value": 0.0}, {"is_open": False}, {"price_at": None}, {"price_at": "not a date"}])
def test_nps_nav_stale_needs_an_open_valued_dated_position(kw):
    pos = nps(days_old=90)
    pos.update(kw)
    other = P(1, d.FIXED_DEPOSIT, "FD", 100000, 50.0)  # keeps the portfolio non-empty
    assert not by_prefix(run([other, pos]), "nps:nav-stale:")


# ── elss:unlocked:<iid> ──

def test_elss_unlocked_fires_with_unlocked_value():
    pos = P(3, d.MUTUAL_FUND, "Tax Saver", 80000, 8.0, symbol="X",
            elss={"unlocked_value": 5000.0, "unlocked_qty": 50.0, "next_unlock": "2027-02-01"})
    row = next(i for i in run([pos]) if i["id"] == "elss:unlocked:3")
    assert (row["severity"], row["category"], row["link"], row["amount"]) == ("info", "tax", "/holding/3", 5000)
    pos["elss"]["unlocked_value"] = 0
    assert "elss:unlocked:3" not in {i["id"] for i in run([pos])}


# ── ids that must not change (A8, D11) ──

def test_review_due_keeps_its_id_and_its_90_day_rule():
    pos = [P(1, d.FIXED_DEPOSIT, "FD", 100000, 50.0)]
    due = {i["id"]: i for i in run(pos, settings={"lastReviewDate": (TODAY - timedelta(days=91)).isoformat()})}
    assert due["review:due"]["link"] == "/actions?tab=review"   # the review wizard (W7-F4; final pass)
    assert "review:due" not in {i["id"] for i in run(pos, settings={"lastReviewDate": (TODAY - timedelta(days=90)).isoformat()})}
    assert "review:due" in {i["id"] for i in run(pos, settings={})}
    assert not any(i["id"].startswith("review:due:") for i in run(pos, settings={}))


def test_goal_link_carries_the_goal_fragment():
    goal = {"id": 7, "name": "House", "target_amount": 5000000, "target_date": "2030-06-30", "monthly_contribution": 1000,
            "projection": {"status": "at_risk", "probability": 55.0, "required_sip": 9000}}
    items = build_insights(port([P(1, d.FIXED_DEPOSIT, "FD", 100000, 50.0)]), None, [goal],
                           {"lastReviewDate": TODAY.isoformat()}, today=TODAY)
    row = next(i for i in items if i["id"] == "goal:7")
    assert row["link"] == "/plan?tab=goals#goal-7" and row["severity"] == "info"


def test_diversification_links_to_the_equity_holdings():
    items = run([P(1, d.EQUITY, "Only Co", 1000, 1.0, symbol="A")])
    assert next(i for i in items if i["id"] == "diversification:stocks")["link"] == "/holdings/equity"
