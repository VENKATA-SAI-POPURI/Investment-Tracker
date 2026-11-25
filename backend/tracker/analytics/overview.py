"""The group read model behind the redesigned app (Home, Portfolio, Analysis).

Pure functions over the portfolio engine's output: no I/O. Seven groups (domain.GROUPS) replace the eight
segments on screen; every return is measured on the same external cash flows (portfolio.external_flows), so a
group's return, its market comparison and the totals all agree.

Market comparison ("vs market") is a public-market-equivalent: each rupee that went into a holding is put, on
the same day, into that holding's market (Nifty 500 for Indian equity, the S&P 500 in rupees for US equity, gold
for commodities, a fixed FD or EPFO rate for deposits), and taken out on the same days money came back. The
market's return on those same flows is compared with yours. Price indices exclude dividends, so an estimated
dividend yield is added back and labelled as an estimate.
"""
from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta

from .. import domain as d
from .portfolio import EPS, _f, external_flows, to_date, wallet_owners
from .xirr import xirr

# ── market comparison ──
FD_RATE = 7.0          # % a year: a typical 1–3 year bank FD
EPF_RATE = 8.25        # % a year: the EPFO rate for FY2024-25
DIV_YIELD = {"NIFTY500": 1.2, "SP500": 1.4, "GOLD": 0.0}   # % a year added back to price indices (estimate)
BENCH_LABEL = {"NIFTY500": "Nifty 500", "SP500": "S&P 500 in ₹", "GOLD": "Gold in ₹", "FD": "FD rate",
               "EPF": "EPFO rate", "NPS": "Nifty 500 + FD mix"}
# A holding's market as legs (benchmark key, weight). NPS is roughly half equity, half bonds.
LEGS = {"NIFTY500": [("NIFTY500", 1.0)], "SP500": [("SP500", 1.0)], "GOLD": [("GOLD", 1.0)], "FD": [("FD", 1.0)],
        "EPF": [("EPF", 1.0)], "NPS": [("NIFTY500", 0.5), ("FD", 0.5)]}
EQUIVALENT_PP = 0.1    # within ±0.1 percentage points a group is "in line with the market"


def bench_key(p: dict) -> str:
    ac, tax = p["asset_class"], (p.get("tax_class") or "")
    if ac == d.EQUITY:
        return "SP500" if p["segment"] == d.SEG_EQ_US else "NIFTY500"
    if ac == d.CASH:
        return "SP500"
    if ac == d.MUTUAL_FUND:
        return "FD" if tax == d.TAX_DEBT else "SP500" if tax == d.TAX_FOREIGN else "NIFTY500"
    if ac == d.COMMODITY:
        return "GOLD"
    if ac == d.EPF:
        return "EPF"
    if ac == d.NPS:
        return "NPS"
    return "FD"   # P2P and fixed deposits


class Prices:
    """Benchmark price lookups: forward-filled index closes (USD ones converted to rupees), with the dividend
    yield compounded in, and synthetic fixed-rate series for FD and EPF."""

    def __init__(self, bench_hist: dict, fx_hist: list, fd_rate: float = FD_RATE, epf_rate: float = EPF_RATE):
        self.series: dict[str, tuple[list[str], list[float]]] = {}
        for key, b in (bench_hist or {}).items():
            pts = sorted(b.get("points") or [])
            if pts:
                self.series[key] = ([p[0] for p in pts], [float(p[1]) for p in pts])
        self.usd = {k for k, b in (bench_hist or {}).items() if (b.get("currency") or "INR") == "USD"}
        fx = sorted(fx_hist or [])
        self.fx = ([p[0] for p in fx], [float(p[1]) for p in fx])
        self.rates = {"FD": fd_rate, "EPF": epf_rate}
        self.anchor = date(2000, 1, 1)

    @staticmethod
    def _at(s: tuple[list[str], list[float]], iso: str) -> float | None:
        i = bisect_right(s[0], iso) - 1
        return s[1][i] if i >= 0 else None

    def price(self, key: str, day: date) -> float | None:
        if key in self.rates:
            return (1 + self.rates[key] / 100) ** ((day - self.anchor).days / 365.0)
        s = self.series.get(key)
        if not s:
            return None
        iso = day.isoformat()
        px = self._at(s, iso)
        if px is None:
            return None
        if key in self.usd:
            fx = self._at(self.fx, iso) if self.fx[0] else None
            if not fx:
                return None
            px *= fx
        y = DIV_YIELD.get(key, 0.0)
        if y:
            px *= (1 + y / 100) ** ((day - self.anchor).days / 365.0)
        return px

    def has(self, key: str) -> bool:
        return key in self.rates or key in self.series


def _pme(routed: list[tuple[date, float, str]], prices: Prices, today: date) -> float | None:
    """End value today of putting each flow into its market. `routed` = (date, amount, bench key) with the
    investor's sign (negative = money put in). None when a needed market price is missing."""
    units: dict[str, float] = defaultdict(float)
    for day, amt, key in routed:
        for leg, w in LEGS[key]:
            px = prices.price(leg, day)
            if not px:
                return None
            units[leg] += -amt * w / px
    end = 0.0
    for leg, u in units.items():
        px = prices.price(leg, today)
        if not px:
            return None
        end += u * px
    return end


def pme_series(routed: list[tuple[date, float, str]], prices: Prices, dates: list[date]) -> list[float | None]:
    """The same-money-in-the-market value on each of `dates` (None where a price is missing)."""
    routed = sorted(routed, key=lambda r: r[0])
    units: dict[str, float] = defaultdict(float)
    out, i = [], 0
    for day in dates:
        while i < len(routed) and routed[i][0] <= day:
            dt, amt, key = routed[i]
            for leg, w in LEGS[key]:
                px = prices.price(leg, dt)
                if not px:
                    return [None] * len(dates)
                units[leg] += -amt * w / px
            i += 1
        val = 0.0
        for leg, u in units.items():
            px = prices.price(leg, day)
            if not px:
                val = None
                break
            val += u * px
        out.append(None if val is None else round(val, 2))
    return out


def month_ends(first: date, today: date) -> list[date]:
    out, d = [], date(first.year, first.month, 1)
    while d <= today:
        nxt = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
        out.append(min(nxt - timedelta(days=1), today))
        d = nxt
    if not out or out[-1] != today:
        out.append(today)
    return out


def _pct(v: float | None) -> float | None:
    return None if v is None else round(v * 100, 2)


def _r(v: float | None, n: int = 2) -> float | None:
    return None if v is None else round(v + 0.0, n)


# ── targets ──

PROFILE_MIX = {   # equity share, commodities, P2P (% of everything)
    "conservative": (35, 10, 0), "balanced": (55, 10, 3), "growth": (70, 8, 4), "aggressive": (85, 5, 5),
}
EQUITY_SPLIT = {d.GRP_EQ_IN: 0.35, d.GRP_EQ_GLOBAL: 0.15, d.GRP_MF: 0.50}
AGE_TAPER_FROM = 45   # each year of age past this moves one point from equity to safety


def suggested_mix(profile: str | None, age: float | None, current_pct: dict[str, float]) -> dict:
    """A simple, explainable target mix from the risk profile and age.
    Equity share by profile (less one point a year past 45, never under 20), split 35/15/50 between India
    stocks, Global stocks and Mutual funds; a fixed slice for commodities and P2P; the rest is safety money,
    filled first by the EPF you already have (it cannot be moved) and then by Others (FDs, NPS)."""
    key = (profile or "balanced").lower()
    eq, gold, p2p = PROFILE_MIX.get(key, PROFILE_MIX["balanced"])
    if age:
        eq = max(eq - max(float(age) - AGE_TAPER_FROM, 0.0), 20.0)
    safety = 100.0 - eq - gold - p2p
    epf = min(current_pct.get(d.GRP_EPF, 0.0), safety)
    mix = {g: round(eq * w, 1) for g, w in EQUITY_SPLIT.items()}
    mix.update({d.GRP_COMMODITY: float(gold), d.GRP_P2P: float(p2p), d.GRP_EPF: round(epf, 1)})
    mix[d.GRP_OTHERS] = round(100.0 - sum(mix.values()), 1)
    return {"profile": key, "age": age, "equity": round(eq, 1), "mix": {g: mix.get(g, 0.0) for g in d.GROUPS},
            "how": ("Equity share from your risk profile" + (f", less 1 point a year past {AGE_TAPER_FROM}" if age else "")
                    + "; split 35 / 15 / 50 across India stocks, Global stocks and Mutual funds. "
                    "EPF stays as it is; the rest of the safe money goes to Others.")}


def my_targets(settings: dict) -> dict[str, float] | None:
    """`groupTargets` when saved, else the old segment targets summed into groups, else None."""
    t = settings.get("groupTargets")
    if isinstance(t, dict) and t:
        return {g: float(t.get(g) or 0.0) for g in d.GROUPS}
    old = d.groups_from_segments(settings.get("targetAllocation"))
    return {g: float(old.get(g, 0.0)) for g in d.GROUPS} if old else None


# ── the read model ──

def group_view(port: dict, txns: list[dict], settings: dict, bench_hist: dict | None, fx_hist: list | None,
               today: date | None = None) -> dict:
    """Totals and the seven groups, each with value, share, money put in, gain, return a year (XIRR), targets
    and its market comparison; plus the whole portfolio against the same money in each part's market."""
    today = today or (to_date(port["as_of"]) if port.get("as_of") else date.today())
    positions = port["positions"]
    by_inst: dict[int, list[dict]] = defaultdict(list)
    for t in txns:
        by_inst[t["instrument_id"]].append(t)
    owners = wallet_owners(positions)
    prices = Prices(bench_hist or {}, fx_hist or [])

    flows: dict[str, list[tuple[date, float]]] = defaultdict(list)
    routed: dict[str, list[tuple[date, float, str]]] = defaultdict(list)
    keys_used: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    agg: dict[str, dict] = {g: {"value": 0.0, "day_change": 0.0, "count": 0, "unrealized": 0.0} for g in d.GROUPS}
    for p in positions:
        g = p["group"]
        a = agg[g]
        a["value"] += _f(p["value"])
        a["day_change"] += _f(p.get("day_change"))
        a["unrealized"] += _f(p.get("unrealized"))
        if p.get("is_open") and p["asset_class"] != d.CASH:
            a["count"] += 1
        fl = external_flows(p, by_inst.get(p["id"], []), owners, today)
        k = bench_key(p)
        flows[g] += fl
        routed[g] += [(dt, amt, k) for dt, amt in fl]
        keys_used[g][k] += sum(-amt for _, amt in fl if amt < 0)

    total = sum(a["value"] for a in agg.values())
    mine = my_targets(settings)
    current_pct = {g: (agg[g]["value"] / total * 100 if total > 0 else 0.0) for g in d.GROUPS}
    age = (settings.get("retirementPlan") or {}).get("current_age")
    suggested = suggested_mix(settings.get("riskProfile"), age, current_pct)

    groups = []
    for g in d.GROUPS:
        a = agg[g]
        fl = flows[g]
        if a["value"] <= EPS and not fl and not (mine or {}).get(g):
            continue
        put_in = -sum(amt for _, amt in fl)
        own = xirr(fl + ([(today, a["value"])] if a["value"] > EPS else []))
        bench = None
        if fl and keys_used[g]:
            main = max(keys_used[g], key=keys_used[g].get)
            end = _pme(routed[g], prices, today)
            bx = xirr(fl_bench(routed[g], end, today)) if end is not None else None
            diff = (own - bx) * 100 if own is not None and bx is not None else None
            bench = {"key": main, "label": BENCH_LABEL[main] if len(keys_used[g]) == 1 else BENCH_LABEL[main] + " mix",
                     "xirr": _pct(bx), "end_value": _r(end), "diff": _r(diff),
                     "verdict": None if diff is None else "same" if abs(diff) <= EQUIVALENT_PP else "ahead" if diff > 0 else "behind",
                     "estimate": any(DIV_YIELD.get(leg, 0) for k in keys_used[g] for leg, _ in LEGS[k])}
        target = (mine or {}).get(g) if mine else None
        groups.append({
            "key": g, "label": d.GROUP_LABELS[g], "value": _r(a["value"]), "pct": _r(current_pct[g]),
            "put_in": _r(put_in), "gain": _r(a["value"] - put_in), "unrealized": _r(a["unrealized"]),
            "gain_pct": _r((a["value"] - put_in) / put_in * 100) if put_in > EPS else None,
            "xirr": _pct(own), "day_change": _r(a["day_change"]), "count": a["count"],
            "target": target, "suggested": suggested["mix"].get(g),
            "gap": _r(current_pct[g] - target) if target is not None else None,
            "bench": bench,
        })

    all_flows = [f for g in d.GROUPS for f in flows[g]]
    all_routed = [r for g in d.GROUPS for r in routed[g]]
    put_in = -sum(a for _, a in all_flows)
    own = xirr(all_flows + ([(today, total)] if total > EPS else []))
    end = _pme(all_routed, prices, today) if all_routed else None
    bx = xirr(fl_bench(all_routed, end, today)) if end is not None else None
    series = []
    if all_routed:
        dates = month_ends(min(r[0] for r in all_routed), today)
        series = [{"date": dt.isoformat(), "market": v} for dt, v in zip(dates, pme_series(all_routed, prices, dates))]
    ahead = sum(1 for g in groups if g["bench"] and g["bench"]["verdict"] in ("ahead", "same"))
    compared = sum(1 for g in groups if g["bench"] and g["bench"]["verdict"])
    t = port["totals"]
    return {
        "as_of": today.isoformat(),
        "totals": {"value": _r(total), "put_in": _r(put_in), "gain": _r(total - put_in),
                   "gain_pct": _r((total - put_in) / put_in * 100) if put_in > EPS else None,
                   "xirr": _pct(own), "day_change": t.get("day_change"), "day_change_pct": t.get("day_change_pct"),
                   "unrealized": t.get("unrealized"), "realized": t.get("realized"), "income": t.get("income"),
                   "missing_prices": t.get("missing_prices") or []},
        "market": {"xirr": _pct(bx), "end_value": _r(end),
                   "diff": _r((own - bx) * 100) if own is not None and bx is not None else None,
                   "groups_ahead": ahead, "groups_compared": compared, "series": series,
                   "note": "Same money on the same dates, each part in its own market. Index returns include an "
                           "estimated dividend yield (Nifty 500 1.2%, S&P 500 1.4% a year)."},
        "targets": {"mine": mine, "suggested": suggested, "has_mine": mine is not None},
        "groups": groups,
    }


def fl_bench(routed: list[tuple[date, float, str]], end: float | None, today: date) -> list[tuple[date, float]]:
    return [(dt, amt) for dt, amt, _ in routed] + ([(today, end)] if end else [])


# ── rebalancing by group ──

SELLABLE = {d.GRP_EQ_IN: d.SEG_EQ_IN, d.GRP_EQ_GLOBAL: d.SEG_EQ_US, d.GRP_MF: d.SEG_MF, d.GRP_COMMODITY: d.SEG_COMMODITY}
LET_MATURE = (d.GRP_P2P, d.GRP_OTHERS)
NOT_BUYABLE = (d.GRP_EPF,)


def rebalance(groups: list[dict], targets: dict[str, float], new_money: float = 0.0, allow_sell: bool = False, *,
              plan_sales=None) -> dict:
    """What to add (and optionally sell) per group to move toward `targets` (% of everything).

    Without selling, new money goes to the groups furthest under target, in proportion to how far under they
    are (EPF cannot be topped up and is skipped). With selling, groups over target that can be sold (stocks,
    funds, commodities) are trimmed, lowest tax first through `plan_sales(legs)`; FDs and P2P loans over target
    are left to mature and EPF is locked. Buys never spend more than the new money plus what the sales free."""
    tsum = sum(float(v or 0) for v in targets.values()) or 100.0
    tw = {g: float(targets.get(g) or 0) / tsum for g in d.GROUPS}
    cur = {g["key"]: float(g["value"] or 0) for g in groups}
    total = sum(cur.values())
    final = total + new_money
    diff = {g: final * tw[g] - cur.get(g, 0.0) for g in d.GROUPS}
    rows = {g: {"key": g, "label": d.GROUP_LABELS[g], "current": round(cur.get(g, 0.0), 2), "target_pct": round(tw[g] * 100, 2),
                "action": "hold", "amount": 0.0} for g in d.GROUPS if cur.get(g) or tw[g]}
    sells_total, tax_total, not_sold, note = 0.0, None, 0.0, None
    if allow_sell:
        legs = []
        for g, r in rows.items():
            over = -diff[g]
            if over <= 0.5:
                continue
            if g in SELLABLE:
                legs.append({"segment": SELLABLE[g], "amount": round(over, 2), "group": g})
            else:
                not_sold += over
                r.update(action="hold", let_mature=round(over, 2) if g in LET_MATURE else None, locked=g in NOT_BUYABLE)
        legs.sort(key=lambda l: -l["amount"])
        res = plan_sales([{"segment": l["segment"], "amount": l["amount"]} for l in legs]) if (legs and plan_sales) else None
        by_seg = {l["segment"]: l for l in (res or {}).get("legs", [])}
        for l in legs:
            got = by_seg.get(l["segment"])
            covered = got["covered"] if got else l["amount"]
            r = rows[l["group"]]
            r.update(action="sell", amount=round(covered, 2), sells=(got or {}).get("sells", []),
                     tax=(got or {}).get("tax"))
            sells_total += covered
        if res:
            tax_total, note = res.get("tax_total"), res.get("note")
    budget = new_money + sells_total
    deficits = {g: max(diff[g], 0.0) for g in rows if g not in NOT_BUYABLE}
    dsum = sum(deficits.values())
    if budget > 0.5:
        for g, defi in deficits.items():
            add = budget * defi / dsum if dsum > 0 else budget * tw[g]
            if add > 0.5:
                rows[g].update(action="buy", amount=round(add, 2))
    after = {g: r["current"] + (r["amount"] if r["action"] == "buy" else -r["amount"] if r["action"] == "sell" else 0)
             for g, r in rows.items()}
    atot = sum(after.values()) or 1.0
    for g, r in rows.items():
        r["current_pct"] = round(r["current"] / total * 100, 2) if total else 0.0
        r["after_pct"] = round(after[g] / atot * 100, 2)
    ordered = sorted(rows.values(), key=lambda r: ({"buy": 0, "sell": 1, "hold": 2}[r["action"]], -r["amount"]))
    return {"rows": ordered, "total": round(total, 2), "new_money": round(new_money, 2), "allow_sell": allow_sell,
            "sells_total": round(sells_total, 2), "tax_total": tax_total, "tax_note": note, "not_sold": round(not_sold, 2),
            "shortfall": round(sum(max(diff[g], 0) for g in rows if g not in NOT_BUYABLE) - new_money, 2)}


# ── suggestions (Analysis › Improve, and the top three on Home) ──

def _money(v: float) -> str:
    a = abs(v)
    s = f"₹{a / 1e5:.2f} L" if a >= 1e5 else f"₹{a / 1e3:.1f}K" if a >= 1e3 else f"₹{a:,.0f}"
    return ("−" if v < 0 else "") + s


def suggestions(view: dict, port: dict, tax: dict | None, today: date, slab: float = 0.30, limit: int = 5) -> list[dict]:
    """At most `limit` ideas, most urgent and largest first. Each has one number and one action.
    Order: money at risk or due soon, then tax money, then the mix, then holdings to review."""
    out: list[dict] = []
    pos = [p for p in port["positions"] if p.get("is_open")]

    # 1. money at risk / due soon
    overdue = [p for p in pos if p["asset_class"] == d.P2P and (p.get("overdue_days") or 0) > 30]
    if overdue:
        amt = sum(_f(p.get("outstanding")) for p in overdue)
        out.append({"id": "p2p:overdue", "rank": 1, "tone": "warn", "icon": "alert",
                    "title": f"{len(overdue)} P2P loan{'s' if len(overdue) > 1 else ''} overdue",
                    "detail": "An EMI is more than 30 days late. Follow up, or mark as defaulted.",
                    "impact": f"{_money(amt)} at risk", "value": amt, "cta": "View", "link": "/portfolio?group=p2p"})
    for p in sorted((p for p in pos if p["asset_class"] == d.FIXED_DEPOSIT and p.get("days_to_maturity") is not None
                     and 0 <= p["days_to_maturity"] <= 45), key=lambda p: p["days_to_maturity"]):
        mv = _f(p.get("maturity_value")) or _f(p["value"])
        under = [g["label"] for g in view["groups"] if (g.get("gap") or 0) <= -2]
        out.append({"id": f"fd:maturing:{p['id']}", "rank": 1, "tone": "info", "icon": "calendar",
                    "title": f"{p['name']} matures in {p['days_to_maturity']} days",
                    "detail": f"{_money(mv)} comes back" + (f". Under target: {', '.join(under[:2])}" if under else ""),
                    "impact": f"{_money(mv)} to place", "value": mv, "cta": "Plan it", "link": "/analysis?tab=mix"})
    # 2. tax money
    opp = (tax or {}).get("opportunities") or {}
    lt = opp.get("ltcg_harvest") or {}
    book = _f(lt.get("suggested_booking"))
    if book >= 5000 and today.month in (1, 2, 3, 10, 11, 12):
        saved = _f(lt.get("future_tax_saved")) or book * 0.125
        out.append({"id": "tax:ltcg-harvest", "rank": 2, "tone": "good", "icon": "sparkle",
                    "title": "Book tax-free gains",
                    "detail": f"Sell and buy back {_money(book)} of long-term gains before 31 Mar.",
                    "impact": f"Save ≈ {_money(saved)}", "value": saved, "cta": "See lots", "link": "/tax"})
    loss = _f(opp.get("loss_harvest_offsettable"))
    if loss >= 5000:
        saved = loss * 0.2
        out.append({"id": "tax:loss-harvest", "rank": 2, "tone": "good", "icon": "receipt",
                    "title": "Use losses to cut this year's tax",
                    "detail": f"{_money(loss)} of losses can offset gains you've booked this year.",
                    "impact": f"Save ≈ {_money(saved)}", "value": saved, "cta": "See which", "link": "/tax"})
    # 3. the mix
    total = _f(view["totals"]["value"])
    for g in sorted((g for g in view["groups"] if g.get("gap") is not None and g["gap"] <= -2 and g["key"] != d.GRP_EPF),
                    key=lambda g: g["gap"]):
        short = -g["gap"] / 100 * total
        sip = max(round(short / 12 / 100) * 100, 100)
        out.append({"id": f"mix:under:{g['key']}", "rank": 3, "tone": "warn", "icon": "target",
                    "title": f"Top up {g['label']}",
                    "detail": f"{_money(short)} below your {g['target']:g}% target.",
                    "impact": f"{_money(sip)} / month for a year", "value": short, "cta": "Rebalance",
                    "link": "/analysis?tab=mix", "group": g["key"]})
    # 4. holdings to review
    for p in sorted((p for p in pos if p["asset_class"] in d.TRADABLE and (p.get("unrealized_pct") or 0) <= -20
                     and p.get("first_date") and (today - to_date(p["first_date"])).days >= 180),
                    key=lambda p: _f(p.get("unrealized"))):
        months = (today - to_date(p["first_date"])).days // 30
        out.append({"id": f"review:{p['id']}", "rank": 4, "tone": "bad", "icon": "arrowDown",
                    "title": f"Review {p['name']}",
                    "detail": f"Down {abs(p['unrealized_pct']):.1f}% over {months} months.",
                    "impact": _money(_f(p.get("unrealized"))), "value": abs(_f(p.get("unrealized"))), "cta": "Open",
                    "link": f"/portfolio?holding={p['id']}", "instrument_id": p["id"]})
    for p in sorted((p for p in pos if p["asset_class"] in d.TRADABLE and total > 0 and _f(p["value"]) / total > 0.15),
                    key=lambda p: -_f(p["value"])):
        out.append({"id": f"concentration:{p['id']}", "rank": 4, "tone": "warn", "icon": "pie",
                    "title": f"{p['name']} is {(_f(p['value']) / total * 100):.0f}% of everything",
                    "detail": "One holding this large can swing the whole portfolio.",
                    "impact": _money(_f(p["value"])), "value": _f(p["value"]) * 0.05, "cta": "Open",
                    "link": f"/portfolio?holding={p['id']}", "instrument_id": p["id"]})
    missing = (view["totals"].get("missing_prices") or [])
    if missing:
        out.append({"id": "data:missing-prices", "rank": 1, "tone": "warn", "icon": "alert",
                    "title": f"{len(missing)} holding{'s' if len(missing) > 1 else ''} without a price",
                    "detail": "Valued at cost until a ticker is added: " + ", ".join(missing[:3]),
                    "impact": "Values may be off", "value": 0.0, "cta": "Fix", "link": "/activity?tab=checks"})
    out.sort(key=lambda s: (s["rank"], -s["value"]))
    return out[:limit]


# ── how a group's numbers are worked out (the explanation sheet) ──

def group_explain(port: dict, txns: list[dict], key: str, bench_hist: dict | None, fx_hist: list | None,
                  today: date | None = None) -> dict:
    """Everything behind one group's return and its market comparison: the money put in and taken out (by year),
    the value now, the yearly return on those flows, the same flows in the group's market, and each holding."""
    today = today or (to_date(port["as_of"]) if port.get("as_of") else date.today())
    if key not in d.GROUPS:
        raise ValueError("Unknown group")
    by_inst: dict[int, list[dict]] = defaultdict(list)
    for t in txns:
        by_inst[t["instrument_id"]].append(t)
    owners = wallet_owners(port["positions"])
    prices = Prices(bench_hist or {}, fx_hist or [])
    holdings, flows, routed, years = [], [], [], defaultdict(lambda: {"put_in": 0.0, "taken_out": 0.0})
    for p in (p for p in port["positions"] if p["group"] == key):
        fl = external_flows(p, by_inst.get(p["id"], []), owners, today)
        k = bench_key(p)
        flows += fl
        routed += [(dt, a, k) for dt, a in fl]
        for dt, a in fl:
            years[dt.year]["put_in" if a < 0 else "taken_out"] += abs(a)
        pin, pout, val = -sum(a for _, a in fl if a < 0), sum(a for _, a in fl if a > 0), _f(p["value"])
        own = xirr(fl + ([(today, val)] if val > EPS else []))
        holdings.append({"id": p["id"], "name": p["name"], "is_open": p.get("is_open"), "put_in": _r(pin), "taken_out": _r(pout),
                         "value": _r(val), "gain": _r(val + pout - pin), "xirr": _pct(own), "market": BENCH_LABEL[k],
                         "flows": len(fl), "first": min((dt for dt, _ in fl), default=None)})
    value = sum(_f(p["value"]) for p in port["positions"] if p["group"] == key)
    put_in = -sum(a for _, a in flows if a < 0)
    taken_out = sum(a for _, a in flows if a > 0)
    own = xirr(flows + ([(today, value)] if value > EPS else []))
    end = _pme(routed, prices, today) if routed else None
    bx = xirr(fl_bench(routed, end, today)) if end is not None else None
    used = sorted({k for _, _, k in routed})
    first = min((dt for dt, _ in flows), default=None)
    years_held = (today - first).days / 365 if first else 0
    for h in holdings:
        h["first"] = h["first"].isoformat() if h["first"] else None
    holdings.sort(key=lambda h: -(h["value"] or 0) - (h["gain"] or 0) * 1e-6)
    return {
        "key": key, "label": d.GROUP_LABELS[key], "as_of": today.isoformat(),
        "value": _r(value), "put_in": _r(put_in), "taken_out": _r(taken_out), "gain": _r(value + taken_out - put_in),
        "first_date": first.isoformat() if first else None, "years": round(years_held, 1), "flows": len(flows),
        "xirr": _pct(own),
        "simple_pct": _r((value + taken_out - put_in) / put_in * 100) if put_in > EPS else None,
        "market": {"labels": [BENCH_LABEL[k] for k in used], "end_value": _r(end), "xirr": _pct(bx),
                   "diff_pts": _r((own - bx) * 100) if own is not None and bx is not None else None,
                   "dividend_yield": {k: DIV_YIELD[leg] for k in used for leg, _ in LEGS[k] if DIV_YIELD.get(leg)},
                   "how": "Each rupee you put in is put into the market on the same day, and each rupee you took out is "
                          "taken out of it on the same day. The market's yearly return on those same flows is compared "
                          "with yours."},
        "by_year": [{"year": y, "put_in": _r(v["put_in"]), "taken_out": _r(v["taken_out"])} for y, v in sorted(years.items())],
        "holdings": holdings,
    }
