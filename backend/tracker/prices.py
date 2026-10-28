"""Market data: Yahoo Finance (stocks, ETFs, MFs, FX, indices) and AMFI via mfapi.in (Indian MF NAVs).

Symbols for AMFI are stored as 'AMFI:<scheme code>'. Daily closes are cached in price_history so
history/benchmark analytics only fetch what is missing.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import requests

from .db import Database

USDINR = "USDINR=X"
BENCHMARKS = {
    "NIFTY50": {"symbol": "^NSEI", "label": "Nifty 50", "currency": "INR"},
    "NIFTY500": {"symbol": "^CRSLDX", "label": "Nifty 500", "currency": "INR"},
    "SP500": {"symbol": "^GSPC", "label": "S&P 500 (in ₹)", "currency": "USD"},
    "GOLD": {"symbol": "GOLDBEES.NS", "label": "Gold (GOLDBEES)", "currency": "INR"},
}

_session = requests.Session()
_session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InvestmentTracker/2.0"})
_adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20)
_session.mount("https://", _adapter)


def _get_json(url: str, timeout: int = 10):
    r = _session.get(url, timeout=timeout)
    r.raise_for_status()
    return r.json()


def is_amfi(symbol: str) -> bool:
    return symbol.upper().startswith("AMFI:")


# ── Latest quotes ──

def _yahoo_quote(symbol: str) -> dict | None:
    j = _get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(symbol)}?interval=1d&range=5d")
    res = (j.get("chart") or {}).get("result") or []
    if not res:
        return None
    meta = res[0].get("meta", {})
    closes = [c for c in ((res[0].get("indicators") or {}).get("quote") or [{}])[0].get("close") or [] if c is not None]
    price = meta.get("regularMarketPrice") or (closes[-1] if closes else None)
    if price is None:
        return None
    prev = closes[-2] if len(closes) >= 2 else meta.get("chartPreviousClose")
    return {"price": float(price), "prev_close": float(prev) if prev else None, "currency": meta.get("currency")}


def _amfi_quote(symbol: str) -> dict | None:
    code = symbol.split(":", 1)[1]
    data = (_get_json(f"https://api.mfapi.in/mf/{code}").get("data") or [])[:2]
    if not data:
        return None
    price = float(data[0]["nav"])
    prev = float(data[1]["nav"]) if len(data) > 1 else None
    return {"price": price, "prev_close": prev, "currency": "INR"}


def fetch_quotes(symbols: list[str], timeout: float = 15) -> dict[str, dict | None]:
    symbols = sorted(set(s for s in symbols if s))
    if not symbols:
        return {}

    def one(sym):
        try:
            return sym, (_amfi_quote(sym) if is_amfi(sym) else _yahoo_quote(sym))
        except Exception as e:  # noqa: BLE001 — a bad symbol must not fail the batch
            print(f"[prices] {sym}: {e}")
            return sym, None

    out: dict[str, dict | None] = {s: None for s in symbols}
    with ThreadPoolExecutor(max_workers=min(len(symbols), 16)) as ex:
        for fut in [ex.submit(one, s) for s in symbols]:
            try:
                sym, q = fut.result(timeout=timeout)
                out[sym] = q
            except Exception:  # noqa: BLE001
                pass
    return out


# ── Daily history (cached) ──

def _yahoo_history(symbol: str, start: date) -> list[tuple[str, float]]:
    p1 = int(datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp())
    p2 = int(time.time()) + 86400
    j = _get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(symbol)}"
                  f"?interval=1d&period1={p1}&period2={p2}", timeout=20)
    res = (j.get("chart") or {}).get("result") or []
    if not res:
        return []
    ts = res[0].get("timestamp") or []
    closes = ((res[0].get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    gmt = (res[0].get("meta") or {}).get("gmtoffset") or 0
    out = {}
    for t, c in zip(ts, closes):
        if c is not None:
            out[datetime.fromtimestamp(t + gmt, tz=timezone.utc).date().isoformat()] = float(c)
    return sorted(out.items())


def _amfi_history(symbol: str, start: date) -> list[tuple[str, float]]:
    code = symbol.split(":", 1)[1]
    data = _get_json(f"https://api.mfapi.in/mf/{code}", timeout=20).get("data") or []
    out = []
    for row in data:
        dd, mm, yy = row["date"].split("-")
        iso = f"{yy}-{mm}-{dd}"
        if iso >= start.isoformat():
            out.append((iso, float(row["nav"])))
    return sorted(out)


def ensure_history(db: Database, symbols: list[str], start: date, max_age_hours: float = 12) -> dict[str, list[tuple[str, float]]]:
    """Return {symbol: [(iso_date, close), ...]} from start, fetching only stale/missing ranges."""
    symbols = sorted(set(s for s in symbols if s))
    if not symbols:
        return {}
    ph = ",".join("?" * len(symbols))
    meta = {m["symbol"]: m for m in db.query(f"SELECT * FROM price_meta WHERE symbol IN ({ph})", symbols)}
    now = datetime.now(timezone.utc)
    to_fetch = []
    for s in symbols:
        m = meta.get(s)
        fresh = m and m["fetched_at"] and (now - datetime.fromisoformat(m["fetched_at"])).total_seconds() < max_age_hours * 3600
        covers = m and m["first_date"] and m["first_date"] <= (start + timedelta(days=7)).isoformat()
        if not (fresh and covers):
            fetch_from = start if not covers else date.fromisoformat(m["last_date"]) - timedelta(days=7)
            to_fetch.append((s, min(fetch_from, start) if not covers else fetch_from))

    def one(item):
        sym, frm = item
        try:
            return sym, frm, (_amfi_history(sym, frm) if is_amfi(sym) else _yahoo_history(sym, frm))
        except Exception as e:  # noqa: BLE001
            print(f"[history] {sym}: {e}")
            return sym, frm, None

    if to_fetch:
        with ThreadPoolExecutor(max_workers=min(len(to_fetch), 12)) as ex:
            results = list(ex.map(one, to_fetch))
        stmts = []
        stamp = now.strftime("%Y-%m-%dT%H:%M:%S+00:00")
        for sym, frm, rows in results:
            if rows is None:
                continue
            for i in range(0, len(rows), 200):
                part = rows[i:i + 200]
                stmts.append(("INSERT OR REPLACE INTO price_history (symbol, date, close) VALUES "
                              + ",".join(["(?,?,?)"] * len(part)), [v for dt, c in part for v in (sym, dt, c)]))
            old = meta.get(sym) or {}
            first = min([x for x in (old.get("first_date"), rows[0][0] if rows else None, frm.isoformat()) if x])
            last = max([x for x in (old.get("last_date"), rows[-1][0] if rows else None) if x] or [frm.isoformat()])
            stmts.append(("INSERT OR REPLACE INTO price_meta (symbol, fetched_at, first_date, last_date) VALUES (?,?,?,?)",
                          (sym, stamp, first, last)))
        if stmts:
            db.batch(stmts)

    rows = db.query(f"SELECT symbol, date, close FROM price_history WHERE symbol IN ({ph}) AND date >= ? ORDER BY date",
                    symbols + [start.isoformat()])
    out: dict[str, list[tuple[str, float]]] = {s: [] for s in symbols}
    for r in rows:
        out[r["symbol"]].append((r["date"], r["close"]))
    return out


# ── Symbol search ──

def search_symbols(query: str, asset_class: str | None = None) -> list[dict]:
    q = query.strip()
    if len(q) < 2:
        return []
    results: list[dict] = []
    if asset_class in (None, "mutual_fund"):
        try:
            for m in _get_json(f"https://api.mfapi.in/mf/search?q={requests.utils.quote(q)}")[:15]:
                results.append({"symbol": f"AMFI:{m['schemeCode']}", "name": m["schemeName"],
                                "exchange": "AMFI", "type": "Mutual fund", "source": "amfi"})
        except Exception as e:  # noqa: BLE001
            print(f"[search] amfi: {e}")
    if asset_class != "mutual_fund" or not results:
        try:
            j = _get_json(f"https://query1.finance.yahoo.com/v1/finance/search?q={requests.utils.quote(q)}"
                          f"&quotesCount=12&newsCount=0")
            for m in j.get("quotes", []):
                if not m.get("symbol"):
                    continue
                results.append({"symbol": m["symbol"], "name": m.get("longname") or m.get("shortname") or m["symbol"],
                                "exchange": m.get("exchDisp") or m.get("exchange"), "type": m.get("typeDisp"),
                                "source": "yahoo"})
        except Exception as e:  # noqa: BLE001
            print(f"[search] yahoo: {e}")
    return results
