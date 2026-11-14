"""Indian capital-gains estimate per financial year, plus harvesting opportunities.

Rules encoded (resident individual, as amended by Finance (No.2) Act 2024):
  * Listed equity / equity MFs (s.111A/112A): long-term if held > 12 months.
    STCG 20% (15% for transfers before 23-Jul-2024); LTCG 12.5% (10% before) above an annual
    exemption of ₹1.25 lakh (₹1 lakh up to FY2023-24).
  * Foreign equity / overseas FoFs: long-term if held > 24 months, LTCG 12.5% (20% before
    23-Jul-2024); short-term gains at slab rate.
  * Other listed units (gold/silver ETFs): long-term if held > 12 months, LTCG 12.5%; STCG at slab.
  * Specified (debt) MFs: slab rate regardless of holding period.
  * Same-day equity round trips: speculative business income at slab rate.
  * Short-term losses set off against any capital gain; long-term losses only against LTCG.
  * Health & education cess 4% on the computed tax. Surcharge is not modelled.
This is an estimate for planning, not tax advice.

Also here (SPEC §6.9, AMENDMENTS G11):
  * `what_if_sale` prices a hypothetical sale as the difference between two `compute_tax` runs, so
    this FY's set-off and exemption use stay exactly as they are; it hints when waiting a few weeks
    turns short-term lots long-term.
  * `harvest_plan` lists the long-term equity lots to book (and rebuy) inside the unused exemption.
    In the current FY `ltcg_harvest.suggested_booking` / `future_tax_saved` are the plan's
    `total_gain` / `future_tax_saved`, so every surface quotes the amount the plan actually books.
  * `plan_sales` (P2, AMENDMENTS K12) picks which holdings to sell to free an amount per segment, lowest
    tax first, and costs the sales together so the exemption is used once. `goals.rebalance_plan` and
    `optimizer.suggest` share it.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import asdict
from datetime import date, timedelta

from .. import domain as d
from .portfolio import EPS, RealizedLot, elss_unlock, run_fifo, to_date, _f

CUTOFF = "2024-07-23"
CESS = 0.04
EQUITY_EXEMPTION_NEW = 125000.0
EQUITY_EXEMPTION_OLD = 100000.0

WAIT_WINDOW_DAYS = 90         # what_if_sale: hint to wait when a consumed lot turns long-term within this
MAX_AHEAD_DAYS = 365          # what_if_sale: furthest sell_date accepted
HARVEST_BUFFER = 1000.0       # harvest_plan stops at remaining_exemption − this (A12)
HARVEST_LT_RATE = 0.125       # future_tax_saved basis: 12.5%, before the 4% cess (G11)
CHARGES_NOTE = "Brokerage, STT and stamp duty from imports are not deducted."   # D12
REBUY_NOTE = "Rebuy the next trading day — a same-day rebuy is netted as intraday and books nothing."
PLAN_MIN_SELL = 500.0         # plan_sales: after the first sell, a leg stops when less than this is left to free


class WhatIfError(ValueError):
    """A what-if sale that cannot be priced; the API maps it (a ValueError) to 400 with this message."""


def rule_for(tax_class: str, sell_date: str) -> dict:
    post = sell_date >= CUTOFF
    if tax_class == d.TAX_EQUITY:
        return {"lt_days": 365, "st_rate": 0.20 if post else 0.15, "lt_rate": 0.125 if post else 0.10, "exempt": True}
    if tax_class == d.TAX_FOREIGN:
        return {"lt_days": 730, "st_rate": None, "lt_rate": 0.125 if post else 0.20, "exempt": False}
    if tax_class == d.TAX_LISTED_OTHER:
        return {"lt_days": 365 if post else 1095, "st_rate": None, "lt_rate": 0.125 if post else 0.20, "exempt": False}
    return {"lt_days": None, "st_rate": None, "lt_rate": None, "exempt": False}  # debt / other: slab


def exemption_for(fy: str) -> float:
    return EQUITY_EXEMPTION_NEW if int(fy[2:6]) >= 2024 else EQUITY_EXEMPTION_OLD


def classify(tax_class: str, buy_date: str, sell_date: str, intraday: bool) -> tuple[str, float | None, bool]:
    """-> (term, rate or None for slab, eligible for equity exemption)"""
    if intraday and tax_class == d.TAX_EQUITY:
        return "Intraday", None, False
    r = rule_for(tax_class, sell_date)
    held = (to_date(sell_date) - to_date(buy_date)).days
    if r["lt_days"] is not None and held > r["lt_days"]:
        return "LTCG", r["lt_rate"], r["exempt"]
    return "STCG", r["st_rate"], False


def compute_tax(portfolio: dict, txns: list[dict], instruments: list[dict], fy: str, slab_rate: float,
                today: date | None = None, *, with_opportunities: bool = True) -> dict:
    """The FY estimate. `with_opportunities=False` skips the harvesting scan (`opportunities` is then
    None); `what_if_sale` uses it because it only reads the estimate and the exemption."""
    today = today or date.today()
    inst = {i["id"]: i for i in instruments}
    start, end = d.fy_bounds(fy)

    # ── realized gains in FY ──
    lots = []
    for r in portfolio["realized_lots"]:
        if not (start <= r["sell_date"] <= end):
            continue
        i = inst.get(r["instrument_id"]) or {}
        tc = i.get("tax_class") or d.default_tax_class(i.get("asset_class", ""), i.get("market"), i.get("category"), i.get("name"))
        term, rate, exempt = classify(tc, r["buy_date"], r["sell_date"], r["intraday"])
        lots.append({
            "instrument_id": r["instrument_id"], "name": i.get("name"), "asset_class": i.get("asset_class"),
            "tax_class": tc, "buy_date": r["buy_date"], "sell_date": r["sell_date"], "holding_days": r["holding_days"],
            "qty": round(r["qty"], 6), "cost": round(r["cost"], 2), "proceeds": round(r["proceeds"], 2),
            "gain": round(r["gain"], 2), "term": term, "rate": rate, "exempt_eligible": exempt,
        })

    # buckets keyed by (term_group, rate, exempt) — slab buckets use rate=slab
    buckets: dict[tuple, float] = defaultdict(float)
    for l in lots:
        group = "LT" if l["term"] == "LTCG" else "ST"
        rate = l["rate"] if l["rate"] is not None else slab_rate
        buckets[(group, rate, l["exempt_eligible"])] += l["gain"]

    st_loss = -sum(v for (g, _, _), v in buckets.items() if g == "ST" and v < 0)
    lt_loss = -sum(v for (g, _, _), v in buckets.items() if g == "LT" and v < 0)
    gains = {k: v for k, v in buckets.items() if v > 0}

    def offset(loss: float, keys: list[tuple]) -> float:
        # highest-rate gains first; within LT, non-exempt before exempt (the exemption shields the rest)
        for k in sorted(keys, key=lambda k: (-k[1], k[2])):
            if loss <= 0:
                break
            used = min(gains[k], loss)
            gains[k] -= used
            loss -= used
        return loss

    lt_loss_left = offset(lt_loss, [k for k in gains if k[0] == "LT"])
    st_loss_left = offset(st_loss, list(gains))
    exemption = exemption_for(fy)
    exempt_gain = sum(v for k, v in gains.items() if k[2])
    exemption_used = min(exemption, exempt_gain)
    remaining_exemption = exemption - exemption_used
    exempt_left = exemption_used
    tax = 0.0
    lines = []
    for k in sorted(gains, key=lambda k: (k[0], -k[1])):
        group, rate, exempt = k
        taxable = gains[k]
        if exempt and exempt_left > 0:
            cut = min(taxable, exempt_left)
            taxable -= cut
            exempt_left -= cut
        if taxable <= 0:
            continue
        tax += taxable * rate
        lines.append({"group": group, "rate": round(rate * 100, 2), "taxable": round(taxable, 2),
                      "tax": round(taxable * rate, 2), "slab": rate == slab_rate and not exempt})

    summary = defaultdict(float)
    for l in lots:
        cls = {d.TAX_EQUITY: "equity", d.TAX_FOREIGN: "foreign", d.TAX_LISTED_OTHER: "other", d.TAX_DEBT: "debt"}.get(l["tax_class"], "other")
        summary[f"{cls}_{l['term'].lower()}"] += l["gain"]

    # ── income in FY (taxed at slab) ──
    income = defaultdict(float)
    for t in txns:
        ds = str(t["date"])[:10]
        if not (start <= ds <= end):
            continue
        i = inst.get(t["instrument_id"]) or {}
        if t["type"] == d.DIVIDEND:
            income["dividends"] += _f(t["amount"])
        elif t["type"] == d.REPAYMENT:
            income["p2p_interest"] += _f(t["amount"]) - _f(t["principal"])
        elif t["type"] == d.INTEREST:
            income["fd_interest"] += _f(t["amount"])
        elif t["type"] == d.MATURITY:
            income["fd_interest"] += _f(t["amount"]) - _f(t["principal"])
    income_total = sum(income.values())
    income_tax = income_total * slab_rate
    cg_tax = tax
    total_tax = (cg_tax + income_tax) * (1 + CESS)

    return {
        "fy": fy, "start": start, "end": end, "slab_rate": round(slab_rate * 100, 2),
        "realized": sorted(lots, key=lambda l: l["sell_date"]),
        "summary": {k: round(v, 2) for k, v in summary.items()},
        "total_realized": round(sum(l["gain"] for l in lots), 2),
        "set_off": {"st_loss": round(st_loss, 2), "lt_loss": round(lt_loss, 2),
                    "carry_forward_st": round(st_loss_left, 2), "carry_forward_lt": round(lt_loss_left, 2)},
        "equity_exemption": {"limit": exemption, "used": round(exemption_used, 2), "remaining": round(remaining_exemption, 2)},
        "tax_lines": lines,
        "income": {k: round(v, 2) for k, v in income.items()}, "income_total": round(income_total, 2),
        "estimate": {"capital_gains_tax": round(cg_tax, 2), "income_tax": round(income_tax, 2),
                     "cess": round((cg_tax + income_tax) * CESS, 2), "total": round(total_tax, 2)},
        "opportunities": harvesting(portfolio, instruments, remaining_exemption, slab_rate, today,
                                    realized_gain=sum(v for v in buckets.values() if v > 0),
                                    is_current_fy=start <= today.isoformat() <= end) if with_opportunities else None,
    }


def open_lot_view(portfolio: dict, instruments: list[dict], today: date) -> list[dict]:
    """Per open lot: market value at the current price, gain, term today and date it turns long-term."""
    inst = {i["id"]: i for i in instruments}
    fx = portfolio.get("usd_inr") or 0.0
    out = []
    for p in portfolio["positions"]:
        if p["asset_class"] not in d.TRADABLE or not p.get("is_open") or not p.get("has_price"):
            continue
        i = inst[p["id"]]
        mult = fx if p.get("currency") == "USD" else 1.0
        tc = i.get("tax_class") or d.TAX_EQUITY
        r = rule_for(tc, today.isoformat())
        for lot in p["open_lots"]:
            value = lot["qty"] * p["price"] * mult
            gain = value - lot["cost"]
            held = (today - to_date(lot["date"])).days
            lt_on = to_date(lot["date"]) + timedelta(days=r["lt_days"] + 1) if r["lt_days"] is not None else None
            out.append({
                "instrument_id": p["id"], "name": p["name"], "tax_class": tc, "date": lot["date"], "qty": lot["qty"],
                "cost": lot["cost"], "value": round(value, 2), "gain": round(gain, 2), "held_days": held,
                "term": "LTCG" if lt_on and today >= lt_on else "STCG", "lt_on": lt_on.isoformat() if lt_on else None,
                "days_to_lt": (lt_on - today).days if lt_on and today < lt_on else 0,
                "st_rate": r["st_rate"], "lt_rate": r["lt_rate"],
                "locked_until": (_elss_unlock(lot["date"]).isoformat()
                                 if (i.get("category") or "").upper() == "ELSS" else None),
            })
    return out


def harvesting(portfolio: dict, instruments: list[dict], remaining_exemption: float, slab_rate: float,
               today: date, realized_gain: float, is_current_fy: bool) -> dict:
    lots = open_lot_view(portfolio, instruments, today)
    sellable = [l for l in lots if not l["locked_until"] or l["locked_until"] <= today.isoformat()]

    # Loss harvesting: book losses to offset realized gains this year
    loss_by_inst: dict[int, dict] = {}
    for l in sellable:
        if l["gain"] >= 0:
            continue
        e = loss_by_inst.setdefault(l["instrument_id"], {"instrument_id": l["instrument_id"], "name": l["name"],
                                                          "st_loss": 0.0, "lt_loss": 0.0, "qty": 0.0})
        e["st_loss" if l["term"] == "STCG" else "lt_loss"] += -l["gain"]
        e["qty"] += l["qty"]
    loss_list = sorted(loss_by_inst.values(), key=lambda e: -(e["st_loss"] + e["lt_loss"]))
    for e in loss_list:
        e["st_loss"], e["lt_loss"], e["qty"] = round(e["st_loss"], 2), round(e["lt_loss"], 2), round(e["qty"], 6)
    total_loss = sum(e["st_loss"] + e["lt_loss"] for e in loss_list)

    # LTCG harvesting: realise long-term equity gains inside the tax-free limit and rebuy
    lt_equity = [l for l in sellable if l["tax_class"] == d.TAX_EQUITY and l["term"] == "LTCG" and l["gain"] > 0]
    lt_equity_gain = sum(l["gain"] for l in lt_equity)
    # G11 (wave-3 review): only the current FY gets a plan, and in it the bookable amount IS the plan's total
    # (FIFO, whole shares, ₹1,000 below the exemption), so the Tax page, the insight, the action and the plan
    # behind "See the harvest plan" all show one figure. A past FY's exemption can no longer be used.
    plan = (harvest_plan(portfolio, instruments, remaining_exemption, today, lots=lots)
            if is_current_fy else _empty_harvest_plan())
    harvestable = plan["total_gain"] if is_current_fy else 0.0

    # Lots about to turn long-term: waiting avoids the short-term rate
    upcoming = []
    for l in lots:
        if l["gain"] > 0 and 0 < l["days_to_lt"] <= 90:
            st = l["st_rate"] if l["st_rate"] is not None else slab_rate
            saving = l["gain"] * (st - (l["lt_rate"] or 0))
            if saving > 0:
                upcoming.append({**l, "tax_saving": round(saving, 2)})
    upcoming.sort(key=lambda l: l["days_to_lt"])

    return {
        "loss_harvest": loss_list, "loss_harvest_total": round(total_loss, 2),
        "loss_harvest_offsettable": round(min(total_loss, realized_gain), 2),
        "ltcg_harvest": {"unrealized_lt_equity_gain": round(lt_equity_gain, 2), "remaining_exemption": round(remaining_exemption, 2),
                         "suggested_booking": round(harvestable, 2), "future_tax_saved": plan["future_tax_saved"],
                         "lots": sorted(lt_equity, key=lambda l: -l["gain"])[:20]},
        "upcoming_long_term": upcoming[:20],
        "open_lots": lots,
        "harvest_plan": plan,
    }


# ── Harvest plan (§6.9, G11) ──

def _elss_unlock(buy_date: str) -> date:
    """ELSS units unlock three years after purchase; a 29 February purchase unlocks on 1 March
    (portfolio.elss_unlock, shared with the holding's `elss` block)."""
    return elss_unlock(buy_date)


def _empty_harvest_plan() -> dict:
    return {"rows": [], "total_gain": 0.0, "future_tax_saved": 0.0, "note": f"{REBUY_NOTE} {CHARGES_NOTE}"}


def _floor_qty(qty: float, whole_units: bool) -> float:
    """Round a partial quantity down: whole shares for stocks, 0.001 units for funds and ETFs."""
    q = math.floor(qty + 1e-9) if whole_units else math.floor(qty * 1000 + 1e-6) / 1000
    return max(float(q), 0.0)


def harvest_plan(port: dict, instruments: list[dict], remaining_exemption: float, today: date,
                 *, lots: list[dict] | None = None) -> dict:
    """Which long-term equity lots to sell (and rebuy) to use this year's LTCG exemption.

    Lots qualify when they are long-term, `tax_class == equity`, in gain and not ELSS-locked. They are
    taken best gain/value first: whole lots, then one partial lot, until the cumulative gain reaches
    `remaining_exemption − ₹1,000` (A12 keeps the plan below the action's closing floor).

    A sale is matched FIFO, so within one holding only the oldest lots can be sold. Each holding offers
    its open lots oldest first and stops at the first one that does not qualify; the greedy pick runs over
    the holdings' next lots. A partial stock lot is rounded down to whole shares, a fund to 0.001 units.

    -> {rows: [{instrument_id, name, qty, proceeds, gain, lots: [{date, qty, cost, proceeds, gain,
       partial}]}], total_gain, future_tax_saved (12.5%, before cess — G11), note}
    """
    plan = _empty_harvest_plan()
    target = _f(remaining_exemption) - HARVEST_BUFFER
    if target <= 0:
        return plan
    inst = {i["id"]: i for i in instruments}
    today_s = today.isoformat()
    lots = lots if lots is not None else open_lot_view(port, instruments, today)

    def qualifies(l: dict) -> bool:
        return (l["tax_class"] == d.TAX_EQUITY and l["term"] == "LTCG" and l["gain"] > 0 and l["value"] > 0
                and not (l["locked_until"] and l["locked_until"] > today_s))

    queues: dict[int, list[dict]] = {}
    for l in lots:  # open_lot_view keeps each holding's lots in FIFO order
        q = queues.setdefault(l["instrument_id"], [])
        if q and q[-1] is None:
            continue
        q.append(l if qualifies(l) else None)  # None closes the FIFO prefix
    queues = {k: [l for l in v if l is not None] for k, v in queues.items()}
    queues = {k: v for k, v in queues.items() if v}

    rows: dict[int, dict] = {}
    cum = 0.0
    while queues and cum < target - 0.005:
        iid = max(queues, key=lambda k: (queues[k][0]["gain"] / queues[k][0]["value"], -k))
        l = queues[iid].pop(0)
        if not queues[iid]:
            del queues[iid]
        partial = cum + l["gain"] > target
        if partial:
            whole_units = (inst.get(iid) or {}).get("asset_class") == d.EQUITY
            qty = _floor_qty(l["qty"] * (target - cum) / l["gain"], whole_units)
            if qty <= EPS:
                break
            frac = qty / l["qty"]
        else:
            qty, frac = l["qty"], 1.0
        gain, value, cost = l["gain"] * frac, l["value"] * frac, l["cost"] * frac
        row = rows.setdefault(iid, {"instrument_id": iid, "name": l["name"], "qty": 0.0, "proceeds": 0.0,
                                    "gain": 0.0, "lots": []})
        row["qty"] += qty
        row["proceeds"] += value
        row["gain"] += gain
        row["lots"].append({"date": l["date"], "qty": round(qty, 6), "cost": round(cost, 2),
                            "proceeds": round(value, 2), "gain": round(gain, 2), "partial": partial})
        cum += gain
        if partial:
            break  # one partial lot, then stop

    out = []
    for r in rows.values():
        out.append({**r, "qty": round(r["qty"], 6), "proceeds": round(r["proceeds"], 2), "gain": round(r["gain"], 2)})
    total = round(sum(r["gain"] for r in out), 2)
    plan.update(rows=out, total_gain=total, future_tax_saved=round(total * HARVEST_LT_RATE, 2))
    return plan


# ── What if I sell (§6.9, G11) ──

def _tax_class_of(i: dict) -> str:
    return i.get("tax_class") or d.default_tax_class(i.get("asset_class", ""), i.get("market"), i.get("category"),
                                                     i.get("name"))


def _parse_day(v, label: str) -> date:
    if isinstance(v, date):
        return v
    try:
        return to_date(v)
    except (TypeError, ValueError):
        raise WhatIfError(f"{label} must be a date (YYYY-MM-DD).") from None


def _units(q: float) -> str:
    return f"{round(q, 6):g}"


def what_if_sale(port: dict, txns: list[dict], instruments: list[dict], instrument_id: int, qty: float,
                 price: float | None = None, sell_date=None, slab_rate: float = 0.30, *,
                 today: date | None = None) -> dict:
    """The tax on selling `qty` units of one holding on `sell_date` (default today) at `price`.

    `price` defaults to the holding's last price (D16) and is in the holding's currency; a USD sale is
    converted at `port['usd_inr']`. The sale's lots come from `run_fifo` on the holding's transactions plus
    one synthetic SELL, so same-day buys match as intraday exactly as the ledger does. The tax is
    compute_tax(with those lots) − compute_tax(without) for fy_of(sell_date), cess included.

    `wait` is set when a consumed short-term lot turns long-term within 90 days and selling on the latest
    such date (same price) would cost less: {date, days, tax_then, saving}.

    Raises WhatIfError (a ValueError) for: no such holding in scope, a class that is not tradable, qty ≤ 0
    or above the open quantity, ELSS units still locked on sell_date, no price, and a sell_date before
    today or more than 365 days ahead.
    """
    today = today or (to_date(port["as_of"]) if port.get("as_of") else date.today())
    pos = next((p for p in port.get("positions") or [] if p.get("id") == instrument_id), None)
    i = next((x for x in instruments if x.get("id") == instrument_id), None)
    if pos is None or i is None:
        raise WhatIfError("No such holding in this portfolio.")
    if pos.get("asset_class") not in d.TRADABLE:
        raise WhatIfError(f"{pos.get('name')} is not a tradable holding; only stocks, funds and ETFs can be sold here.")

    sell = _parse_day(sell_date, "sell_date") if sell_date is not None else today
    if sell < today:
        raise WhatIfError("The sale date cannot be in the past.")
    if (sell - today).days > MAX_AHEAD_DAYS:
        raise WhatIfError(f"The sale date can be at most {MAX_AHEAD_DAYS} days ahead.")

    try:
        qty = float(qty)
    except (TypeError, ValueError):
        raise WhatIfError("Quantity must be a number.") from None
    if not math.isfinite(qty) or qty <= 0:
        raise WhatIfError("Quantity must be more than 0.")

    sell_s = sell.isoformat()
    ts = [t for t in txns if t.get("instrument_id") == instrument_id and str(t["date"])[:10] <= sell_s]
    open_lots, base_realized, _ = run_fifo(instrument_id, ts)
    held = sum(l.qty for l in open_lots)
    if qty > held + 1e-6:
        raise WhatIfError(f"You hold only {_units(held)} units.")
    qty = min(qty, held)

    elss = (i.get("category") or "").upper() == "ELSS"
    if elss:
        free = sum(l.qty for l in open_lots if _elss_unlock(l.date) <= sell)
        locked = [_elss_unlock(l.date) for l in open_lots if _elss_unlock(l.date) > sell]
        if qty > free + 1e-6:
            nxt = min(locked).isoformat() if locked else None
            raise WhatIfError(f"Only {_units(free)} units are out of the ELSS lock-in on {sell_s}; "
                              f"the next units unlock on {nxt}.")

    usd = (pos.get("currency") or i.get("currency")) == "USD"
    fx = _f(port.get("usd_inr"))
    if price is None:
        if not pos.get("has_price") or not pos.get("price"):
            raise WhatIfError(f"{pos.get('name')} has no price yet; enter a sale price.")
        price = _f(pos["price"])
    else:
        try:
            price = float(price)
        except (TypeError, ValueError):
            raise WhatIfError("Price must be a number.") from None
        if not math.isfinite(price) or price <= 0:
            raise WhatIfError("Price must be more than 0.")
    if usd and fx <= 0:
        raise WhatIfError("No USD/INR rate is available to convert this sale.")

    res = _price_sale(port, txns, instruments, i, ts, len(base_realized), qty, price, usd, fx, sell, slab_rate, today)
    if elss and any(_elss_unlock(l["date"]) > sell for l in res["lots"]):  # a same-day ELSS buy matched first
        raise WhatIfError(f"Units bought on {sell_s} are still in the ELSS lock-in; the sale would sell them first.")

    # Wait hint: the latest date within 90 days on which a consumed short-term lot turns long-term
    soon = [to_date(l["lt_on"]) for l in res["lots"] if l["term"] == "STCG" and l["lt_on"]
            and 0 < (to_date(l["lt_on"]) - sell).days <= WAIT_WINDOW_DAYS]
    wait = None
    if soon:
        then = max(soon)
        ts_then = [t for t in txns if t.get("instrument_id") == instrument_id and str(t["date"])[:10] <= then.isoformat()]
        _, base_then, _ = run_fifo(instrument_id, ts_then)
        later = _price_sale(port, txns, instruments, i, ts_then, len(base_then), qty, price, usd, fx, then,
                            slab_rate, today)
        saving = res["tax_now"] - later["tax_now"]
        if saving > 0.005:
            wait = {"date": then.isoformat(), "days": (then - sell).days, "tax_then": later["tax_now"],
                    "saving": round(saving, 2)}

    gain = res["gain"]
    slab_txt = f"{round(slab_rate * 100, 2):g}"
    out = {
        "instrument_id": instrument_id, "name": pos.get("name"), "qty": round(qty, 6), "price": price,
        "currency": "USD" if usd else "INR", "sell_date": sell_s, "fy": res["fy"],
        "proceeds": res["proceeds"], "cost": res["cost"], "gain": gain, "lots": res["lots"],
        "st_gain": res["st_gain"], "lt_gain": res["lt_gain"],
        "exemption_used": res["exemption_used"], "exemption_left": res["exemption_left"],
        "tax_now": res["tax_now"], "net_cash": round(res["proceeds"] - res["tax_now"], 2),
        "effective_pct": round(res["tax_now"] / gain * 100, 2) if gain > 0 else None,
        "wait": wait,
        "note": (f"Estimate at your {slab_txt}% slab incl. 4% cess; surcharge, carry-forward and exit loads "
                 f"not modelled. {CHARGES_NOTE}"),
    }
    if usd:
        out["amount_fc"] = round(qty * price, 2)
        out["usd_inr"] = fx
    return out


def _price_sale(port: dict, txns: list[dict], instruments: list[dict], i: dict, ts: list[dict], n_base: int,
                qty: float, price: float, usd: bool, fx: float, sell: date, slab_rate: float, today: date) -> dict:
    """One synthetic SELL through run_fifo, then the compute_tax difference for fy_of(sell)."""
    iid, sell_s = i["id"], sell.isoformat()
    amount_fc = qty * price if usd else None
    proceeds = qty * price * (fx if usd else 1.0)
    synthetic = {"id": 10 ** 15, "instrument_id": iid, "date": sell_s, "type": d.SELL, "quantity": qty,
                 "amount": proceeds, "amount_fc": amount_fc}
    _, realized, _ = run_fifo(iid, ts + [synthetic])
    new: list[RealizedLot] = realized[n_base:]  # the synthetic sell sorts last, so its lots come last

    tc = _tax_class_of(i)
    rule = rule_for(tc, sell_s)
    lots, st_gain, lt_gain = [], 0.0, 0.0
    for r in new:
        term, rate, _ = classify(tc, r.buy_date, r.sell_date, r.intraday)
        lt_on = (to_date(r.buy_date) + timedelta(days=rule["lt_days"] + 1)).isoformat() \
            if rule["lt_days"] is not None and not r.intraday else None
        if term == "LTCG":
            lt_gain += r.gain
        else:
            st_gain += r.gain
        lots.append({"date": r.buy_date, "qty": round(r.qty, 6), "cost": round(r.cost, 2),
                     "proceeds": round(r.proceeds, 2), "gain": round(r.gain, 2), "term": term,
                     "rate_pct": round(rate * 100, 2) if rate is not None else None, "lt_on": lt_on})

    fy = d.fy_of(sell_s)
    hypo = [dict(asdict(r), gain=r.gain, holding_days=r.holding_days) for r in new]
    before = compute_tax(port, txns, instruments, fy, slab_rate, today=today, with_opportunities=False)
    after = compute_tax({**port, "realized_lots": list(port.get("realized_lots") or []) + hypo}, txns, instruments,
                        fy, slab_rate, today=today, with_opportunities=False)
    cost = sum(r.cost for r in new)
    return {
        "fy": fy, "proceeds": round(proceeds, 2), "cost": round(cost, 2), "gain": round(proceeds - cost, 2),
        "lots": lots, "st_gain": round(st_gain, 2), "lt_gain": round(lt_gain, 2),
        "exemption_used": round(after["equity_exemption"]["used"] - before["equity_exemption"]["used"], 2),
        "exemption_left": after["equity_exemption"]["remaining"],
        "tax_now": round(after["estimate"]["total"] - before["estimate"]["total"], 2),
    }


# ── Sale planning for rebalancing (§6.9 P2, AMENDMENTS K12) ──

SALE_ORDER = ("loss", "lt_exempt", "other")


def _sellable_queues(port: dict, instruments: list[dict], today: date) -> dict[int, list[dict]]:
    """{instrument_id: open lots oldest first}, cut at the first ELSS-locked lot: a sale is matched FIFO,
    so units behind a locked lot cannot be sold. Holdings with nothing sellable are left out."""
    today_s = today.isoformat()
    queues: dict[int, list] = {}
    for l in open_lot_view(port, instruments, today):  # each holding's lots in FIFO order
        q = queues.setdefault(l["instrument_id"], [])
        if q and q[-1] is None:
            continue
        q.append(None if l["locked_until"] and l["locked_until"] > today_s else l)  # None closes the prefix
    out = {}
    for iid, q in queues.items():
        lots = [l for l in q if l is not None and l["value"] > 0]
        if lots:
            out[iid] = lots
    return out


def _fifo_take(lots: list[dict], take: float) -> dict:
    """What selling `take` rupees from the oldest lots would realise, at today's terms (no tax run)."""
    proceeds = cost = qty = 0.0
    all_lt = True
    for l in lots:
        if proceeds >= take - 1e-9:
            break
        frac = min(1.0, (take - proceeds) / l["value"])
        proceeds += l["value"] * frac
        cost += l["cost"] * frac
        qty += l["qty"] * frac
        all_lt = all_lt and l["term"] == "LTCG"
    return {"proceeds": proceeds, "gain": proceeds - cost, "qty": qty, "all_lt": all_lt}


def _sale_class(sale: dict, tax_class: str, exempt_left: float, iid: int) -> tuple[str, tuple]:
    """(class, sort key) per K12: losses (most negative first), then long-term equity gains the exemption
    still covers (lowest gain/proceeds first), then the rest (long-term before short-term, then lowest
    gain/proceeds). Ties go to the lower instrument id."""
    gain, proceeds = sale["gain"], sale["proceeds"]
    ratio = gain / proceeds if proceeds > 0 else 0.0
    if gain < 0:
        return "loss", (0, gain, 0.0, iid)
    if sale["all_lt"] and tax_class == d.TAX_EQUITY and gain <= exempt_left + 1e-9:
        return "lt_exempt", (1, ratio, 0.0, iid)
    return "other", (2, 0 if sale["all_lt"] else 1, ratio, iid)


def _hypo_lots(iid: int, sale_lots: list[dict], sell: date) -> list[dict]:
    """what_if_sale's lots as `realized_lots` rows compute_tax can read."""
    return [{"instrument_id": iid, "buy_date": l["date"], "sell_date": sell.isoformat(),
             "intraday": l["term"] == "Intraday", "holding_days": (sell - to_date(l["date"])).days,
             "qty": l["qty"], "cost": l["cost"], "proceeds": l["proceeds"], "gain": l["gain"]} for l in sale_lots]


def plan_sales(port: dict, txns: list[dict], instruments: list[dict], legs: list[dict], *, slab_rate: float,
               today: date | None = None, max_per_leg: int = 5) -> dict:
    """Which holdings to sell, lowest tax first, to free each leg's amount (§6.9 P2, AMENDMENTS K12).

    `legs` = [{segment, amount}], costed in the order given (callers pass the largest first).

    - Candidates per leg: open positions in that segment with value > 0, a tradable class, a price, and
      units that are sellable today (the FIFO prefix before the first ELSS-locked lot). A holding is sold
      in one leg at most.
    - Each pick classifies every remaining candidate by the FIFO sale of min(amount still to free, its
      sellable value) from its oldest lots (`open_lot_view`): `loss`, then `lt_exempt` (all long-term,
      equity tax class, gain ≥ 0 and inside the exemption still left across the legs so far), then
      `other` (long-term before short-term, then the lowest gain/proceeds). The best is taken, until the
      leg is covered, `max_per_leg` sells are made, or (after the first sell) less than ₹500 is left.
    - Units are rounded down: whole shares for stocks, 0.001 units for funds and ETFs. Selling a holding's
      whole sellable value uses its exact units. A candidate whose rounded units are 0 or that raises
      WhatIfError is skipped.
    - Each sell's `tax` is `what_if_sale` alone (vs today's booked gains). Each leg's `tax` is marginal in
      leg order: compute_tax with every sale up to that leg minus compute_tax up to the previous one.
      `tax_total` is all the sales together minus none, so the exemption is used once.

    -> {legs: [{segment, amount, covered, sells: [{instrument_id, name, qty, proceeds, gain, st_gain,
       lt_gain, tax, order}], tax}], tax_total, exemption_used, note}; `order` is the sell's class.
    """
    today = today or (to_date(port["as_of"]) if port.get("as_of") else date.today())
    inst = {i["id"]: i for i in instruments}
    pos_by_id = {p.get("id"): p for p in port.get("positions") or []}
    fy = d.fy_of(today.isoformat())
    note = (f"Sales costed together, so the ₹{exemption_for(fy) / 100000:g} L exemption is used once. Estimate at "
            f"your {round(slab_rate * 100, 2):g}% slab incl. 4% cess; surcharge and exit loads not modelled. "
            f"{CHARGES_NOTE}")

    queues = _sellable_queues(port, instruments, today)
    base = compute_tax(port, txns, instruments, fy, slab_rate, today=today, with_opportunities=False)
    base_total, base_used = base["estimate"]["total"], base["equity_exemption"]["used"]
    exempt_left = base["equity_exemption"]["remaining"]
    realized = list(port.get("realized_lots") or [])
    hypo: list[dict] = []
    prev = base
    taken: set[int] = set()
    out_legs = []

    for leg in legs or []:
        seg = leg.get("segment")
        amount = max(_f(leg.get("amount")), 0.0)
        remaining = amount
        sells: list[dict] = []
        skipped: set[int] = set()
        while remaining > 0.5 and len(sells) < max_per_leg and (not sells or remaining >= PLAN_MIN_SELL):
            best = None
            for iid, lots in queues.items():
                p = pos_by_id.get(iid) or {}
                if iid in taken or iid in skipped or _f(p.get("value")) <= 0:
                    continue
                if (p.get("segment") or d.segment_of(p)) != seg:
                    continue
                sellable = sum(l["value"] for l in lots)
                sale = _fifo_take(lots, min(remaining, sellable))
                cls, key = _sale_class(sale, _tax_class_of(inst.get(iid) or p), exempt_left, iid)
                if best is None or key < best[0]:
                    best = (key, cls, iid, sale, sellable)
            if best is None:
                break
            _, cls, iid, sale, sellable = best
            lots = queues[iid]
            if remaining >= sellable - 0.005:
                qty = sum(l["qty"] for l in lots)
            else:
                qty = _floor_qty(sale["qty"], (pos_by_id[iid].get("asset_class") == d.EQUITY))
            if qty <= EPS:
                skipped.add(iid)
                continue
            try:
                r = what_if_sale(port, txns, instruments, iid, qty, slab_rate=slab_rate, today=today)
            except WhatIfError:
                skipped.add(iid)
                continue
            taken.add(iid)
            remaining -= r["proceeds"]
            exempt_left = max(exempt_left - r["exemption_used"], 0.0)
            hypo += _hypo_lots(iid, r["lots"], today)
            sells.append({"instrument_id": iid, "name": r["name"], "qty": r["qty"], "proceeds": r["proceeds"],
                          "gain": r["gain"], "st_gain": r["st_gain"], "lt_gain": r["lt_gain"], "tax": r["tax_now"],
                          "order": cls})
        leg_tax = 0.0
        if sells:
            after = compute_tax({**port, "realized_lots": realized + hypo}, txns, instruments, fy, slab_rate,
                                today=today, with_opportunities=False)
            leg_tax = after["estimate"]["total"] - prev["estimate"]["total"]
            prev = after
        out_legs.append({"segment": seg, "amount": round(amount, 2),
                         "covered": round(sum(s["proceeds"] for s in sells), 2), "sells": sells,
                         "tax": round(leg_tax, 2)})

    return {"legs": out_legs, "tax_total": round(prev["estimate"]["total"] - base_total, 2),
            "exemption_used": round(prev["equity_exemption"]["used"] - base_used, 2), "note": note}
