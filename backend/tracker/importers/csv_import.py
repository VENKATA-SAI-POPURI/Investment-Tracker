"""CSV transaction import in the app's own template. Broker tradebooks go through importers.tradebook."""
from __future__ import annotations

import csv
import io
from datetime import date

from .. import domain as d

TEMPLATE_HEADERS = ["date", "type", "asset_class", "name", "symbol", "quantity", "amount", "amount_usd",
                    "market", "sector", "market_cap", "category", "notes"]
CLASS_ALIASES = {"equity": d.EQUITY, "stock": d.EQUITY, "stocks": d.EQUITY, "mf": d.MUTUAL_FUND,
                 "mutual_fund": d.MUTUAL_FUND, "mutual fund": d.MUTUAL_FUND, "commodity": d.COMMODITY,
                 "etf": d.COMMODITY, "gold": d.COMMODITY}


def _num(v):
    if v in (None, ""):
        return None
    return float(str(v).replace(",", "").replace("₹", "").replace("$", "").strip())


def _date(v: str) -> str:
    v = (v or "").strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d", "%d-%b-%Y", "%d %b %Y"):
        try:
            from datetime import datetime
            return datetime.strptime(v[:11].strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return date.fromisoformat(v[:10]).isoformat()


def parse(text: str) -> dict:
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    headers = {h.strip().lower(): h for h in (reader.fieldnames or [])}
    if {"trade_date", "trade_type", "symbol", "quantity", "price"} <= set(headers):
        raise ValueError("This is a Zerodha tradebook: import it from Tools → Import statements → Kite tradebook, "
                         "which also reconciles it with the trades you already have")
    missing = {"date", "type", "name", "amount"} - set(headers)
    if missing:
        raise ValueError("CSV is missing columns: " + ", ".join(sorted(missing))
                         + ". Expected the template headers: " + ", ".join(TEMPLATE_HEADERS))
    rows, errors = [], []
    for n, raw in enumerate(reader, start=2):
        r = {k: (raw.get(orig) or "").strip() for k, orig in headers.items()}
        try:
            typ = r["type"].upper()
            if typ not in (d.BUY, d.SELL, d.DIVIDEND):
                raise ValueError("type must be BUY, SELL or DIVIDEND")
            ac = CLASS_ALIASES.get((r.get("asset_class") or "equity").lower())
            if not ac:
                raise ValueError("asset_class must be equity, mutual_fund or commodity")
            rows.append({"line": n, "date": _date(r["date"]), "type": typ, "asset_class": ac, "name": r["name"],
                         "symbol": r.get("symbol") or None, "quantity": _num(r.get("quantity")),
                         "amount": _num(r["amount"]), "amount_fc": _num(r.get("amount_usd")),
                         "market": r.get("market") or ("USA" if r.get("amount_usd") else "India"),
                         "sector": r.get("sector") or None, "market_cap": r.get("market_cap") or None,
                         "category": r.get("category") or None, "notes": r.get("notes") or None})
        except (ValueError, KeyError) as e:
            errors.append({"line": n, "error": str(e)})
    return {"format": "template", "rows": rows, "errors": errors}

