"""Markets: the Nifty 200 universe, 1-week / 1-month price signals, movers, holding alerts and rebalance hints.

Signals look only at price movement over the last week and month (as asked), read two ways:
  momentum  — rising over both windows: consider buying; falling over both: consider exiting
  dip       — fell hard over the month but turning up this week: possible entry;
              ran up hard over the month but slipping this week: consider booking profit
They are price signals, not research or advice, and the app says so wherever they appear.
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

UNIVERSE_URL = "https://archives.nseindia.com/content/indices/ind_nifty200list.csv"
UNIVERSE_FILE = os.path.join(os.path.dirname(__file__), "data", "nifty200.csv")
UNIVERSE_TTL_DAYS = 7
HISTORY_DAYS = 70          # enough trading days for a 1-month window plus a little slack
WEEK, MONTH = 5, 21        # trading days

# Thresholds in percent; a signal needs both windows to agree
RULES = {
    "momentum_buy": {"m1": 8.0, "w1": 3.0},
    "momentum_sell": {"m1": -8.0, "w1": -3.0},
    "dip_buy": {"m1": -8.0, "w1": 0.5},
    "profit_book": {"m1": 15.0, "w1": -2.0},
}
SIGNAL_TEXT = {
    "momentum_buy": ("Rising strongly", "Up {m1} this month and {w1} this week"),
    "momentum_sell": ("Falling steadily", "Down {m1} this month and {w1} this week"),
    "dip_buy": ("Bouncing after a fall", "Down {m1} this month, {w1} this week"),
    "profit_book": ("Cooling after a run", "Up {m1} this month, {w1} this week"),
}
DEFAULT_ALERTS = {"enabled": True, "push": True, "day": 5.0, "week": 10.0}


def _pct(v: float | None) -> str:
    return "—" if v is None else f"{v:+.1f}%"


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

    def back(n):
        return series[-1 - n] if len(series) > n else None

    def chg(ref):
        return round((last / ref - 1) * 100, 2) if ref else None

    prev = live.get("prev_close") if live and live.get("prev_close") else back(1)
    rets = [series[i] / series[i - 1] - 1 for i in range(max(1, len(series) - MONTH), len(series)) if series[i - 1]]
    window = series[-(MONTH + 1):]
    return {"price": round(last, 2), "d1": chg(prev), "w1": chg(back(WEEK)), "m1": chg(back(MONTH)),
            "vol": round(statistics.pstdev(rets) * 100, 2) if len(rets) > 5 else None,
            "high_1m": round(max(window), 2), "low_1m": round(min(window), 2),
            "spark": [round(v, 2) for v in series[-(MONTH + 1):]]}


def signals_for(m: dict | None) -> list[str]:
    if not m or m.get("w1") is None or m.get("m1") is None:
        return []
    out = []
    w1, m1 = m["w1"], m["m1"]
    if m1 >= RULES["momentum_buy"]["m1"] and w1 >= RULES["momentum_buy"]["w1"]:
        out.append("momentum_buy")
    if m1 <= RULES["momentum_sell"]["m1"] and w1 <= RULES["momentum_sell"]["w1"]:
        out.append("momentum_sell")
    if m1 <= RULES["dip_buy"]["m1"] and w1 >= RULES["dip_buy"]["w1"]:
        out.append("dip_buy")
    if m1 >= RULES["profit_book"]["m1"] and w1 <= RULES["profit_book"]["w1"]:
        out.append("profit_book")
    return out


def describe(sig: str, m: dict) -> dict:
    title, note = SIGNAL_TEXT[sig]
    return {"signal": sig, "title": title, "note": note.format(m1=_pct(m["m1"]), w1=_pct(m["w1"]))}


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
    segs = [{"segment": s["segment"], "pct": s.get("pct"), "target": s.get("target"), "drift": s.get("drift")}
            for s in port["segments"] if s.get("target") is not None]
    fresh = [i for i in ideas["momentum_buy"] + ideas["dip_buy"] if not i["held"]][:6]
    return {"has_targets": bool(targets), "segments": segs, "trim": trim, "add": add, "new_ideas": fresh}


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
