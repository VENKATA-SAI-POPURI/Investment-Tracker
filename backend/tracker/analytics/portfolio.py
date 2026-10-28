"""Portfolio engine: FIFO lots, positions, valuation, returns and allocation.

Pure functions over instrument + transaction rows so they are easy to test and reuse
(dashboard, tax, insights, AI context and history all start from `compute_portfolio`).
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, asdict
from datetime import date, timedelta

from .. import domain as d
from .xirr import xirr

EPS = 1e-9
ELSS_LOCK_YEARS = 3


def to_date(s: str) -> date:
    return date.fromisoformat(str(s)[:10])


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def r2(v: float | None) -> float | None:
    return None if v is None else round(v + 0.0, 2)


@dataclass
class Lot:
    date: str
    qty: float
    cost: float
    cost_fc: float
    txn_id: int


@dataclass
class RealizedLot:
    instrument_id: int
    buy_date: str
    sell_date: str
    qty: float
    cost: float
    proceeds: float
    cost_fc: float
    proceeds_fc: float
    intraday: bool

    @property
    def gain(self) -> float:
        return self.proceeds - self.cost

    @property
    def holding_days(self) -> int:
        return (to_date(self.sell_date) - to_date(self.buy_date)).days


_ORDER = {d.BUY: 0, d.SELL: 1}


def run_fifo(instrument_id: int, txns: list[dict]) -> tuple[list[Lot], list[RealizedLot], float]:
    """FIFO matching. Same-day sells are matched against same-day buys first (intraday),
    then against the oldest open lots. Returns (open lots, realized lots, unmatched sell qty)."""
    lots: list[Lot] = []
    realized: list[RealizedLot] = []
    unmatched = 0.0
    for t in sorted(txns, key=lambda x: (str(x["date"])[:10], _ORDER.get(x["type"], 2), x.get("id") or 0)):
        if t["type"] == d.BUY:
            q = _f(t["quantity"])
            if q > EPS:
                lots.append(Lot(str(t["date"])[:10], q, _f(t["amount"]), _f(t["amount_fc"]), t.get("id") or 0))
        elif t["type"] == d.SELL:
            sell_qty = _f(t["quantity"])
            if sell_qty <= EPS:
                continue
            sdate = str(t["date"])[:10]
            proceeds, proceeds_fc = _f(t["amount"]), _f(t["amount_fc"])
            remaining = sell_qty
            same_day = [l for l in lots if l.date == sdate]
            older = [l for l in lots if l.date != sdate]
            for lot in same_day + older:
                if remaining <= EPS:
                    break
                take = min(lot.qty, remaining)
                frac_lot = take / lot.qty
                frac_sell = take / sell_qty
                realized.append(RealizedLot(instrument_id, lot.date, sdate, take, lot.cost * frac_lot,
                                            proceeds * frac_sell, lot.cost_fc * frac_lot, proceeds_fc * frac_sell,
                                            intraday=lot.date == sdate))
                lot.cost -= lot.cost * frac_lot
                lot.cost_fc -= lot.cost_fc * frac_lot
                lot.qty -= take
                remaining -= take
            lots = [l for l in lots if l.qty > EPS]
            if remaining > 1e-6:
                unmatched += remaining
                frac = remaining / sell_qty
                realized.append(RealizedLot(instrument_id, sdate, sdate, remaining, 0.0, proceeds * frac, 0.0,
                                            proceeds_fc * frac, intraday=False))
    return lots, realized, unmatched


def latest_fx_from_txns(txns: list[dict]) -> float | None:
    fx = [t for t in txns if t["type"] in (d.FX_IN, d.FX_OUT) and _f(t["amount_fc"]) > 0]
    if not fx:
        return None
    t = max(fx, key=lambda x: (str(x["date"])[:10], x.get("id") or 0))
    return _f(t["amount"]) / _f(t["amount_fc"])


def compute_portfolio(instruments: list[dict], txns: list[dict], usd_inr: float | None,
                      targets: dict | None = None, today: date | None = None) -> dict:
    today = today or date.today()
    today_s = today.isoformat()
    by_inst: dict[int, list[dict]] = defaultdict(list)
    for t in txns:
        by_inst[t["instrument_id"]].append(t)
    fx = usd_inr or latest_fx_from_txns(txns) or 0.0

    positions: list[dict] = []
    realized_all: list[RealizedLot] = []
    us_fc_by_owner: dict[str, float] = defaultdict(float)  # net USD moved from wallet into US stocks
    wallets: list[tuple[dict, list[dict]]] = []

    for inst in instruments:
        ts = sorted(by_inst.get(inst["id"], []), key=lambda x: (str(x["date"])[:10], x.get("id") or 0))
        ac = inst["asset_class"]
        if ac in d.TRADABLE:
            pos, realized = _tradable_position(inst, ts, fx, today)
            realized_all += realized
            if inst.get("currency") == "USD":
                for t in ts:
                    if t["type"] in (d.BUY, d.SELL):
                        fc = _f(t["amount_fc"]) or (_f(t["amount"]) / fx if fx else 0.0)
                        us_fc_by_owner[inst["owner"]] += fc if t["type"] == d.BUY else -fc
        elif ac == d.P2P:
            pos = _p2p_position(inst, ts, today)
        elif ac == d.FIXED_DEPOSIT:
            pos = _fd_position(inst, ts, today)
        elif ac == d.CASH:
            wallets.append((inst, ts))
            continue
        else:
            continue
        positions.append(pos)

    for inst, ts in wallets:
        positions.append(_wallet_position(inst, ts, us_fc_by_owner.get(inst["owner"], 0.0), fx))

    total_value = sum(p["value"] for p in positions)
    for p in positions:
        p["weight"] = round(p["value"] / total_value * 100, 2) if total_value > 0 else 0.0

    segments = _segments(positions, by_inst, instruments, today, targets or {})
    totals = _totals(positions, segments, today)
    return {
        "as_of": today_s,
        "usd_inr": round(fx, 4) if fx else None,
        "totals": totals,
        "segments": segments,
        "positions": positions,
        "realized_lots": [dict(asdict(r), gain=r.gain, holding_days=r.holding_days) for r in realized_all],
    }


def _base(inst: dict) -> dict:
    return {
        "id": inst["id"], "owner": inst["owner"], "name": inst["name"], "asset_class": inst["asset_class"],
        "segment": d.segment_of(inst), "market": inst.get("market"), "currency": inst.get("currency") or "INR",
        "sector": inst.get("sector"), "market_cap": inst.get("market_cap"), "category": inst.get("category"),
        "sub_category": inst.get("sub_category"), "tax_class": inst.get("tax_class"), "symbol": inst.get("symbol"),
        "price_source": inst.get("price_source"), "platform": inst.get("platform"), "status": inst.get("status"),
        "ref": inst.get("ref"), "ref2": inst.get("ref2"), "rate": inst.get("rate"),
        "tenure_months": inst.get("tenure_months"), "maturity_date": inst.get("maturity_date"),
        "notes": inst.get("notes"),
    }


def _tradable_position(inst: dict, ts: list[dict], fx: float, today: date) -> tuple[dict, list[RealizedLot]]:
    lots, realized, unmatched = run_fifo(inst["id"], ts)
    qty = sum(l.qty for l in lots)
    cost = sum(l.cost for l in lots)
    cost_fc = sum(l.cost_fc for l in lots)
    usd = inst.get("currency") == "USD"
    mult = fx if usd else 1.0
    price = inst.get("last_price")
    has_price = bool(price) and (not usd or fx > 0) and qty > EPS
    value = qty * price * mult if has_price else cost
    prev = inst.get("prev_close")
    day_change = qty * (price - prev) * mult if has_price and prev else 0.0

    invested = sum(_f(t["amount"]) for t in ts if t["type"] == d.BUY)
    proceeds = sum(_f(t["amount"]) for t in ts if t["type"] == d.SELL)
    income = sum(_f(t["amount"]) for t in ts if t["type"] in (d.DIVIDEND, d.INTEREST))
    realized_gain = sum(r.gain for r in realized)
    unrealized = value - cost if has_price else 0.0

    flows = [(to_date(t["date"]), -_f(t["amount"]) if t["type"] == d.BUY else _f(t["amount"]))
             for t in ts if t["type"] in (d.BUY, d.SELL, d.DIVIDEND, d.INTEREST)]
    if value > EPS:
        flows.append((today, value))
    first = ts[0]["date"] if ts else None

    pos = _base(inst)
    pos.update({
        "quantity": round(qty, 6), "avg_cost": r2(cost / qty) if qty > EPS else None,
        "avg_cost_fc": round(cost_fc / qty, 4) if usd and qty > EPS and cost_fc else None,
        "cost": r2(cost), "cost_fc": r2(cost_fc) if usd else None,
        "price": price, "prev_close": prev, "price_at": inst.get("last_price_at"), "has_price": has_price,
        "value": r2(value), "day_change": r2(day_change),
        "unrealized": r2(unrealized), "unrealized_pct": r2(unrealized / cost * 100) if cost > EPS and has_price else None,
        "invested": r2(invested), "proceeds": r2(proceeds), "income": r2(income), "realized": r2(realized_gain),
        "total_return": r2(realized_gain + income + unrealized),
        "xirr": _pct(xirr(flows)), "first_date": first, "last_date": ts[-1]["date"] if ts else None,
        "is_open": qty > EPS, "unmatched_sell_qty": round(unmatched, 6) or None,
        "open_lots": [{"date": l.date, "qty": round(l.qty, 6), "cost": r2(l.cost),
                       "age_days": (today - to_date(l.date)).days} for l in lots],
        "txn_count": len(ts),
    })
    if usd and has_price and cost_fc:
        # Split unrealized P&L into the stock move (in USD) and the rupee move on the cost basis
        pos["fx_gain"] = r2(cost_fc * fx - cost)
        pos["stock_gain"] = r2((qty * price - cost_fc) * fx)
    if (inst.get("category") or "").upper() == "ELSS" and lots:
        unlock = lambda l: to_date(l.date).replace(year=to_date(l.date).year + ELSS_LOCK_YEARS)
        free = [l for l in lots if unlock(l) <= today]
        locked = [l for l in lots if unlock(l) > today]
        pos["elss"] = {
            "unlocked_qty": round(sum(l.qty for l in free), 6),
            "locked_qty": round(sum(l.qty for l in locked), 6),
            "unlocked_value": r2(sum(l.qty for l in free) * price * mult) if has_price else None,
            "next_unlock": min(unlock(l) for l in locked).isoformat() if locked else None,
        }
    return pos, realized


def _p2p_position(inst: dict, ts: list[dict], today: date) -> dict:
    lent = sum(_f(t["amount"]) for t in ts if t["type"] == d.BUY)
    tenure = _f(inst.get("tenure_months"))
    principal_back = interest = fees = 0.0
    last_repayment = None
    for t in ts:
        if t["type"] != d.REPAYMENT:
            continue
        amt = _f(t["amount"])
        if t.get("principal") is not None:
            p = _f(t["principal"])
        else:  # legacy rows without a split: assume an equal-instalment principal share
            per = lent / tenure if tenure else amt
            p = min(amt, per, max(lent - principal_back, 0))
        principal_back += p
        interest += amt - p
        fees += _f(t.get("fees"))
        last_repayment = t["date"]
    principal_back = min(principal_back, lent)
    outstanding = max(lent - principal_back, 0.0)
    status = (inst.get("status") or "active").lower()
    loss = outstanding if status == "closed" else 0.0
    value = 0.0 if status == "closed" else outstanding
    mat = inst.get("maturity_date")
    overdue_days = (today - to_date(mat)).days if mat and status == "active" and outstanding > 1 else 0

    flows = [(to_date(t["date"]), -_f(t["amount"]) if t["type"] == d.BUY else _f(t["amount"])) for t in ts]
    if value > EPS:
        flows.append((today, value))
    pos = _base(inst)
    pos.update({
        "quantity": None, "cost": r2(outstanding if status != "closed" else 0.0), "value": r2(value),
        "invested": r2(lent), "principal_repaid": r2(principal_back), "outstanding": r2(outstanding),
        "interest": r2(interest), "fees": r2(fees), "income": r2(interest), "realized": r2(-loss),
        "principal_loss": r2(loss), "unrealized": 0.0, "unrealized_pct": None, "has_price": False,
        "total_return": r2(interest - loss), "xirr": _pct(xirr(flows)), "day_change": 0.0,
        "first_date": ts[0]["date"] if ts else None, "last_date": ts[-1]["date"] if ts else None,
        "last_repayment": last_repayment, "overdue_days": max(overdue_days, 0),
        "at_risk": r2(outstanding) if status == "defaulted" else 0.0,
        "is_open": status != "closed" and outstanding > 0.01, "txn_count": len(ts),
    })
    return pos


def fd_accrued(principal: float, rate_pct: float, start: date, end: date) -> float:
    """Quarterly-compounded value (Indian bank convention for cumulative FDs)."""
    years = max((end - start).days, 0) / 365.0
    return principal * (1 + rate_pct / 400.0) ** (4 * years)


def _fd_position(inst: dict, ts: list[dict], today: date) -> dict:
    principal = sum(_f(t["amount"]) for t in ts if t["type"] == d.BUY)
    payouts = sum(_f(t["amount"]) for t in ts if t["type"] == d.INTEREST)
    matured = [t for t in ts if t["type"] == d.MATURITY]
    start = to_date(ts[0]["date"]) if ts else today
    rate = _f(inst.get("rate"))
    mat = to_date(inst["maturity_date"]) if inst.get("maturity_date") else None
    if matured:
        received = sum(_f(t["amount"]) for t in matured)
        value, accrued, realized = 0.0, 0.0, received - principal
    else:
        end = min(today, mat) if mat else today
        accrued = max(fd_accrued(principal, rate, start, end) - principal - payouts, 0.0) if rate else 0.0
        value, realized = principal + accrued, 0.0
    flows = [(to_date(t["date"]), -_f(t["amount"]) if t["type"] == d.BUY else _f(t["amount"])) for t in ts]
    if value > EPS:
        flows.append((today, value))
    pos = _base(inst)
    pos.update({
        "quantity": None, "cost": r2(0.0 if matured else principal), "value": r2(value), "invested": r2(principal),
        "accrued_interest": r2(accrued), "income": r2(payouts), "realized": r2(realized),
        "unrealized": r2(accrued), "unrealized_pct": r2(accrued / principal * 100) if principal and not matured else None,
        "has_price": False, "total_return": r2(realized + payouts + accrued), "xirr": _pct(xirr(flows)), "day_change": 0.0,
        "first_date": ts[0]["date"] if ts else None, "last_date": ts[-1]["date"] if ts else None,
        "days_to_maturity": (mat - today).days if mat and not matured else None,
        "maturity_value": r2(fd_accrued(principal, rate, start, mat)) if mat and rate and not matured else None,
        "is_open": not matured and principal > 0, "txn_count": len(ts),
    })
    return pos


def _wallet_position(inst: dict, ts: list[dict], net_to_stocks_fc: float, fx: float) -> dict:
    in_fc = sum(_f(t["amount_fc"]) for t in ts if t["type"] == d.FX_IN)
    in_inr = sum(_f(t["amount"]) for t in ts if t["type"] == d.FX_IN)
    out_fc = sum(_f(t["amount_fc"]) for t in ts if t["type"] == d.FX_OUT)
    out_inr = sum(_f(t["amount"]) for t in ts if t["type"] == d.FX_OUT)
    avg_rate = in_inr / in_fc if in_fc else 0.0
    balance_fc = in_fc - out_fc - net_to_stocks_fc
    cost = balance_fc * avg_rate
    value = balance_fc * fx if fx else cost
    fx_realized = out_inr - out_fc * avg_rate if avg_rate else 0.0
    pos = _base(inst)
    pos.update({
        "quantity": round(balance_fc, 4), "balance_usd": round(balance_fc, 2), "cost": r2(cost), "value": r2(value),
        "invested": r2(in_inr), "proceeds": r2(out_inr), "deposited_usd": round(in_fc, 2),
        "withdrawn_usd": round(out_fc, 2), "avg_rate": round(avg_rate, 4) if avg_rate else None,
        "current_rate": round(fx, 4) if fx else None, "unrealized": r2(value - cost),
        "unrealized_pct": r2((value - cost) / cost * 100) if cost > EPS else None, "realized": r2(fx_realized),
        "income": 0.0, "total_return": r2(fx_realized + value - cost), "has_price": bool(fx), "xirr": None,
        "day_change": 0.0, "first_date": ts[0]["date"] if ts else None, "last_date": ts[-1]["date"] if ts else None,
        "is_open": abs(balance_fc) > 0.01, "txn_count": len(ts),
    })
    return pos


def _pct(v: float | None) -> float | None:
    return None if v is None else round(v * 100, 2)


def position_flows(pos: dict, ts: list[dict], today: date) -> list[tuple[date, float]]:
    """External cash flows of one position from the investor's point of view."""
    flows = []
    for t in ts:
        typ, amt = t["type"], _f(t["amount"])
        if typ == d.BUY:
            flows.append((to_date(t["date"]), -amt))
        elif typ in (d.SELL, d.DIVIDEND, d.INTEREST, d.REPAYMENT, d.MATURITY):
            flows.append((to_date(t["date"]), amt))
    return flows


def _segments(positions: list[dict], by_inst: dict, instruments: list[dict], today: date, targets: dict) -> list[dict]:
    inst_map = {i["id"]: i for i in instruments}
    owners_with_wallet = {p["owner"] for p in positions if p["asset_class"] == d.CASH}
    seg: dict[str, dict] = {}
    for p in positions:
        s = seg.setdefault(p["segment"], {"segment": p["segment"], "value": 0.0, "cost": 0.0, "invested": 0.0,
                                          "unrealized": 0.0, "realized": 0.0, "income": 0.0, "day_change": 0.0,
                                          "open_count": 0, "flows": []})
        for k in ("value", "cost", "invested", "unrealized", "realized", "income", "day_change"):
            if k == "invested" and p["asset_class"] == d.CASH:
                continue
            s[k] += _f(p.get(k))
        if p.get("is_open") and p["asset_class"] != d.CASH:
            s["open_count"] += 1
        ts = by_inst.get(p["id"], [])
        if p["asset_class"] == d.CASH:
            # bank <-> USD wallet transfers are the external flows of the US account
            s["flows"] += [(to_date(t["date"]), -_f(t["amount"]) if t["type"] == d.FX_IN else _f(t["amount"])) for t in ts]
        elif p["segment"] == d.SEG_EQ_US and p["owner"] in owners_with_wallet:
            # stock buys/sells are internal to the US account; dividends still leave it
            s["flows"] += [(to_date(t["date"]), _f(t["amount"])) for t in ts if t["type"] in (d.DIVIDEND, d.INTEREST)]
        else:
            s["flows"] += position_flows(p, ts, today)

    total_value = sum(s["value"] for s in seg.values())
    out = []
    names = list(d.SEGMENTS) + [k for k in seg if k not in d.SEGMENTS]
    for name in names:
        if name not in seg and name not in targets:
            continue
        s = seg.get(name) or {"segment": name, "value": 0.0, "cost": 0.0, "invested": 0.0, "unrealized": 0.0,
                              "realized": 0.0, "income": 0.0, "day_change": 0.0, "open_count": 0, "flows": []}
        flows = list(s.pop("flows"))
        if s["value"] > EPS:
            flows.append((today, s["value"]))
        pct = s["value"] / total_value * 100 if total_value > 0 else 0.0
        target = targets.get(name)
        out.append({
            **{k: r2(v) if isinstance(v, float) else v for k, v in s.items()},
            "pct": round(pct, 2),
            "target": target,
            "drift": round(pct - float(target), 2) if target is not None else None,
            "unrealized_pct": r2(s["unrealized"] / s["cost"] * 100) if s["cost"] > EPS else None,
            "total_return": r2(s["unrealized"] + s["realized"] + s["income"]),
            "xirr": _pct(xirr(flows)),
            "_flows": flows,
        })
    return out


def _totals(positions: list[dict], segments: list[dict], today: date) -> dict:
    value = sum(_f(p["value"]) for p in positions)
    cost = sum(_f(p["cost"]) for p in positions)
    unrealized = sum(_f(p.get("unrealized")) for p in positions)
    realized = sum(_f(p.get("realized")) for p in positions)
    income = sum(_f(p.get("income")) for p in positions)
    day_change = sum(_f(p.get("day_change")) for p in positions)
    flows = [f for s in segments for f in s.pop("_flows")]
    flows = [f for f in flows if f[0] < today] + [(today, sum(a for dt, a in flows if dt == today))]
    priced = [p for p in positions if p.get("is_open") and p["asset_class"] in d.TRADABLE]
    missing = [p["name"] for p in priced if not p.get("has_price")]
    return {
        "value": r2(value), "cost": r2(cost), "unrealized": r2(unrealized),
        "unrealized_pct": r2(unrealized / cost * 100) if cost > EPS else None,
        "realized": r2(realized), "income": r2(income), "total_gain": r2(unrealized + realized + income),
        "day_change": r2(day_change), "day_change_pct": r2(day_change / (value - day_change) * 100) if value - day_change > EPS else None,
        "xirr": _pct(xirr(flows)), "open_positions": sum(1 for p in positions if p.get("is_open") and p["asset_class"] != d.CASH),
        "missing_prices": missing,
    }
