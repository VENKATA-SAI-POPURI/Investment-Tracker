"""W3-B3: tax.what_if_sale and tax.harvest_plan at engine level (SPEC §6.9, AMENDMENTS G11, A12, D12, D16)."""
from datetime import date

import pytest

from tracker import domain as d
from tracker.analytics.portfolio import compute_portfolio
from tracker.analytics.tax import (CHARGES_NOTE, REBUY_NOTE, WhatIfError, compute_tax, harvest_plan,
                                   open_lot_view, what_if_sale)

TODAY = date(2025, 12, 1)          # FY2025-26, post-July-2024 rates: STCG 20%, LTCG 12.5% over ₹1.25L
FY = "FY2025-26"


def T(id_, iid, date_, type_, qty=None, amount=0.0, fc=None):
    return {"id": id_, "instrument_id": iid, "date": date_, "type": type_, "quantity": qty, "amount": amount,
            "amount_fc": fc, "principal": None, "fees": None, "owner": "a"}


def I(id_, ac, name, **kw):
    base = {"id": id_, "owner": "a", "asset_class": ac, "name": name, "currency": "INR", "status": "active"}
    base.update(kw)
    base["tax_class"] = d.default_tax_class(ac, base.get("market"), base.get("category"), name)
    return base


def book(inst, txns, usd_inr=None, today=TODAY):
    return compute_portfolio(inst, txns, usd_inr, today=today), txns, inst


def whatif(port, txns, inst, iid, qty, **kw):
    kw.setdefault("today", TODAY)
    return what_if_sale(port, txns, inst, iid, qty, **kw)


# ── what_if_sale ──

def test_long_term_within_exemption_is_tax_free():
    port, txns, inst = book([I(1, d.EQUITY, "Infy", last_price=1500.0)],
                            [T(1, 1, "2024-01-10", d.BUY, 100, 100000)])
    r = whatif(port, txns, inst, 1, 100)
    assert r["gain"] == pytest.approx(50000)
    assert r["lt_gain"] == pytest.approx(50000) and r["st_gain"] == 0
    assert r["tax_now"] == 0
    assert r["exemption_used"] == pytest.approx(50000)
    assert r["exemption_left"] == pytest.approx(75000)
    assert r["net_cash"] == pytest.approx(150000)
    assert r["price"] == 1500.0                      # D16: defaults to the position price
    assert r["sell_date"] == TODAY.isoformat() and r["fy"] == FY
    assert r["lots"] == [{"date": "2024-01-10", "qty": 100, "cost": 100000, "proceeds": 150000, "gain": 50000,
                          "term": "LTCG", "rate_pct": 12.5, "lt_on": "2025-01-10"}]
    assert r["wait"] is None
    assert r["effective_pct"] == 0
    assert CHARGES_NOTE in r["note"] and "30% slab incl. 4% cess" in r["note"]


def test_short_term_50k_gain_costs_10400():
    port, txns, inst = book([I(1, d.EQUITY, "Infy", last_price=1500.0)],
                            [T(1, 1, "2025-06-01", d.BUY, 100, 100000)])
    r = whatif(port, txns, inst, 1, 100)
    assert r["st_gain"] == pytest.approx(50000)
    assert r["tax_now"] == pytest.approx(10400)      # 50,000 × 20% × 1.04
    assert r["effective_pct"] == pytest.approx(20.8)
    assert r["net_cash"] == pytest.approx(150000 - 10400)
    assert r["lots"][0]["term"] == "STCG" and r["lots"][0]["rate_pct"] == 20.0
    assert r["lots"][0]["lt_on"] == "2026-06-02"
    assert r["wait"] is None                         # turns long-term 183 days out, beyond 90


def test_difference_method_keeps_this_years_set_off():
    # A ₹20k short-term loss already booked this FY absorbs part of the new ₹50k gain
    inst = [I(1, d.EQUITY, "Infy", last_price=1500.0), I(2, d.EQUITY, "Loser", last_price=1.0)]
    txns = [T(1, 1, "2025-06-01", d.BUY, 100, 100000),
            T(2, 2, "2025-05-01", d.BUY, 10, 50000), T(3, 2, "2025-07-01", d.SELL, 10, 30000)]
    port, txns, inst = book(inst, txns)
    r = whatif(port, txns, inst, 1, 100)
    assert r["tax_now"] == pytest.approx(30000 * 0.20 * 1.04)


def test_wait_hint_reports_saving_when_lot_turns_long_term_soon():
    port, txns, inst = book([I(1, d.EQUITY, "Infy", last_price=1500.0)],
                            [T(1, 1, "2025-01-15", d.BUY, 100, 100000)])
    r = whatif(port, txns, inst, 1, 100)
    assert r["tax_now"] == pytest.approx(10400)
    w = r["wait"]
    assert w["date"] == "2026-01-16" and w["days"] == 46
    assert w["tax_then"] == 0                        # long-term and inside the exemption
    assert w["saving"] == pytest.approx(10400)


def test_wait_hint_absent_when_waiting_saves_nothing():
    # A short-term loss: waiting cannot lower the tax, so no hint
    port, txns, inst = book([I(1, d.EQUITY, "Infy", last_price=800.0)],
                            [T(1, 1, "2025-01-15", d.BUY, 100, 100000)])
    r = whatif(port, txns, inst, 1, 100)
    assert r["gain"] == pytest.approx(-20000) and r["tax_now"] == 0
    assert r["wait"] is None and r["effective_pct"] is None


def test_elss_locked_units_raise_with_next_unlock():
    inst = [I(1, d.MUTUAL_FUND, "Tax Saver", category="ELSS", last_price=50.0)]
    txns = [T(1, 1, "2022-06-01", d.BUY, 10, 300), T(2, 1, "2023-03-01", d.BUY, 10, 400)]
    port, txns, inst = book(inst, txns)
    assert whatif(port, txns, inst, 1, 10)["qty"] == 10          # the 2022 lot unlocked on 2025-06-01
    with pytest.raises(WhatIfError, match="2026-03-01"):
        whatif(port, txns, inst, 1, 15)
    with pytest.raises(ValueError):                              # the API maps ValueError to 400
        whatif(port, txns, inst, 1, 15)
    # by 2026-03-01 every unit is free
    assert whatif(port, txns, inst, 1, 20, sell_date="2026-03-01")["qty"] == 20


def test_leap_day_elss_lot_unlocks_on_1_march_in_portfolio_and_what_if():
    # W3 integration: portfolio's `elss` block and tax share portfolio.elss_unlock, so a 29 Feb lot never raises
    inst = [I(1, d.MUTUAL_FUND, "Tax Saver", category="ELSS", last_price=50.0)]
    txns = [T(1, 1, "2024-02-29", d.BUY, 10, 300)]
    port, txns, inst = book(inst, txns)
    pos = next(p for p in port["positions"] if p["id"] == 1)
    assert pos["elss"]["next_unlock"] == "2027-03-01" and pos["elss"]["locked_qty"] == 10
    with pytest.raises(WhatIfError, match="2027-03-01"):
        whatif(port, txns, inst, 1, 10)


def test_qty_above_holding_raises():
    port, txns, inst = book([I(1, d.EQUITY, "Infy", last_price=1500.0)],
                            [T(1, 1, "2024-01-10", d.BUY, 100, 100000)])
    with pytest.raises(WhatIfError, match="You hold only 100 units"):
        whatif(port, txns, inst, 1, 101)


@pytest.mark.parametrize("kw, msg", [
    ({"qty": 0}, "more than 0"),
    ({"qty": -5}, "more than 0"),
    ({"qty": 1, "sell_date": "2025-11-30"}, "past"),
    ({"qty": 1, "sell_date": "2026-12-02"}, "365 days"),
    ({"qty": 1, "sell_date": "soon"}, "YYYY-MM-DD"),
    ({"qty": 1, "price": -1}, "Price"),
])
def test_input_errors(kw, msg):
    port, txns, inst = book([I(1, d.EQUITY, "Infy", last_price=1500.0)],
                            [T(1, 1, "2024-01-10", d.BUY, 100, 100000)])
    qty = kw.pop("qty")
    with pytest.raises(WhatIfError, match=msg):
        whatif(port, txns, inst, 1, qty, **kw)


def test_unknown_untradable_and_unpriced_holdings_raise():
    inst = [I(1, d.EQUITY, "Infy", last_price=None), I(2, d.FIXED_DEPOSIT, "Bank FD", rate=7.0,
                                                      maturity_date="2026-06-01", tenure_months=12)]
    txns = [T(1, 1, "2024-01-10", d.BUY, 100, 100000), T(2, 2, "2025-06-01", d.BUY, None, 100000)]
    port, txns, inst = book(inst, txns)
    with pytest.raises(WhatIfError, match="No such holding"):
        whatif(port, txns, inst, 99, 1)
    with pytest.raises(WhatIfError, match="not a tradable"):
        whatif(port, txns, inst, 2, 1)
    with pytest.raises(WhatIfError, match="no price"):
        whatif(port, txns, inst, 1, 10)
    r = whatif(port, txns, inst, 1, 10, price=1200)              # an explicit price is enough
    assert r["proceeds"] == pytest.approx(12000) and r["gain"] == pytest.approx(2000)


def test_usd_stock_converts_at_port_fx():
    inst = [I(1, d.EQUITY, "NVDA", market="USA", currency="USD", last_price=110.0)]
    txns = [T(1, 1, "2025-01-01", d.BUY, 2, 17000, fc=200)]
    port, txns, inst = book(inst, txns, usd_inr=90.0)
    r = whatif(port, txns, inst, 1, 1)
    assert r["currency"] == "USD" and r["price"] == 110.0
    assert r["amount_fc"] == pytest.approx(110)
    assert r["proceeds"] == pytest.approx(110 * 90)              # qty × price × usd_inr
    assert r["cost"] == pytest.approx(8500)
    assert r["gain"] == pytest.approx(1400)
    # foreign equity held under 24 months: short-term at the slab rate
    assert r["lots"][0]["term"] == "STCG" and r["lots"][0]["rate_pct"] is None
    assert r["tax_now"] == pytest.approx(1400 * 0.30 * 1.04)


def test_same_day_buy_matches_first_as_intraday():
    inst = [I(1, d.EQUITY, "Infy", last_price=1500.0)]
    txns = [T(1, 1, "2024-01-10", d.BUY, 10, 10000), T(2, 1, TODAY.isoformat(), d.BUY, 10, 14000)]
    port, txns, inst = book(inst, txns)
    r = whatif(port, txns, inst, 1, 10)
    assert [l["date"] for l in r["lots"]] == [TODAY.isoformat()]
    lot = r["lots"][0]
    assert lot["term"] == "Intraday" and lot["rate_pct"] is None and lot["lt_on"] is None
    assert lot["gain"] == pytest.approx(1000)
    assert r["tax_now"] == pytest.approx(1000 * 0.30 * 1.04)    # speculative income at the slab
    # selling more reaches the old lot after the intraday match
    r2 = whatif(port, txns, inst, 1, 15)
    assert [(l["date"], l["term"]) for l in r2["lots"]] == [(TODAY.isoformat(), "Intraday"), ("2024-01-10", "LTCG")]


def test_slab_rate_is_honoured_and_named_in_note():
    port, txns, inst = book([I(1, d.MUTUAL_FUND, "Gilt Fund", category="Debt", last_price=12.0)],
                            [T(1, 1, "2025-01-01", d.BUY, 1000, 10000)])
    r = whatif(port, txns, inst, 1, 1000, slab_rate=0.20)
    assert r["tax_now"] == pytest.approx(2000 * 0.20 * 1.04)
    assert "20% slab" in r["note"]


# ── harvest_plan ──

def _harvest_book():
    inst = [I(1, d.MUTUAL_FUND, "Flexi Cap", category="Flexi Cap", last_price=2000.0),
            I(2, d.MUTUAL_FUND, "Large Cap", category="Large Cap", last_price=2000.0),
            I(3, d.MUTUAL_FUND, "Mid Cap", category="Mid Cap", last_price=1000.0),
            I(4, d.EQUITY, "Short Co", last_price=2000.0)]
    txns = [T(1, 1, "2023-01-02", d.BUY, 100, 100000),            # gain 1,00,000 on 2,00,000 (0.50)
            T(2, 2, "2023-06-01", d.BUY, 100, 150000),            # gain 50,000 on 2,00,000 (0.25)
            T(3, 3, "2023-02-01", d.BUY, 100, 120000),            # an older lot at a loss blocks...
            T(4, 3, "2023-03-01", d.BUY, 100, 50000),             # ...this gain lot (FIFO sells the loss first)
            T(5, 4, "2025-09-01", d.BUY, 100, 100000)]            # short-term: never in the plan
    return book(inst, txns)


def test_harvest_plan_stops_1000_below_exemption_with_one_partial_lot():
    port, _, inst = _harvest_book()
    plan = harvest_plan(port, inst, 125000.0, TODAY)
    assert plan["total_gain"] == pytest.approx(124000)          # remaining − ₹1,000
    assert [r["instrument_id"] for r in plan["rows"]] == [1, 2]   # best gain/value first
    a, b = plan["rows"]
    assert a["qty"] == 100 and a["gain"] == pytest.approx(100000) and not a["lots"][0]["partial"]
    assert b["qty"] == pytest.approx(48) and b["gain"] == pytest.approx(24000)
    assert b["proceeds"] == pytest.approx(96000)
    assert [l["partial"] for r in plan["rows"] for l in r["lots"]] == [False, True]   # exactly one partial
    assert plan["future_tax_saved"] == pytest.approx(124000 * 0.125)                  # no cess (G11)
    assert plan["note"] == f"{REBUY_NOTE} {CHARGES_NOTE}"


def test_harvest_plan_rounds_partial_stock_lots_to_whole_shares():
    inst = [I(1, d.EQUITY, "Infy", last_price=1500.0)]
    txns = [T(1, 1, "2024-01-10", d.BUY, 100, 100000)]            # ₹500 gain a share
    port, _, inst = book(inst, txns)
    plan = harvest_plan(port, inst, 11250.0, TODAY)               # target 10,250 → 20.5 shares → 20
    assert plan["rows"][0]["qty"] == 20 and plan["total_gain"] == pytest.approx(10000)


def test_harvest_plan_empty_when_exemption_nearly_used():
    port, _, inst = _harvest_book()
    plan = harvest_plan(port, inst, 900.0, TODAY)
    assert plan["rows"] == [] and plan["total_gain"] == 0 and plan["future_tax_saved"] == 0


def test_harvest_plan_skips_locked_elss():
    inst = [I(1, d.MUTUAL_FUND, "Tax Saver", category="ELSS", last_price=50.0)]
    port, _, inst = book(inst, [T(1, 1, "2023-06-01", d.BUY, 1000, 20000)])   # long-term but locked to 2026
    assert open_lot_view(port, inst, TODAY)[0]["term"] == "LTCG"
    assert harvest_plan(port, inst, 125000.0, TODAY)["rows"] == []


def test_harvest_plan_in_opportunities_only_for_current_fy():
    port, txns, inst = _harvest_book()
    cur = compute_tax(port, txns, inst, FY, 0.30, today=TODAY)["opportunities"]
    assert cur["harvest_plan"]["total_gain"] == pytest.approx(124000)
    # the existing keys are unchanged
    assert {"loss_harvest", "loss_harvest_total", "loss_harvest_offsettable", "ltcg_harvest",
            "upcoming_long_term", "open_lots"} <= set(cur)
    assert cur["ltcg_harvest"]["future_tax_saved"] == pytest.approx(cur["ltcg_harvest"]["suggested_booking"] * 0.125)
    past = compute_tax(port, txns, inst, "FY2024-25", 0.30, today=TODAY)["opportunities"]["harvest_plan"]
    assert past == {"rows": [], "total_gain": 0.0, "future_tax_saved": 0.0, "note": f"{REBUY_NOTE} {CHARGES_NOTE}"}


def test_harvest_insight_action_and_tax_page_quote_the_plan_they_link_to():
    """Wave-3 review: with the exemption binding, min(gain, remaining) = 1,25,000 but the plan books 1,24,000
    (₹1,000 buffer, FIFO, whole shares). The Tax page figure, the insight and the action all read the plan."""
    from tracker.analytics import actions as A
    from tracker.analytics.insights import build_insights
    port, txns, inst = _harvest_book()
    t = compute_tax(port, txns, inst, FY, 0.30, today=TODAY)
    opp = t["opportunities"]
    plan, lt = opp["harvest_plan"], opp["ltcg_harvest"]
    assert lt["unrealized_lt_equity_gain"] > lt["remaining_exemption"] == pytest.approx(125000)   # exemption binds
    assert lt["suggested_booking"] == plan["total_gain"] == pytest.approx(124000)
    assert lt["future_tax_saved"] == plan["future_tax_saved"] == pytest.approx(15500)

    items = build_insights(port, t, [], {"lastReviewDate": TODAY.isoformat()}, today=TODAY, sips=[], txns=txns)
    row = next(i for i in items if i["id"] == "tax:ltcg-harvest")
    assert row["amount"] == plan["total_gain"] and "₹1,24,000" in row["title"]

    act = next(a for a in A.build_actions({"owner": "a", "tax": t}, {}, TODAY) if a["id"] == f"tax:ltcg-harvest:{FY}")
    assert act["impact"]["amount"] == plan["future_tax_saved"]
    assert act["meta"]["suggested_booking"] == plan["total_gain"] and "₹1,24,000" in act["title"]


# ── W5 review: the units the pages prefill must reach the lots they name (what_if_sale sells FIFO) ──
# No frontend test runner (A4), so these mirror `frontend/src/app/core/tax-lots.ts` and pin the engine behaviour
# that makes the cumulative quantities necessary.

def _fifo(iid, open_lots):
    return [l for _, l in sorted(((i, l) for i, l in enumerate(open_lots) if l["instrument_id"] == iid),
                                 key=lambda x: (x[1]["date"], x[0]))]


def _units_up_to(lot, open_lots):                     # tax-lots.ts unitsUpTo
    mine = _fifo(lot["instrument_id"], open_lots)
    for k, l in enumerate(mine):
        if l["date"] == lot["date"] and abs(l["qty"] - lot["qty"]) < 1e-9:
            return round(sum(x["qty"] for x in mine[:k + 1]), 6)
    return lot["qty"]


def _loss_sale_qty(row, open_lots, today_iso):        # tax-lots.ts lossSaleQty
    mine = _fifo(row["instrument_id"], open_lots)
    ks = [k for k, l in enumerate(mine) if l["gain"] < 0 and (not l["locked_until"] or l["locked_until"] <= today_iso)]
    return round(sum(x["qty"] for x in mine[:ks[-1] + 1]), 6) if ks else row["qty"]


def test_loss_row_units_alone_sell_the_older_gain_lot_so_the_page_sends_units_up_to_the_newest_loss_lot():
    port, txns, inst = book([I(1, d.EQUITY, "Infy", last_price=1500.0)],
                            [T(1, 1, "2024-01-10", d.BUY, 10, 10000),     # older lot, in gain at 1,500
                             T(2, 1, "2025-09-01", d.BUY, 10, 18000)])    # newer lot, ₹3,000 below cost
    opp = compute_tax(port, txns, inst, FY, 0.30, today=TODAY)["opportunities"]
    row = opp["loss_harvest"][0]
    assert row["qty"] == 10 and row["st_loss"] == pytest.approx(3000)    # the loss lots' own units only
    alone = whatif(port, txns, inst, 1, row["qty"])
    assert [l["date"] for l in alone["lots"]] == ["2024-01-10"] and alone["gain"] == pytest.approx(5000)   # no loss booked
    qty = _loss_sale_qty(row, opp["open_lots"], TODAY.isoformat())
    assert qty == 20
    r = whatif(port, txns, inst, 1, qty)
    assert r["st_gain"] == pytest.approx(-3000) and r["lt_gain"] == pytest.approx(5000)   # the promised loss is booked


def test_loss_row_whose_loss_lot_is_oldest_sends_its_own_units():
    port, txns, inst = book([I(1, d.EQUITY, "Infy", last_price=1500.0)],
                            [T(1, 1, "2024-01-10", d.BUY, 10, 18000),     # oldest lot is the loss
                             T(2, 1, "2025-09-01", d.BUY, 10, 10000)])
    opp = compute_tax(port, txns, inst, FY, 0.30, today=TODAY)["opportunities"]
    row = opp["loss_harvest"][0]
    assert _loss_sale_qty(row, opp["open_lots"], TODAY.isoformat()) == row["qty"] == 10
    assert whatif(port, txns, inst, 1, 10)["lt_gain"] == pytest.approx(-3000)


def test_wait_row_needs_the_units_up_to_its_lot_for_the_wait_hint():
    port, txns, inst = book([I(1, d.EQUITY, "Infy", last_price=1500.0)],
                            [T(1, 1, "2024-01-10", d.BUY, 10, 10000),     # already long-term
                             T(2, 1, "2025-01-15", d.BUY, 10, 12000)])    # long-term on 2026-01-16
    opp = compute_tax(port, txns, inst, FY, 0.30, today=TODAY)["opportunities"]
    lot = opp["upcoming_long_term"][0]
    assert lot["date"] == "2025-01-15" and lot["qty"] == 10
    alone = whatif(port, txns, inst, 1, lot["qty"])              # Actions' old prefill: sells the older lot
    assert [l["term"] for l in alone["lots"]] == ["LTCG"] and alone["wait"] is None
    qty = _units_up_to(lot, opp["open_lots"])
    assert qty == 20
    r = whatif(port, txns, inst, 1, qty)
    assert r["tax_now"] > 0 and r["wait"]["date"] == "2026-01-16" and r["wait"]["saving"] == pytest.approx(r["tax_now"])

