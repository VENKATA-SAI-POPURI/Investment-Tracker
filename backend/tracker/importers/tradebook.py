"""Zerodha (Kite / Console) equity tradebook, as .xlsx or .csv, reconciled against the ledger.

The tradebook lists every fill, so it is the authority for the period it covers. The app may hold the
same trades as one row per day, or (from the original app) as one combined row spanning several days;
the reconciler matches what it can, splits combined rows when their totals agree exactly, and leaves
anything it cannot explain for the user to decide. Amounts are quantity × price, without charges, which
is how trades are recorded in the app."""
from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from datetime import date, datetime

from .. import domain as d

QTY_EPS, AMT_EPS, SUM_EPS = 1e-6, 0.05, 0.5
REQUIRED = {"symbol", "trade_date", "trade_type", "quantity", "price"}


class TradebookError(ValueError):
    pass


def _key(h) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(h or "").strip().lower()).strip("_")


def _num(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    return float(str(v or 0).replace(",", "").strip() or 0)


def _day(v) -> str:
    if isinstance(v, (datetime, date)):
        return v.isoformat()[:10]
    s = str(v or "").strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s[:10], fmt).date().isoformat()
        except ValueError:
            continue
    raise TradebookError(f"unrecognised trade date {s!r}")


def _rows(file_bytes: bytes, name: str) -> list[list]:
    """Every row of the first sheet (xlsx) or of the file (csv)."""
    if file_bytes[:2] == b"PK" or name.lower().endswith((".xlsx", ".xlsm")):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=True)
        ws = wb.worksheets[0]
        ws.reset_dimensions()  # Kite's files declare a size of A1:A1, which read-only mode would trust
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
    else:
        rows = list(csv.reader(io.StringIO(file_bytes.decode("utf-8-sig", errors="replace"))))
    return rows


def parse(file_bytes: bytes, name: str = "tradebook") -> dict:
    rows = _rows(file_bytes, name)
    meta, hdr = {}, None
    for i, row in enumerate(rows):
        cells = [str(c).strip() if c is not None else "" for c in row]
        keys = {_key(c) for c in cells if c}
        if REQUIRED <= keys:
            hdr = i
            break
        text = " ".join(c for c in cells if c)
        m = re.search(r"from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})", text)
        if m:
            meta["from"], meta["to"] = m.group(1), m.group(2)
        if "Client ID" in cells:
            nxt = cells[cells.index("Client ID") + 1:]
            meta["client_id"] = next((c for c in nxt if c), None)
    if hdr is None:
        raise TradebookError("This doesn't look like a Zerodha tradebook (expected Symbol, Trade Date, Trade Type, "
                             "Quantity and Price columns)")
    cols = {_key(c): j for j, c in enumerate(rows[hdr]) if c not in (None, "")}
    get = lambda r, k: r[cols[k]] if k in cols and cols[k] < len(r) else None  # noqa: E731
    trades, skipped, seen = [], 0, set()
    for n, r in enumerate(rows[hdr + 1:], start=hdr + 2):
        if not r or not any(c not in (None, "") for c in r) or not get(r, "symbol"):
            continue
        if str(get(r, "segment") or "EQ").strip().upper() not in ("EQ", ""):
            skipped += 1  # F&O / currency / commodity-futures segments are out of scope
            continue
        tid = str(get(r, "trade_id") or "").strip() or f"{name}:{n}"
        if tid in seen:
            continue
        seen.add(tid)
        side = str(get(r, "trade_type") or "").strip().lower()
        if side not in ("buy", "sell"):
            raise TradebookError(f"row {n}: trade type must be buy or sell, not {side!r}")
        trades.append({"symbol": str(get(r, "symbol")).strip().upper(), "isin": str(get(r, "isin") or "").strip() or None,
                       "date": _day(get(r, "trade_date")), "type": d.BUY if side == "buy" else d.SELL,
                       "exchange": str(get(r, "exchange") or "NSE").strip().upper(),
                       "series": str(get(r, "series") or "EQ").strip().upper(), "quantity": _num(get(r, "quantity")),
                       "price": _num(get(r, "price")), "trade_id": tid})
    if not trades:
        raise TradebookError("No equity trades found in this tradebook")
    days = sorted(t["date"] for t in trades)
    return {"client_id": meta.get("client_id"), "from_date": meta.get("from") or days[0],
            "to_date": meta.get("to") or days[-1], "trades": trades, "skipped": skipped}


def base_symbol(sym: str | None) -> str:
    """RELIANCE.NS / RELIANCE.BO / MINDSPACE-RR.NS → RELIANCE / MINDSPACE."""
    s = (sym or "").upper().split(".")[0]
    return re.sub(r"-(RR|IV|BE|BZ|SM|ST)$", "", s)


def instrument_spec(symbol: str, series: str, exchanges: set[str]) -> dict:
    suffix = f"-{series}" if series in ("RR", "IV") else ""  # REITs and InvITs trade under their own series on Yahoo
    ex = "NS" if "NSE" in exchanges or not exchanges else "BO"
    return {"asset_class": d.COMMODITY if symbol.endswith("BEES") else d.EQUITY, "name": symbol,
            "symbol": f"{symbol}{suffix}.{ex}", "market": "India", "platform": "Zerodha",
            "category": ("Gold" if "GOLD" in symbol else "Silver" if "SILV" in symbol else None) if symbol.endswith("BEES") else None}


def _group(trades: list[dict]) -> dict[str, list[dict]]:
    """Fills → one row per symbol, day and side (how the app records trades)."""
    g: dict[tuple, dict] = {}
    for t in trades:
        k = (t["symbol"], t["date"], t["type"])
        row = g.setdefault(k, {"date": t["date"], "type": t["type"], "quantity": 0.0, "amount": 0.0, "fills": 0,
                               "exchanges": set(), "series": t["series"], "isin": t["isin"]})
        row["quantity"] += t["quantity"]
        row["amount"] += t["quantity"] * t["price"]
        row["fills"] += 1
        row["exchanges"].add(t["exchange"])
    out = defaultdict(list)
    for (sym, _, _), row in sorted(g.items(), key=lambda kv: (kv[0][1], kv[0][2] != d.BUY)):
        row["quantity"], row["amount"] = round(row["quantity"], 6), round(row["amount"], 2)
        row["price"] = round(row["amount"] / row["quantity"], 4) if row["quantity"] else 0.0
        out[sym].append(row)
    return out


def _total(rows) -> tuple[float, float]:
    return sum(float(r["quantity"] or 0) for r in rows), sum(float(r["amount"] or 0) for r in rows)


def _same_total(a, b) -> bool:
    (qa, aa), (qb, ab) = _total(a), _total(b)
    return abs(qa - qb) < QTY_EPS and abs(aa - ab) < SUM_EPS


def reconcile(books: list[dict], instruments: list[dict], transactions: list[dict]) -> dict:
    """Plan per stock: trades to add, combined app rows to split into Kite's trades, amount differences,
    app rows Kite doesn't list (kept), and anything that needs a decision."""
    trades = {t["trade_id"]: t for b in books for t in b["trades"]}.values()
    start, end = min(b["from_date"] for b in books), max(b["to_date"] for b in books)
    held = [i for i in instruments if i["asset_class"] in (d.EQUITY, d.COMMODITY) and (i.get("market") or "India") == "India"]
    by_symbol = {}
    for i in held:
        by_symbol.setdefault(base_symbol(i.get("symbol")), i)
    by_name = {i["name"].strip().upper(): i for i in held}
    txns = defaultdict(list)
    for t in transactions:
        if t["type"] in (d.BUY, d.SELL) and start <= t["date"] <= end:
            txns[t["instrument_id"]].append(t)

    stocks = []
    for sym, groups in sorted(_group(list(trades)).items()):
        inst = by_symbol.get(sym) or by_name.get(sym)
        app_rows = txns.get(inst["id"], []) if inst else []
        plan = {"symbol": sym, "instrument_id": inst["id"] if inst else None, "name": inst["name"] if inst else sym,
                "new_instrument": None if inst else instrument_spec(sym, groups[0]["series"],
                                                                    set().union(*(g["exchanges"] for g in groups))),
                "isin": groups[0]["isin"], "matched": 0, "add": [], "split": [], "corrections": [], "kept": [], "review": []}
        for side in (d.BUY, d.SELL):
            kite = [{**g, "exchanges": sorted(g["exchanges"])} for g in groups if g["type"] == side]
            app = sorted((t for t in app_rows if t["type"] == side), key=lambda t: (t["date"], t["id"]))
            _match_side(plan, kite, app)
        kq = sum(g["quantity"] * (1 if g["type"] == d.BUY else -1) for g in groups)
        aq = sum(float(t["quantity"] or 0) * (1 if t["type"] == d.BUY else -1) for t in app_rows)
        plan["kite_net"], plan["app_net"] = round(kq, 6), round(aq, 6)
        stocks.append(plan)
    return {"from_date": start, "to_date": end, "client_ids": sorted({b["client_id"] for b in books if b.get("client_id")}),
            "trades": len(trades), "stocks": stocks}


def _match_side(plan: dict, kite: list[dict], app: list[dict]):
    # 1. same day, quantity and amount: already recorded
    for g in list(kite):
        hit = next((t for t in app if t["date"] == g["date"] and abs(float(t["quantity"] or 0) - g["quantity"]) < QTY_EPS
                    and abs(float(t["amount"] or 0) - g["amount"]) < AMT_EPS), None)
        if hit:
            kite.remove(g)
            app.remove(hit)
            plan["matched"] += 1
    # 1b. several app rows on one day that add up to Kite's day (orders entered separately): also recorded
    for g in list(kite):
        same_day = [t for t in app if t["date"] == g["date"]]
        if len(same_day) > 1 and _same_total(same_day, [g]):
            kite.remove(g)
            for t in same_day:
                app.remove(t)
            plan["matched"] += 1
    # 2. same day and quantity, different amount: offer Kite's figure, but don't assume
    for g in list(kite):
        hit = next((t for t in app if t["date"] == g["date"] and abs(float(t["quantity"] or 0) - g["quantity"]) < QTY_EPS), None)
        if hit:
            kite.remove(g)
            app.remove(hit)
            plan["corrections"].append({"txn_id": hit["id"], "date": g["date"], "type": g["type"], "quantity": g["quantity"],
                                        "app_amount": round(float(hit["amount"] or 0), 2), "kite_amount": g["amount"],
                                        "selected": False})
    if not kite:
        plan["kept"] += [_brief(t) for t in app]  # e.g. IPO allotments, which never appear in a tradebook
        return
    if not app:
        plan["add"] += [{**g, "selected": True} for g in kite]
        return
    # 3. app rows that together equal Kite's trades (all, or the earliest ones): combined entries to split
    for n in range(len(kite), 0, -1):
        if _same_total(app, kite[:n]):
            plan["split"].append({"type": app[0]["type"], "remove": [_brief(t) for t in app],
                                  "add": kite[:n], "selected": True})
            plan["add"] += [{**g, "selected": True} for g in kite[n:]]
            return
    # 4. nothing lines up: show both sides; replacing is the user's call
    (aq, aa), (kq, ka) = _total(app), _total(kite)
    plan["review"].append({"type": app[0]["type"], "remove": [_brief(t) for t in app], "add": kite, "selected": False,
                           "message": f"App has {aq:g} for ₹{aa:,.2f}; Kite shows {kq:g} for ₹{ka:,.2f} in this period"})


def _brief(t: dict) -> dict:
    return {"id": t["id"], "date": t["date"], "type": t["type"], "quantity": float(t["quantity"] or 0),
            "amount": round(float(t["amount"] or 0), 2), "notes": t.get("notes")}
