"""Daily portfolio value history, time-weighted return, risk metrics and benchmark comparison."""
from __future__ import annotations

import math
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta

from .. import domain as d
from .portfolio import EPS, fd_accrued, run_fifo, to_date, _f
from .xirr import xirr

RISK_FREE = 0.065  # ~ Indian 1-year T-bill
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
                  bench_hist: dict[str, dict], today: date | None = None, rng: str = "ALL") -> dict:
    today = today or date.today()
    if not txns:
        return {"series": [], "metrics": {}, "benchmarks": [], "monthly": []}
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
                flows_by_day[day] -= amt
        if ac in d.TRADABLE:
            q, qe, ce = 0.0, [], []
            dates = sorted({str(t["date"])[:10] for t in ts})
            for day in dates:
                todays = [t for t in ts if str(t["date"])[:10] == day]
                q += sum(_f(t["quantity"]) * (1 if t["type"] == d.BUY else -1) for t in todays if t["type"] in (d.BUY, d.SELL))
                qe.append((day, max(q, 0.0)))
                lots, _, _ = run_fifo(iid, [t for t in ts if str(t["date"])[:10] <= day])
                ce.append((day, sum(l.cost for l in lots)))
            qty_events[iid], cost_events[iid] = qe, ce

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
                        fc = _f(t["amount_fc"]) or (_f(t["amount"]) / fallback_fx if fallback_fx else 0)
                        events[str(t["date"])[:10]] += -fc if t["type"] == d.BUY else fc
        bal, out = 0.0, []
        for day in sorted(events):
            bal += events[day]
            out.append((day, bal))
        return Series(out)

    price_series = {s: Series(p) for s, p in price_hist.items()}
    qty_series = {iid: Series(e) for iid, e in qty_events.items()}
    cost_series = {iid: Series(e) for iid, e in cost_events.items()}
    wallets = [(i, wallet_fc_events(i)) for i in instruments if i["asset_class"] == d.CASH and i["id"] in by_inst]

    def fx_at(iso):
        return fx.at(iso) or fallback_fx or 0.0

    def value_on(iso: str, day: date) -> tuple[float, float]:
        value = cost = 0.0
        for iid, ts in by_inst.items():
            inst = inst_map[iid]
            ac = inst["asset_class"]
            if ac in d.TRADABLE:
                q = qty_series[iid].at(iso) or 0.0
                c = cost_series[iid].at(iso) or 0.0
                if q <= EPS:
                    continue
                px = price_series.get(inst.get("symbol") or "", Series([])).at(iso) if inst.get("symbol") else None
                mult = fx_at(iso) if inst.get("currency") == "USD" else 1.0
                value += q * px * mult if px and mult else c
                cost += c
            elif ac == d.P2P:
                lent = sum(_f(t["amount"]) for t in ts if t["type"] == d.BUY and str(t["date"])[:10] <= iso)
                back = sum(_f(t["principal"]) if t.get("principal") is not None else 0.0
                           for t in ts if t["type"] == d.REPAYMENT and str(t["date"])[:10] <= iso)
                out = max(lent - back, 0.0)
                if (inst.get("status") or "") == "closed" and ts and iso >= str(ts[-1]["date"])[:10]:
                    out = 0.0
                value += out
                cost += out
            elif ac == d.FIXED_DEPOSIT:
                if any(t["type"] == d.MATURITY and str(t["date"])[:10] <= iso for t in ts):
                    continue
                principal = sum(_f(t["amount"]) for t in ts if t["type"] == d.BUY and str(t["date"])[:10] <= iso)
                if principal:
                    start = to_date(ts[0]["date"])
                    value += fd_accrued(principal, _f(inst.get("rate")), start, day) if inst.get("rate") else principal
                    cost += principal
        for inst, ws in wallets:
            bal = ws.at(iso) or 0.0
            value += bal * fx_at(iso)
            cost += bal * fx_at(iso)
        return value, cost

    # ── daily walk ──
    days, values, costs, flows = [], [], [], []
    cur = first
    while cur <= today:
        iso = cur.isoformat()
        v, c = value_on(iso, cur)
        days.append(iso)
        values.append(v)
        costs.append(c)
        flows.append(flows_by_day.get(iso, 0.0))
        cur += timedelta(days=1)

    ws = _range_start(rng, first, today).isoformat()
    i0 = days.index(ws) if ws in days else 0
    rets: list[tuple[str, float]] = []
    for i in range(i0 + 1, len(days)):
        prev = values[i - 1]
        if prev > EPS:
            rets.append((days[i], (values[i] - flows[i]) / prev - 1))
    idx, index_series = 1.0, [(days[i0], 1.0)]
    for day, r in rets:
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

    window_flows = [(to_date(days[i0]), -values[i0])] if values[i0] > EPS else []
    window_flows += [(to_date(days[i]), -flows[i]) for i in range(i0 + 1, len(days)) if flows[i]]
    window_flows.append((today, values[-1]))
    port_xirr = xirr(window_flows)

    metrics = {
        "range": rng, "start": days[i0], "end": days[-1], "days": span,
        "start_value": round(values[i0], 2), "end_value": round(values[-1], 2),
        "net_flows": round(sum(flows[i0 + 1:]), 2),
        "gain": round(values[-1] - values[i0] - sum(flows[i0 + 1:]), 2),
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
            f = values[i0] if i == i0 else flows[i]
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
               "net_invested": round(cum_flow[i], 2), "index": round(idx_map.get(days[i], 1.0), 6)}
        for b in benchmarks:
            v = b["values"][i - i0]
            row[b["key"]] = round(v, 2) if v is not None else None
        series.append(row)
    for b in benchmarks:
        b.pop("values")

    return {"series": series, "metrics": metrics, "benchmarks": benchmarks,
            "monthly": [{"month": m, "return": _p(v)} for m, v in sorted(monthly.items())]}


def _stdev(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _p(v):
    return None if v is None else round(v * 100, 2)
