"""Daily portfolio value history, time-weighted return, risk metrics and benchmark comparison."""
from __future__ import annotations

import math
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta

from .. import domain as d
from .assumptions import RISK_FREE  # ~ Indian 1-year T-bill; one source in the Assumption Book
from .portfolio import (EPF_DEFAULT_RATE, EPS, epf_accrued, epf_balance, fd_accrued, fd_value, p2p_repaid, p2p_write_down_from,
                        run_fifo, to_date, usd_of, _f)
from .xirr import xirr

RANGES = {"1M": 30, "3M": 91, "6M": 182, "1Y": 365, "3Y": 1095, "5Y": 1826}


class Series:
    """Forward-filled daily lookup over sparse (iso_date, value) points."""

    def __init__(self, points: list[tuple[str, float]]):
        self.dates = [p[0] for p in points]
        self.vals = [p[1] for p in points]

    def at(self, iso: str) -> float | None:
        i = bisect_right(self.dates, iso) - 1
        return self.vals[i] if i >= 0 else None

    def __bool__(self):
        return bool(self.dates)


def _range_start(rng: str, first: date, today: date) -> date:
    if rng == "YTD":
        return max(first, date(today.year, 1, 1))
    if rng == "FY":
        fy_start = date(today.year if today.month >= 4 else today.year - 1, 4, 1)
        return max(first, fy_start)
    days = RANGES.get(rng)
    return max(first, today - timedelta(days=days)) if days else first


def build_history(instruments: list[dict], txns: list[dict], price_hist: dict[str, list], fx_hist: list,
                  bench_hist: dict[str, dict], today: date | None = None, rng: str = "ALL",
                  usd_inr: float | None = None, p2p_recovery: float | None = None) -> dict:
    """Daily value history, returns, risk and benchmarks. Today's value uses the same prices and USD/INR rate as
    compute_portfolio (`usd_inr`, each holding's last price), so the two engines agree on today."""
    today = today or date.today()
    if not txns:
        return {"series": [], "metrics": {}, "benchmarks": [], "monthly": [], "contributors": []}
    inst_map = {i["id"]: i for i in instruments}
    by_inst = defaultdict(list)
    for t in txns:
        if t["instrument_id"] in inst_map:
            by_inst[t["instrument_id"]].append(t)
    first = min(to_date(t["date"]) for t in txns)
    fx = Series(fx_hist)
    fallback_fx = None
    fx_txn = [t for t in txns if t["type"] in (d.FX_IN, d.FX_OUT) and _f(t["amount_fc"]) > 0]
    if fx_txn:
        t = max(fx_txn, key=lambda x: x["date"])
        fallback_fx = _f(t["amount"]) / _f(t["amount_fc"])
    owners_with_wallet = {i["owner"] for i in instruments if i["asset_class"] == d.CASH}

    # ── event tables per instrument ──
    qty_events: dict[int, list[tuple[str, float]]] = {}
    cost_events: dict[int, list[tuple[str, float]]] = {}
    flows_by_day: dict[str, float] = defaultdict(float)  # + = money into the portfolio
    for iid, ts in by_inst.items():
        inst = inst_map[iid]
        ts.sort(key=lambda x: (str(x["date"])[:10], x.get("id") or 0))
        ac = inst["asset_class"]
        usd_internal = inst.get("currency") == "USD" and ac == d.EQUITY and inst["owner"] in owners_with_wallet
        for t in ts:
            day, amt, typ = str(t["date"])[:10], _f(t["amount"]), t["type"]
            if typ in (d.BUY, d.FX_IN):
                if not usd_internal:
                    flows_by_day[day] += amt
            elif typ in (d.SELL, d.FX_OUT):
                if not usd_internal:
                    flows_by_day[day] -= amt
            elif typ in (d.DIVIDEND, d.INTEREST, d.REPAYMENT, d.MATURITY):
                if not usd_internal:   # a US dividend stays in the USD wallet
                    flows_by_day[day] -= amt
        if ac in d.UNITISED:
            q, qe, ce, factors = 0.0, [], [], []
            dates = sorted({str(t["date"])[:10] for t in ts})
            for day in dates:
                todays = [t for t in ts if str(t["date"])[:10] == day]
                for t in sorted(todays, key=lambda x: 0 if x["type"] == d.SPLIT else 1):
                    qty = _f(t["quantity"])
                    if t["type"] == d.SPLIT and qty > EPS:
                        factors.append((day, qty))
                        q *= qty
                    elif t["type"] == d.BONUS and qty > EPS:
                        factors.append((day, (q + qty) / q if q > EPS else 1.0))
                        q += qty
                    elif t["type"] in (d.BUY, d.SELL):
                        q += qty if t["type"] == d.BUY else -qty
                qe.append((day, max(q, 0.0)))
                lots, _, _ = run_fifo(iid, [t for t in ts if str(t["date"])[:10] <= day])
                ce.append((day, sum(l.cost for l in lots)))
            # Market prices are back-adjusted for splits and bonuses, so express earlier
            # holdings in today's units: multiply by every action that happened later.
            adjusted = []
            for day, qty in qe:
                mult = 1.0
                for fday, f in factors:
                    if fday > day:
                        mult *= f
                adjusted.append((day, qty * mult))
            qty_events[iid], cost_events[iid] = adjusted, ce

    def wallet_fc_events(inst):
        events = defaultdict(float)
        for t in by_inst[inst["id"]]:
            if t["type"] == d.FX_IN:
                events[str(t["date"])[:10]] += _f(t["amount_fc"])
            elif t["type"] == d.FX_OUT:
                events[str(t["date"])[:10]] -= _f(t["amount_fc"])
        for other in instruments:
            if other["owner"] == inst["owner"] and other["asset_class"] == d.EQUITY and other.get("currency") == "USD":
                for t in by_inst.get(other["id"], []):
                    if t["type"] in (d.BUY, d.SELL):
                        fc = usd_of(t, usd_inr or fallback_fx)
                        events[str(t["date"])[:10]] += -fc if t["type"] == d.BUY else fc
                    elif t["type"] in (d.DIVIDEND, d.INTEREST):
                        events[str(t["date"])[:10]] += usd_of(t, usd_inr or fallback_fx)
        bal, out = 0.0, []
        for day in sorted(events):
            bal += events[day]
            out.append((day, bal))
        return Series(out)

    price_series = {s: Series(p) for s, p in price_hist.items()}
    qty_series = {iid: Series(e) for iid, e in qty_events.items()}
    cost_series = {iid: Series(e) for iid, e in cost_events.items()}
    wallets = [(i, wallet_fc_events(i)) for i in instruments if i["asset_class"] == d.CASH and i["id"] in by_inst]

    today_iso = today.isoformat()

    def fx_at(iso):
        if iso == today_iso and usd_inr:
            return usd_inr
        return fx.at(iso) or fallback_fx or 0.0

    first_day = {iid: to_date(min(str(t["date"])[:10] for t in ts)) for iid, ts in by_inst.items() if ts}

    # Step series for deposits and loans: their state only changes on entry dates, so it is worked out once per
    # date (with the same helpers compute_portfolio uses) and looked up per day.
    steps: dict[int, Series] = {}
    for iid, ts in by_inst.items():
        inst = inst_map[iid]
        ac = inst["asset_class"]
        dates = sorted({str(t["date"])[:10] for t in ts})
        if ac == d.P2P:
            steps[iid] = Series([(dt, p2p_repaid(inst, ts, dt)["outstanding"]) for dt in dates])
        elif ac == d.FIXED_DEPOSIT:
            steps[iid] = Series([(dt, fd_value(inst, ts, to_date(dt))) for dt in dates])
        elif ac == d.EPF:
            rate = _f(inst.get("rate")) or EPF_DEFAULT_RATE
            pts = []
            for dt in dates:
                upto = [t for t in ts if str(t["date"])[:10] <= dt]
                pts.append((dt, (epf_balance(upto), epf_accrued(upto, rate, to_date(dt)), rate)))
            steps[iid] = Series(pts)

    def inst_value(iid: int, iso: str, day: date) -> tuple[float, float]:
        """(value, cost) of one instrument at the end of `iso` (wallets are valued separately). The same rules
        as compute_portfolio, so history and today's portfolio agree."""
        ts = by_inst[iid]
        inst = inst_map[iid]
        ac = inst["asset_class"]
        if ac in d.UNITISED:
            q = qty_series[iid].at(iso) or 0.0
            c = cost_series[iid].at(iso) or 0.0
            if q <= EPS:
                return 0.0, 0.0
            usd = inst.get("currency") == "USD"
            mult = fx_at(iso) if usd else 1.0
            last = _f(inst.get("last_price"))
            if day == today and last:
                px = last   # today: the price the portfolio uses
            else:
                px = price_series.get(inst.get("symbol") or "", Series([])).at(iso) if inst.get("symbol") else None
            if not px and last and mult:
                # no market price for this day (NPS, a manual price, or before the price history starts): move in a
                # straight line from the average cost on the first day to today's price, instead of sitting at cost
                # and jumping on the last day
                span = max((today - first_day[iid]).days, 1)
                frac = min(max((day - first_day[iid]).days / span, 0.0), 1.0)
                unit_cost = c / q
                today_unit = last * (fx_at(today_iso) if usd else 1.0)
                return q * (unit_cost + (today_unit - unit_cost) * frac), c
            return (q * px * mult if px and mult else c), c
        if ac == d.P2P:
            out = steps[iid].at(iso) or 0.0
            status = (inst.get("status") or "").lower()
            if status == "closed" and ts and iso >= str(ts[-1]["date"])[:10]:
                return 0.0, 0.0
            if status == "defaulted" and day >= p2p_write_down_from(inst, today):
                return out * (100.0 if p2p_recovery is None else p2p_recovery) / 100, out
            return out, out
        if ac == d.EPF:
            i = bisect_right(steps[iid].dates, iso) - 1
            if i < 0:
                return 0.0, 0.0
            bal, acc, rate = steps[iid].vals[i]
            if bal <= EPS:
                return 0.0, 0.0
            # between entries the interest due grows on the running balance (as epf_accrued does)
            acc += bal * rate / 100 * (day - to_date(steps[iid].dates[i])).days / 365
            return bal + max(acc, 0.0), bal
        if ac == d.FIXED_DEPOSIT:
            fv = steps[iid].at(iso)
            if not fv or fv["matured"] or not fv["principal"]:
                return 0.0, 0.0
            if fv["value"] and inst.get("rate"):
                mat = to_date(inst["maturity_date"]) if inst.get("maturity_date") else None
                end = min(day, mat) if mat else day
                acc = max(fd_accrued(fv["principal"], _f(inst["rate"]), first_day[iid], end) - fv["principal"] - fv["payouts"], 0.0)
                return fv["principal"] + acc, fv["principal"]
            return fv["value"], fv["principal"]
        return 0.0, 0.0

    group_of = {iid: d.group_of(inst_map[iid]) for iid in by_inst}

    def value_on(iso: str, day: date, groups: dict | None = None) -> tuple[float, float]:
        value = cost = 0.0
        for iid in by_inst:
            if inst_map[iid]["asset_class"] == d.CASH:
                continue
            v, c = inst_value(iid, iso, day)
            value += v
            cost += c
            if groups is not None and v:
                groups[group_of[iid]] = groups.get(group_of[iid], 0.0) + v
        for inst, ws in wallets:
            bal = ws.at(iso) or 0.0
            value += bal * fx_at(iso)
            cost += bal * fx_at(iso)
            if groups is not None and bal:
                groups[d.group_of(inst)] = groups.get(d.group_of(inst), 0.0) + bal * fx_at(iso)
        return value, cost

    # ── daily walk ──
    days, values, costs, flows, gvals = [], [], [], [], []
    cur = first
    while cur <= today:
        iso = cur.isoformat()
        gv: dict[str, float] = {}
        v, c = value_on(iso, cur, gv)
        gvals.append(gv)
        days.append(iso)
        values.append(v)
        costs.append(c)
        flows.append(flows_by_day.get(iso, 0.0))
        cur += timedelta(days=1)

    ws = _range_start(rng, first, today).isoformat()
    i0 = days.index(ws) if ws in days else 0
    rets: list[tuple[str, float]] = []
    if i0 == 0 and flows[0] > EPS:
        # the first day: money went in and closed at the day's value (a buy above the close is a loss)
        rets.append((days[0], values[0] / flows[0] - 1))
    for i in range(i0 + 1, len(days)):
        prev = values[i - 1]
        if prev > EPS:
            rets.append((days[i], (values[i] - flows[i]) / prev - 1))
    idx, index_series = 1.0, [(days[i0], 1.0)]
    for day, r in rets:
        if day == days[i0]:
            idx *= 1 + r
            index_series[0] = (day, idx)
            continue
        idx *= 1 + r
        index_series.append((day, idx))

    span = (today - to_date(days[i0])).days
    trading = [r for day, r in rets if to_date(day).weekday() < 5]
    vol = _stdev(trading) * math.sqrt(252) if len(trading) > 10 else None
    twr = idx - 1
    ann = (idx ** (365.0 / span) - 1) if span >= 365 and idx > 0 else None
    peak, mdd, cur_dd = 0.0, 0.0, 0.0
    for _, v in index_series:
        peak = max(peak, v)
        dd = v / peak - 1 if peak > 0 else 0.0
        mdd = min(mdd, dd)
        cur_dd = dd
    ret_for_sharpe = ann if ann is not None else (twr * 365.0 / span if span > 0 else None)
    sharpe = (ret_for_sharpe - RISK_FREE) / vol if vol and ret_for_sharpe is not None else None

    # Since the start (i0 = 0) the window begins empty and the first day's money counts as a flow; a later window
    # begins with the value at its first day's close.
    start_value = values[i0] if i0 > 0 else 0.0
    first_flow = i0 + 1 if i0 > 0 else 0
    window_flows = [(to_date(days[i0]), -start_value)] if start_value > EPS else []
    window_flows += [(to_date(days[i]), -flows[i]) for i in range(first_flow, len(days)) if flows[i]]
    window_flows.append((today, values[-1]))
    port_xirr = xirr(window_flows)
    net_flows = sum(flows[first_flow:])

    metrics = {
        "range": rng, "start": days[i0], "end": days[-1], "days": span,
        "start_value": round(start_value, 2), "end_value": round(values[-1], 2),
        "net_flows": round(net_flows, 2),
        "gain": round(values[-1] - start_value - net_flows, 2),
        "twr": _p(twr), "twr_annualised": _p(ann), "xirr": _p(port_xirr),
        "volatility": _p(vol), "max_drawdown": _p(mdd), "current_drawdown": _p(cur_dd), "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "best_day": _p(max(trading)) if trading else None, "worst_day": _p(min(trading)) if trading else None,
        "positive_days_pct": round(sum(1 for r in trading if r > 0) / len(trading) * 100, 1) if trading else None,
    }

    # ── benchmarks: invest the same cash flows on the same days (PME) ──
    benchmarks = []
    for key, b in bench_hist.items():
        s = Series(b["points"])
        if not s:
            continue
        units, bvals = 0.0, []
        bflows = []
        for i in range(i0, len(days)):
            px = s.at(days[i])
            if b.get("currency") == "USD":
                px = px * fx_at(days[i]) if px else None
            f = (start_value if i0 > 0 else flows[i0]) if i == i0 else flows[i]
            if px and f:
                units += f / px
                bflows.append((to_date(days[i]), -f))
            bvals.append(units * px if px else None)
        end_val = bvals[-1] or 0.0
        bflows.append((today, end_val))
        p0, p1 = s.at(days[i0]), s.at(days[-1])
        bx = xirr(bflows)
        benchmarks.append({
            "key": key, "label": b["label"], "symbol": b["symbol"], "end_value": round(end_val, 2),
            "xirr": _p(bx), "index_return": _p(p1 / p0 - 1) if p0 and p1 else None,
            "excess_xirr": _p(port_xirr - bx) if port_xirr is not None and bx is not None else None,
            "values": bvals,
        })

    # ── contributors: each holding's gain inside the window (value at the end − value at the start + money it
    #    returned − money put in), so the list adds up to the window's gain apart from the USD wallet's cash ──
    d0, d1 = days[i0], days[-1]
    contributors = []
    for iid, ts in by_inst.items():
        inst = inst_map[iid]
        if inst["asset_class"] == d.CASH:
            continue
        v0 = inst_value(iid, d0, to_date(d0))[0] if i0 > 0 else 0.0
        v1 = inst_value(iid, d1, today)[0]
        net = 0.0
        for t in ts:
            day = str(t["date"])[:10]
            if day > d1 or (day <= d0 if i0 > 0 else day < d0):
                continue
            amt = _f(t["amount"])
            if t["type"] == d.BUY:
                net -= amt
            elif t["type"] in (d.SELL, d.DIVIDEND, d.INTEREST, d.REPAYMENT, d.MATURITY):
                net += amt
        if v0 or v1 or net:
            contributors.append({"id": iid, "name": inst["name"], "group": group_of[iid], "asset_class": inst["asset_class"],
                                 "start_value": round(v0, 2), "end_value": round(v1, 2), "gain": round(v1 - v0 + net, 2)})
    contributors.sort(key=lambda c: -c["gain"])

    # ── monthly returns (TWR chained within each month) ──
    monthly: dict[str, float] = {}
    for day, r in rets:
        m = day[:7]
        monthly[m] = (1 + monthly.get(m, 0.0)) * (1 + r) - 1

    # ── series, downsampled for transport ──
    window = list(range(i0, len(days)))
    step = max(1, len(window) // 400)
    picks = window[::step]
    if picks[-1] != window[-1]:
        picks.append(window[-1])
    idx_map = dict(index_series)
    cum_flow, cum = [], 0.0
    for i in range(len(days)):
        cum += flows[i]
        cum_flow.append(cum)
    series = []
    for i in picks:
        row = {"date": days[i], "value": round(values[i], 2), "cost": round(costs[i], 2),
               "net_invested": round(cum_flow[i], 2), "index": round(idx_map.get(days[i], 1.0), 6),
               "groups": {g: round(v, 2) for g, v in gvals[i].items()}}
        for b in benchmarks:
            v = b["values"][i - i0]
            row[b["key"]] = round(v, 2) if v is not None else None
        series.append(row)
    for b in benchmarks:
        b.pop("values")

    return {"series": series, "metrics": metrics, "benchmarks": benchmarks, "contributors": contributors,
            "monthly": [{"month": m, "return": _p(v)} for m, v in sorted(monthly.items())]}


def _stdev(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _p(v):
    return None if v is None else round(v * 100, 2)
