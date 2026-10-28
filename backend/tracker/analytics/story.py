"""Narrative analysis for the overview: what drove returns, how the same money would have done in the
market, how steadily money is invested, and when the next lakh/crore milestone arrives."""
from __future__ import annotations

from collections import defaultdict
from datetime import date

from .. import domain as d
from .goals import ASSUMPTIONS
from .insights import _inr

MILESTONES = [1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8]
PRIMARY_BENCH = "NIFTY50"


def lakh_label(v: float) -> str:
    """₹5 lakh, ₹2.5 crore — the way milestones are spoken of in India."""
    if v >= 1e7:
        return f"₹{v / 1e7:g} crore"
    return f"₹{v / 1e5:g} lakh"


def _month_keys(today: date, n: int) -> list[str]:
    keys, y, m = [], today.year, today.month
    for _ in range(n):
        keys.append(f"{y}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return keys[::-1]


def _duration(months: int) -> str:
    y, m = divmod(months, 12)
    parts = ([f"{y} yr" + ("s" if y > 1 else "")] if y else []) + ([f"{m} mo"] if m else [])
    return " ".join(parts) or "this month"


# ── what drove returns ──
def attribution(port: dict, n: int = 5) -> dict:
    rows = [{"id": p["id"], "name": p["name"], "segment": p["segment"], "gain": round(float(p["total_return"] or 0), 2),
             "is_open": bool(p.get("is_open"))}
            for p in port["positions"] if abs(float(p["total_return"] or 0)) >= 1]
    gainers = sorted((r for r in rows if r["gain"] > 0), key=lambda r: -r["gain"])
    losers = sorted((r for r in rows if r["gain"] < 0), key=lambda r: r["gain"])
    seg = [{"segment": s["segment"], "gain": round(float(s["total_return"] or 0), 2)} for s in port["segments"]
           if abs(float(s["total_return"] or 0)) >= 1]
    t = port["totals"]
    return {"total": t["total_gain"], "unrealized": t["unrealized"], "realized": t["realized"], "income": t["income"],
            "gross_gains": round(sum(r["gain"] for r in gainers), 2), "gross_losses": round(sum(r["gain"] for r in losers), 2),
            "gainers": gainers[:n], "losers": losers[:n], "segments": sorted(seg, key=lambda s: -s["gain"]),
            "winners": len(gainers), "losers_count": len(losers)}


# ── same cash flows in the market ──
def market_compare(port: dict, perf: dict | None) -> dict | None:
    if not perf or not perf.get("benchmarks"):
        return None
    m = perf.get("metrics") or {}
    you = m.get("xirr")
    rows = [{"key": b["key"], "label": b["label"], "xirr": b["xirr"], "end_value": b["end_value"],
             "diff_value": round(float(port["totals"]["value"]) - b["end_value"], 2), "excess": b["excess_xirr"]}
            for b in perf["benchmarks"] if b.get("xirr") is not None]
    if not rows:
        return None
    return {"you": you, "value": port["totals"]["value"], "since": m.get("start"), "rows": rows}


# ── how steadily money goes in ──
def investing_rhythm(txns: list[dict], today: date | None = None, months: int = 12) -> dict:
    today = today or date.today()
    inv, out = defaultdict(float), defaultdict(float)
    for t in txns:
        k, amt = str(t["date"])[:7], float(t["amount"] or 0)
        if t["type"] == d.BUY:
            inv[k] += amt
        elif t["type"] in (d.SELL, d.MATURITY):
            out[k] += amt if t["type"] == d.SELL else float(t["principal"] or amt)
        elif t["type"] == d.REPAYMENT:
            out[k] += float(t["principal"] or 0)
    keys = _month_keys(today, months)
    rows = [{"month": k, "invested": round(inv[k], 2), "withdrawn": round(out[k], 2), "net": round(inv[k] - out[k], 2)}
            for k in keys]
    active = sum(1 for r in rows if r["invested"] > 0)
    # Streak counts back from the latest month with a purchase (the current month may still be under way)
    streak, seq = 0, rows[::-1]
    if seq and seq[0]["invested"] <= 0:
        seq = seq[1:]
    for r in seq:
        if r["invested"] <= 0:
            break
        streak += 1
    net = sum(r["net"] for r in rows)
    # A typical recent month (median of the last six) resists one-off lump sums better than the mean
    recent = sorted(r["net"] for r in rows[-6:])
    mid = len(recent) // 2
    pace = (recent[mid] if len(recent) % 2 else (recent[mid - 1] + recent[mid]) / 2) if recent else 0.0
    return {"months": rows, "active_months": active, "streak": streak, "invested": round(sum(inv[k] for k in keys), 2),
            "net": round(net, 2), "monthly_avg": round(max(net, 0) / months, 2), "pace": round(max(pace, 0), 2)}


# ── lakh / crore milestones ──
def expected_return(port: dict) -> float:
    segs = [s for s in port["segments"] if s["value"] > 0]
    total = sum(s["value"] for s in segs)
    if not total:
        return 0.10
    return sum(ASSUMPTIONS.get(s["segment"], (0.10, 0.12))[0] * s["value"] for s in segs) / total


def _months_to(pv: float, pmt: float, target: float, annual: float, cap: int = 600) -> int | None:
    rm = (1 + annual) ** (1 / 12) - 1
    v, n = pv, 0
    while v < target:
        if n >= cap:
            return None
        v = v * (1 + rm) + pmt
        n += 1
    return n


def milestones(port: dict, monthly: float, today: date | None = None) -> dict:
    today = today or date.today()
    value = float(port["totals"]["value"] or 0)
    mu = expected_return(port)
    reached = [m for m in MILESTONES if m <= value]
    ahead = [m for m in MILESTONES if m > value][:4]
    if 1e7 > value and 1e7 not in ahead:
        ahead.append(1e7)

    def row(m):
        n = _months_to(value, monthly, m, mu)
        when = None
        if n is not None:
            y, mo = divmod(today.month - 1 + n, 12)
            when = f"{today.year + y}-{mo + 1:02d}"
        return {"amount": m, "label": lakh_label(m), "months": n, "when": when, "in": _duration(n) if n is not None else None}

    prev = reached[-1] if reached else 0
    nxt = ahead[0] if ahead else None
    return {"value": value, "monthly": round(monthly, 2), "assumed_return": round(mu * 100, 1),
            "last_reached": {"amount": prev, "label": lakh_label(prev)} if prev else None,
            "progress": round((value - prev) / (nxt - prev) * 100, 1) if nxt else 100.0,
            "ahead": [row(m) for m in ahead]}


# ── four headline takeaways ──
def takeaways(port: dict, attr: dict, market: dict | None, rhythm: dict, miles: dict) -> list[dict]:
    out = []
    if market:
        b = next((r for r in market["rows"] if r["key"] == PRIMARY_BENCH), market["rows"][0])
        ahead = b["diff_value"] >= 0
        out.append({"key": "market", "icon": "trend", "tone": "pos" if ahead else "neg", "label": f"You vs {b['label']}",
                    "value": (f"{_inr(b['diff_value'])} ahead" if ahead else f"{_inr(-b['diff_value'])} behind"),
                    "note": f"The same money, invested on the same dates in {b['label']}, would be worth {_inr(b['end_value'])} today.",
                    "link": "/analytics"})
    if attr["gainers"]:
        g = attr["gainers"][0]
        share = g["gain"] / attr["gross_gains"] * 100 if attr["gross_gains"] else 0
        out.append({"key": "driver", "icon": "sparkle", "tone": "pos", "label": "Biggest driver", "value": g["name"],
                    "note": f"Added {_inr(g['gain'])} — {share:.0f}% of all gains across {attr['winners']} winning holdings.",
                    "link": f"/holding/{g['id']}"})
    if attr["losers"]:
        l = attr["losers"][0]
        out.append({"key": "drag", "icon": "arrowDown", "tone": "neg", "label": "Biggest drag", "value": l["name"],
                    "note": f"Down {_inr(-l['gain'])} so far; {attr['losers_count']} holdings are in the red in total.",
                    "link": f"/holding/{l['id']}"})
    out.append({"key": "rhythm", "icon": "calendar", "tone": "pos" if rhythm["active_months"] >= 9 else "neutral",
                "label": "Investing rhythm", "value": f"{rhythm['active_months']} of 12 months",
                "note": (f"{_inr(rhythm['net'])} of fresh money in the last year; a typical month lately adds {_inr(rhythm['pace'])}"
                         + (f" ({rhythm['streak']}-month streak)." if rhythm["streak"] > 1 else ".")),
                "link": "/transactions"})
    if miles["ahead"]:
        m = miles["ahead"][0]
        out.append({"key": "milestone", "icon": "target", "tone": "neutral", "label": "Next milestone", "value": m["label"],
                    "note": (f"In about {m['in']} adding {_inr(miles['monthly'])} a month at an assumed {miles['assumed_return']:g}% a year."
                             if m["in"] else "Out of reach at today's pace — a monthly SIP would bring it closer."),
                    "link": "/goals"})
    return out


def build_story(port: dict, txns: list[dict], perf: dict | None, today: date | None = None) -> dict:
    attr = attribution(port)
    market = market_compare(port, perf)
    rhythm = investing_rhythm(txns, today)
    miles = milestones(port, rhythm["pace"], today)
    return {"takeaways": takeaways(port, attr, market, rhythm, miles), "attribution": attr, "market": market,
            "rhythm": rhythm, "milestones": miles}
