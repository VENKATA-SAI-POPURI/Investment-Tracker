"""Markets: the Nifty 200 universe, 1-week / 1-month price signals, movers, holding alerts and rebalance hints.

Signals look only at price movement over the last week and month (as asked). The vocabulary (RULES,
SIGNAL_TEXT, `signals_for`, `describe` and the week/month windows) lives in `analytics.signals`, the one
signal model `quant.holding_outlook` also reads (SPEC P2.12, AMENDMENTS K16); this module re-exports it.
They are price patterns, not forecasts or advice, and every described signal carries that label.

`market_state` and `context_line` (SPEC P1.12, AMENDMENTS G12) read the Nifty's stored closes and say whether
the market is in a correction or a crash, how your own fall compares with a stress scenario, and what to do
(nothing hasty). They are pure: no price calls and no database access.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import statistics
from datetime import date, datetime, timedelta, timezone

from . import domain as d
from . import prices as px
from .analytics import signals as sg
# The one signal vocabulary (K16), re-exported so `markets.RULES`, `markets.signals_for` and friends keep working
from .analytics.signals import MONTH, RULES, SIGNAL_TEXT, WEEK, describe, signals_for  # noqa: F401

UNIVERSE_URL = "https://archives.nseindia.com/content/indices/ind_nifty200list.csv"
UNIVERSE_FILE = os.path.join(os.path.dirname(__file__), "data", "nifty200.csv")
UNIVERSE_TTL_DAYS = 7
HISTORY_DAYS = 70          # enough trading days for a 1-month window plus a little slack
DEFAULT_ALERTS = {"enabled": True, "push": True, "day": 5.0, "week": 10.0}


_pct = sg.pct_text


# ── universe ──

def _parse_universe(text: str) -> list[dict]:
    rows = []
    for r in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        sym = (r.get("Symbol") or "").strip().upper()
        if sym:
            rows.append({"symbol": sym, "name": (r.get("Company Name") or sym).strip().removesuffix(" Ltd."),
                         "industry": (r.get("Industry") or "").strip() or None, "isin": (r.get("ISIN Code") or "").strip() or None})
    return rows


def universe(ledger, refresh: bool = False) -> list[dict]:
    """Nifty 200 constituents: NSE's published list, refreshed weekly, with a bundled copy as fallback."""
    raw = ledger.system_value("markets:universe")
    cached = json.loads(raw) if raw else None
    stale = not cached or (datetime.now(timezone.utc) - datetime.fromisoformat(cached["at"])).days >= UNIVERSE_TTL_DAYS
    if refresh or stale:
        try:
            r = px._session.get(UNIVERSE_URL, timeout=20)
            r.raise_for_status()
            rows = _parse_universe(r.text)
            if len(rows) >= 150:
                ledger.set_system_value("markets:universe", json.dumps({"at": datetime.now(timezone.utc).isoformat(), "rows": rows}))
                return rows
        except Exception as e:  # noqa: BLE001 — fall back to what we have
            print(f"[markets] universe refresh failed: {e}")
    if cached:
        return cached["rows"]
    with open(UNIVERSE_FILE, encoding="utf-8") as f:
        return _parse_universe(f.read())


def yahoo_symbol(nse_symbol: str) -> str:
    return f"{nse_symbol}.NS"


# ── metrics ──

def metrics(closes: list[tuple[str, float]], live: dict | None = None) -> dict | None:
    """Last price and 1-day / 1-week / 1-month change from daily closes, optionally overlaid with a live quote."""
    series = [c for _, c in closes if c]
    if live and live.get("price") and series:
        # The quote is either today's price (a new day, or an update to today's partial candle) or, outside
        # trading hours, just the last close again; only a new trading day adds a point
        last_day = closes[-1][0]
        quote_day = live.get("date")
        if quote_day == last_day or (not quote_day and abs(live["price"] - series[-1]) < 1e-9):
            series[-1] = live["price"]
        elif not quote_day or quote_day > last_day:
            series.append(live["price"])
    if len(series) < 2:
        return None
    last = series[-1]

    def chg(ref):
        return round((last / ref - 1) * 100, 2) if ref else None

    prev = live.get("prev_close") if live and live.get("prev_close") else series[-2]
    rets = [series[i] / series[i - 1] - 1 for i in range(max(1, len(series) - MONTH), len(series)) if series[i - 1]]
    window = series[-(MONTH + 1):]
    win = sg.windows(series)    # w1 and m1 by the one signal model's rule (K16)
    return {"price": round(last, 2), "d1": chg(prev), "w1": win["w1"], "m1": win["m1"],
            "vol": round(statistics.pstdev(rets) * 100, 2) if len(rets) > 5 else None,
            "high_1m": round(max(window), 2), "low_1m": round(min(window), 2),
            "spark": [round(v, 2) for v in series[-(MONTH + 1):]]}


def _score(sig: str, m: dict) -> float:
    w1, m1 = m["w1"] or 0, m["m1"] or 0
    return {"momentum_buy": m1 + 0.5 * w1, "momentum_sell": -(m1 + 0.5 * w1),
            "dip_buy": -m1 + w1, "profit_book": m1 - w1}[sig]


# ── market data for a set of symbols ──

def load_market(ledger, symbols: list[str], live_symbols: list[str] = (), max_age_hours: float = 6) -> dict[str, dict]:
    """{yahoo symbol: metrics}; `live_symbols` also get a fresh quote (holdings and watchlist)."""
    start = date.today() - timedelta(days=HISTORY_DAYS * 7 // 5 + 10)
    wanted = set(symbols) | set(live_symbols)
    # Yahoo quotes REITs / InvITs under NAME-RR.NS but keeps their daily history under NAME.NS
    alias = {sym: re.sub(r"-(RR|IV)\.", ".", sym) for sym in wanted if re.search(r"-(RR|IV)\.", sym)}
    hist = px.ensure_history(ledger.db, sorted(wanted | set(alias.values())), start, max_age_hours=max_age_hours)
    for sym, base in alias.items():
        if len(hist.get(sym) or []) < 10:
            hist[sym] = hist.get(base) or hist.get(sym) or []
        if base not in wanted:
            hist.pop(base, None)
    quotes = px.fetch_quotes(sorted(set(live_symbols))) if live_symbols else {}
    out = {}
    for sym, closes in hist.items():
        m = metrics(closes, quotes.get(sym))
        if m:
            out[sym] = m
    return out


# ── holdings, watchlist and ideas ──

def tracked_holdings(port: dict) -> list[dict]:
    """Indian stocks and ETFs held now, with a Yahoo symbol to price them."""
    return [p for p in port["positions"] if p.get("is_open") and p["asset_class"] in (d.EQUITY, d.COMMODITY)
            and (p.get("market") or "India") == "India" and p.get("symbol") and not px.is_amfi(p["symbol"])]


def build_overview(ledger, port: dict, watch: list[dict], settings: dict, targets: dict | None = None) -> dict:
    uni = universe(ledger)
    by_yahoo = {yahoo_symbol(u["symbol"]): u for u in uni}
    holds = tracked_holdings(port)
    live = sorted({p["symbol"] for p in holds} | {w["symbol"] for w in watch})
    data = load_market(ledger, list(by_yahoo), live)
    held_syms = {p["symbol"] for p in holds}
    watch_syms = {w["symbol"] for w in watch}
    total = sum(float(p["value"] or 0) for p in port["positions"] if p.get("is_open")) or 1

    holdings = []
    for p in sorted(holds, key=lambda p: -float(p["value"] or 0)):
        m = data.get(p["symbol"])
        holdings.append({"id": p["id"], "name": p["name"], "symbol": p["symbol"], "segment": p["segment"],
                         "value": p["value"], "weight": round(float(p["value"] or 0) / total * 100, 2),
                         "gain_pct": p.get("unrealized_pct"), "quantity": p.get("quantity"), "metrics": m,
                         "signals": [describe(s, m) for s in signals_for(m)]})

    watchlist = []
    for w in watch:
        m = data.get(w["symbol"])
        price = m["price"] if m else None
        hit = None
        if price and w.get("target_buy") and price <= w["target_buy"]:
            hit = "buy"
        elif price and w.get("target_sell") and price >= w["target_sell"]:
            hit = "sell"
        since = round((price / w["added_price"] - 1) * 100, 2) if price and w.get("added_price") else None
        info = by_yahoo.get(w["symbol"]) or {}
        watchlist.append({**w, "industry": info.get("industry"), "metrics": m, "target_hit": hit, "since_added": since,
                          "held": w["symbol"] in held_syms, "signals": [describe(s, m) for s in signals_for(m)]})

    ideas = {k: [] for k in RULES}
    rows = []
    for sym, u in by_yahoo.items():
        m = data.get(sym)
        if not m:
            continue
        rows.append((sym, u, m))
        for s in signals_for(m):
            ideas[s].append({"symbol": sym, "name": u["name"], "industry": u["industry"], "metrics": m,
                             "held": sym in held_syms, "watching": sym in watch_syms, **describe(s, m), "score": _score(s, m)})
    for k in ideas:
        ideas[k] = sorted(ideas[k], key=lambda r: -r["score"])[:12]

    def movers(field, n=6):
        valid = [(s, u, m) for s, u, m in rows if m.get(field) is not None]
        pick = lambda seq: [{"symbol": s, "name": u["name"], "industry": u["industry"], "metrics": m, "held": s in held_syms}  # noqa: E731
                            for s, u, m in seq[:n]]
        valid.sort(key=lambda r: -r[2][field])
        return {"up": pick(valid), "down": pick(valid[::-1])}

    sectors = {}
    for _, u, m in rows:
        if u["industry"] and m.get("w1") is not None and m.get("m1") is not None:
            sectors.setdefault(u["industry"], []).append(m)
    sector_rows = sorted(({"industry": k, "count": len(v), "w1": round(statistics.mean(x["w1"] for x in v), 2),
                           "m1": round(statistics.mean(x["m1"] for x in v), 2)} for k, v in sectors.items() if len(v) >= 3),
                         key=lambda r: -r["m1"])
    breadth = {"up": sum(1 for _, _, m in rows if (m.get("d1") or 0) > 0), "down": sum(1 for _, _, m in rows if (m.get("d1") or 0) < 0),
               "total": len(rows)}
    index = load_market(ledger, [px.BENCHMARKS["NIFTY50"]["symbol"]], [px.BENCHMARKS["NIFTY50"]["symbol"]]).get(px.BENCHMARKS["NIFTY50"]["symbol"])
    return {"as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"), "universe": "Nifty 200", "universe_size": len(uni),
            "covered": len(rows), "index": {"name": "Nifty 50", "metrics": index}, "breadth": breadth,
            "holdings": holdings, "watchlist": watchlist, "ideas": ideas, "movers": {"day": movers("d1"), "week": movers("w1")},
            "sectors": sector_rows, "rebalance": rebalance_hints(port, holdings, ideas, targets or {}),
            "alerts_config": {**DEFAULT_ALERTS, **(settings.get("marketAlerts") or {})}, "rules": RULES}


def rebalance_hints(port: dict, holdings: list[dict], ideas: dict, targets: dict) -> dict:
    """Where the price signals and the target allocation point the same way."""
    drift = {s["segment"]: s.get("drift") for s in port["segments"]}
    trim, add = [], []
    for h in holdings:
        sigs = {s["signal"] for s in h["signals"]}
        over = (drift.get(h["segment"]) or 0) >= 2.5
        under = (drift.get(h["segment"]) or 0) <= -2.5
        if sigs & {"momentum_sell", "profit_book"}:
            trim.append({**h, "why": ("Price signal says ease off" + (f"; {h['segment']} is {drift[h['segment']]:+.1f} pts over target" if over else ""))})
        elif sigs & {"momentum_buy", "dip_buy"}:
            add.append({**h, "why": ("Price signal favours adding" + (f"; {h['segment']} is {drift[h['segment']]:+.1f} pts under target" if under else ""))})
    segs = [{"segment": s["segment"], "pct": s.get("mix_pct"), "target": s.get("target"), "drift": s.get("drift")}
            for s in port["segments"] if s.get("target") is not None]
    fresh = [i for i in ideas["momentum_buy"] + ideas["dip_buy"] if not i["held"]][:6]
    return {"has_targets": bool(targets), "segments": segs, "trim": trim, "add": add, "new_ideas": fresh}


# ── market state: crash and correction context (SPEC P1.12, AMENDMENTS G12) ──

STATE_MIN_CLOSES = 200      # fewer closes than this and there is no market state (D6)
STATE_MAX_AGE_DAYS = 5      # newest close older than this (calendar days before `today`): no state (W4 review)
YEAR_CLOSES = 252           # the 52-week high is the highest of the last 252 closes
CRASH_FROM_HIGH = -20.0     # percent below the 52-week high
CRASH_W1 = -8.0             # or a fall this big in one week
CORRECTION_FROM_HIGH = -10.0
VOLATILE_D1 = 2.5           # |one-day move| in percent
FALLBACK_SCENARIO = "correction"
FALLBACK_LABEL = "Market correction"
FALLBACK_IMPACT_PCT = -10.0  # the correction scenario's Indian-equity shock, used only when no stress test is at hand

PLAYBOOK = [
    "Keep your SIPs running. A fall buys more units for the same money.",
    "Don't sell to stop the fall. A paper loss becomes a real one only when you sell.",
    "Check that your emergency fund covers six months, so nothing has to be sold in a hurry.",
    "If equity is now well under your target, top it up with new money. Don't try to time the bottom.",
    "Look again next quarter, not every day.",
]


def _point(p) -> tuple[str, float] | None:
    """A close as (ISO date, price) from a (date, close) pair or a {date, close|value|price} dict."""
    if isinstance(p, dict):
        day, close = p.get("date"), p.get("close", p.get("value", p.get("price")))
    else:
        try:
            day, close = p[0], p[1]
        except (TypeError, IndexError, KeyError):
            return None
    try:
        close = float(close)
    except (TypeError, ValueError):
        return None
    if not day or close <= 0:
        return None
    return (day.isoformat() if isinstance(day, date) else str(day)[:10], close)


def _comparable(stress: dict | None, dd_pct: float) -> dict:
    """The mildest falling scenario whose impact_pct is at or beyond your drawdown, else the correction one."""
    scenarios = [s for s in ((stress or {}).get("scenarios") or []) if isinstance(s, dict)]
    falls = [s for s in scenarios if s.get("impact_pct") is not None and float(s["impact_pct"]) < 0
             and float(s["impact_pct"]) <= dd_pct]
    pick = max(falls, key=lambda s: float(s["impact_pct"])) if falls else None   # max() keeps the first on a tie
    if pick is None:
        pick = next((s for s in scenarios if s.get("key") == FALLBACK_SCENARIO), None)
    if pick is None:
        # No stress test (or one without a correction row): a stand-in that names the routine correction
        return {"key": FALLBACK_SCENARIO, "label": FALLBACK_LABEL, "impact": None, "impact_pct": None,
                "smaller": dd_pct > FALLBACK_IMPACT_PCT}
    impact_pct = float(pick["impact_pct"]) if pick.get("impact_pct") is not None else None
    return {"key": pick.get("key"), "label": pick.get("label") or FALLBACK_LABEL, "impact": pick.get("impact"),
            "impact_pct": impact_pct,
            "smaller": dd_pct > (impact_pct if impact_pct is not None else FALLBACK_IMPACT_PCT)}


def market_state(nifty_points, perf_metrics: dict | None, stress: dict | None, today: date | str | None = None) -> dict | None:
    """Where the Nifty stands against its 52-week high, and how your own fall compares. Pure: no price calls.

    nifty_points  stored ^NSEI daily closes, as (date, close) pairs or {date, close} dicts, in any order
    perf_metrics  history metrics (`current_drawdown` in percent, TWR-based, and `end_value`), or None
    stress        `forecast.stress_test` output {scenarios: [{key, label, impact, impact_pct}]}, or None
    today         closes dated after it are ignored (defaults to the real today)

    Returns None with fewer than 200 usable closes (D6), or when the newest close is more than
    STATE_MAX_AGE_DAYS calendar days before `today`: the payload speaks in the present tense ("Nifty is X% below
    its high"), and ^NSEI closes are stored only when performance, risk or Markets last ran (W4 review). Otherwise
      {mode: 'crash'|'correction'|'volatile'|'normal',
       nifty: {price, d1, w1, from_high_pct, high, high_date},       percentages, 2 dp
       you: {from_peak_pct, from_peak_inr},                          both None without metrics
       comparable: {key, label, impact, impact_pct, smaller} | None, None when your drawdown is unknown
       playbook: [str],                                              fixed calm lines in correction/crash, else []
       since,                                                        the 52-week high's date in correction/crash,
                                                                     else the last close's date
       as_of}                                                        the last close's date
    Mode is checked in order: crash (from_high ≤ −20 or w1 ≤ −8), correction (from_high ≤ −10),
    volatile (|d1| ≥ 2.5), normal. The thresholds apply to the rounded figures the payload shows.
    """
    cutoff = (today.isoformat() if isinstance(today, date) else str(today)[:10]) if today else date.today().isoformat()
    by_day: dict[str, float] = {}
    for p in nifty_points or []:
        pt = _point(p)
        if pt and pt[0] <= cutoff:
            by_day[pt[0]] = pt[1]          # one close per day; a later duplicate wins
    closes = sorted(by_day.items())
    if len(closes) < STATE_MIN_CLOSES:
        return None

    last_day, last = closes[-1]
    try:
        age = (date.fromisoformat(cutoff) - date.fromisoformat(last_day)).days
    except ValueError:
        return None
    if age > STATE_MAX_AGE_DAYS:
        return None
    prev = closes[-2][1]
    week = closes[-1 - WEEK][1]
    year = closes[-YEAR_CLOSES:]
    high = max(c for _, c in year)
    high_day = max(day for day, c in year if c == high)     # the latest day the high was set
    d1 = round((last / prev - 1) * 100, 2)
    w1 = round((last / week - 1) * 100, 2)
    from_high = round((last / high - 1) * 100, 2)

    if from_high <= CRASH_FROM_HIGH or w1 <= CRASH_W1:
        mode = "crash"
    elif from_high <= CORRECTION_FROM_HIGH:
        mode = "correction"
    elif abs(d1) >= VOLATILE_D1:
        mode = "volatile"
    else:
        mode = "normal"
    falling = mode in ("crash", "correction")

    dd = (perf_metrics or {}).get("current_drawdown")
    dd = float(dd) if dd is not None else None
    end_value = (perf_metrics or {}).get("end_value")
    inr = None
    if dd is not None and end_value is not None and abs(dd) < 100:
        frac = abs(dd) / 100
        inr = round(-float(end_value) * frac / (1 - frac), 2) + 0.0     # + 0.0 turns −0.0 into 0.0
    you = {"from_peak_pct": dd, "from_peak_inr": inr}

    return {"mode": mode,
            "nifty": {"price": round(last, 2), "d1": d1, "w1": w1, "from_high_pct": from_high,
                      "high": round(high, 2), "high_date": high_day},
            "you": you,
            "comparable": _comparable(stress, dd) if dd is not None else None,
            "playbook": list(PLAYBOOK) if falling else [],
            "since": high_day if falling else last_day,
            "as_of": last_day}


def _inr_compact(v: float) -> str:
    """Rupees for a sentence: ₹1.23 Cr, ₹3.4 L, else the full Indian grouping (₹45,000)."""
    a = abs(v)
    sign = "-" if v < 0 else ""
    if a >= 1e7:
        return f"{sign}₹{a / 1e7:.2f} Cr"
    if a >= 1e5:
        return f"{sign}₹{a / 1e5:.1f} L"
    s = str(round(a))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        s = ",".join(([head] if head else []) + groups) + "," + tail
    return f"{sign}₹{s}"


def _scenario_phrase(comp: dict) -> str:
    return "the routine-correction scenario" if comp.get("key") == FALLBACK_SCENARIO else f"the {comp.get('label')} scenario"


def context_line(state: dict | None) -> dict | None:
    """Home's crash/correction context line (SPEC §4.1, priority 1), or None outside correction and crash:
    "Nifty is 12% below its high. You're down ₹3.4 L from your peak — smaller than the routine-correction
    scenario. Your SIPs are the plan; nothing needs selling." The link opens the Markets banner and its playbook."""
    if not state or state.get("mode") not in ("crash", "correction"):
        return None
    nifty = state.get("nifty") or {}
    from_high = abs(float(nifty.get("from_high_pct") or 0))
    w1 = nifty.get("w1")
    parts = [f"Nifty is {from_high:.0f}% below its high"]
    if state["mode"] == "crash" and w1 is not None and w1 <= CRASH_W1:
        parts[0] += f", after a {abs(w1):.0f}% fall this week"
    parts[0] += "."
    you, comp = state.get("you") or {}, state.get("comparable")
    dd, inr = you.get("from_peak_pct"), you.get("from_peak_inr")
    if dd is not None and dd >= 0:
        parts.append("Your portfolio is at its peak.")
    elif inr is not None and comp:
        if comp.get("smaller"):
            how = "smaller than"
        elif comp.get("impact_pct") is not None and abs(float(dd) - comp["impact_pct"]) < 1:
            how = "about the size of"
        else:
            how = "deeper than"
        parts.append(f"You're down {_inr_compact(abs(inr))} from your peak — {how} {_scenario_phrase(comp)}.")
    elif dd is not None:
        parts.append(f"You're {abs(dd):.0f}% below your peak.")
    parts.append("Your SIPs are the plan; nothing needs selling.")
    return {"kind": "market", "text": " ".join(parts), "link": "/markets"}


# ── alerts ──

def holding_alerts(holdings: list[dict], watchlist: list[dict], cfg: dict, today: str | None = None) -> list[dict]:
    """Drastic moves on holdings and watchlist targets reached, each keyed so it fires once per day."""
    today = today or date.today().isoformat()
    out = []
    for h in holdings:
        m = h.get("metrics")
        if not m:
            continue
        if m.get("d1") is not None and abs(m["d1"]) >= cfg["day"]:
            up = m["d1"] > 0
            out.append({"key": f"day:{h['symbol']}:{today}", "kind": "move", "symbol": h["symbol"],
                        "severity": "info" if up else "warning",
                        "title": f"{h['name']} {'up' if up else 'down'} {abs(m['d1']):.1f}% today",
                        "body": f"Now ₹{m['price']:,.2f}; {_pct(m['w1'])} this week, {_pct(m['m1'])} this month.",
                        "link": f"/holding/{h['id']}"})
        if m.get("w1") is not None and abs(m["w1"]) >= cfg["week"]:
            up = m["w1"] > 0
            week = date.fromisoformat(today).isocalendar()
            out.append({"key": f"week:{h['symbol']}:{week[0]}-{week[1]}", "kind": "move", "symbol": h["symbol"],
                        "severity": "info" if up else "warning",
                        "title": f"{h['name']} {'up' if up else 'down'} {abs(m['w1']):.1f}% this week",
                        "body": f"Now ₹{m['price']:,.2f}; {_pct(m['m1'])} over the month.", "link": f"/holding/{h['id']}"})
    for w in watchlist:
        m = w.get("metrics")
        if w.get("target_hit") and m:
            buy = w["target_hit"] == "buy"
            target = w["target_buy"] if buy else w["target_sell"]
            out.append({"key": f"target:{w['symbol']}:{w['target_hit']}:{target}", "kind": "target", "symbol": w["symbol"],
                        "severity": "info", "title": f"{w['name']} reached your {'buy' if buy else 'sell'} price",
                        "body": f"Now ₹{m['price']:,.2f} (your {'buy' if buy else 'sell'} price ₹{target:,.2f}).", "link": "/markets?tab=watchlist"})
    return out
