"""Consolidated Account Statement (CAS) import, parsed with the open-source `casparser` library.

- CAMS / KFintech *detailed* CAS: full mutual fund transaction history per folio and scheme.
- CAMS / KFintech *summary* CAS: closing units only, imported as one opening purchase at cost.
- NSDL / CDSL CAS: demat holdings (used to reconcile units, never written) and NPS schemes.
"""
from __future__ import annotations

import io
import re
from datetime import date

from .. import domain as d

BUY_TYPES = {"PURCHASE", "PURCHASE_SIP", "SWITCH_IN", "SWITCH_IN_MERGER", "DIVIDEND_REINVEST", "GIFT_IN"}
SELL_TYPES = {"REDEMPTION", "SWITCH_OUT", "SWITCH_OUT_MERGER", "GIFT_OUT"}
CHARGE_TYPES = {"STAMP_DUTY_TAX"}  # added to the cost of the same day's purchase
SKIPPED = {"STT_TAX", "TDS_TAX", "SEGREGATION", "MISC", "UNKNOWN", "REVERSAL"}

_NOISE = re.compile(r"\b(direct|regular|plan|growth|option|dividend|idcw|reinvestment|payout|fund|scheme|the)\b|[^a-z0-9 ]")


class CasError(ValueError):
    pass


def norm_name(name: str) -> str:
    """Comparable fund name: 'Axis ELSS Tax Saver Fund - Direct Growth' -> 'axis elss tax saver'."""
    s = re.sub(r"\(.*?\)|isin:.*$", " ", (name or "").lower())
    return " ".join(_NOISE.sub(" ", s).split())


def clean_scheme_name(name: str) -> str:
    """Drop the RTA code prefix and the trailing ISIN/advisor noise CAS lines carry."""
    s = re.sub(r"^[A-Z0-9]{2,8}-", "", (name or "").strip())
    s = re.sub(r"\s*-?\s*(ISIN|Advisor|Registrar)\s*:.*$", "", s, flags=re.I)
    s = re.sub(r"\(\s*(formerly|erstwhile|non-demat|demat).*?\)", "", s, flags=re.I)
    return " ".join(s.split()).strip(" -")


def _category(scheme_type: str | None, name: str) -> str | None:
    if re.search(r"\belss\b|tax saver", name, re.I):
        return "ELSS"
    t = (scheme_type or "").upper()
    return {"EQUITY": "Equity", "DEBT": "Debt", "HYBRID": "Hybrid"}.get(t) or None


def _num(v) -> float:
    return float(v) if v is not None else 0.0


def _iso(v) -> str | None:
    if v is None:
        return None
    return v.isoformat() if isinstance(v, date) else str(v)[:10]


def parse(pdf: bytes, password: str) -> dict:
    try:
        from casparser import read_cas_pdf
        from casparser.exceptions import CASParseError, IncorrectPasswordError
    except ImportError as e:  # pragma: no cover - dependency missing on the server
        raise CasError("CAS import is not installed on the server") from e
    try:
        data = read_cas_pdf(io.BytesIO(pdf), password or "")
    except IncorrectPasswordError as e:
        raise CasError("That password did not open the PDF. CAS files usually use your PAN in capitals, or the password you set when requesting the statement.") from e
    except CASParseError as e:
        raise CasError(f"Could not read this statement: {e}") from e
    data = data if isinstance(data, dict) else data.model_dump()
    period = data.get("statement_period") or {}
    out = {"file_type": str(data.get("file_type") or "").split(".")[-1], "cas_type": str(data.get("cas_type") or "").split(".")[-1],
           "investor": (data.get("investor_info") or {}).get("name"), "period": {"from": _iso(period.get("from_") or period.get("from")),
                                                                                 "to": _iso(period.get("to"))},
           "funds": [], "nps": [], "demat": [], "warnings": list(data.get("parse_warnings") or [])}
    if "folios" in data:
        _mutual_funds(data, out)
    if data.get("accounts") is not None or data.get("nps"):
        _nsdl(data, out)
    if not (out["funds"] or out["nps"] or out["demat"]):
        raise CasError("No mutual funds, NPS or demat holdings were found in this statement.")
    return out


def _mutual_funds(data: dict, out: dict):
    as_of = out["period"]["to"] or date.today().isoformat()
    for folio in data.get("folios") or []:
        for sch in folio.get("schemes") or []:
            name = clean_scheme_name(sch.get("scheme"))
            txns, skipped = [], 0
            for t in sch.get("transactions") or []:
                typ = str(t.get("type") or "").split(".")[-1].upper()
                day, amount, units = _iso(t.get("date")), abs(_num(t.get("amount"))), abs(_num(t.get("units")))
                if typ in BUY_TYPES and units:
                    txns.append({"date": day, "type": d.BUY, "quantity": round(units, 4), "amount": round(amount, 2),
                                 "notes": (t.get("description") or "").strip()[:120] or None})
                elif typ in SELL_TYPES and units:
                    txns.append({"date": day, "type": d.SELL, "quantity": round(units, 4), "amount": round(amount, 2),
                                 "notes": (t.get("description") or "").strip()[:120] or None})
                elif typ == "DIVIDEND_PAYOUT" and amount:
                    txns.append({"date": day, "type": d.DIVIDEND, "quantity": None, "amount": round(amount, 2), "notes": None})
                elif typ in CHARGE_TYPES and amount:
                    same = [x for x in txns if x["date"] == day and x["type"] == d.BUY]
                    if same:
                        same[-1]["amount"] = round(same[-1]["amount"] + amount, 2)
                else:
                    skipped += 1
            close = _num(sch.get("close"))
            val = sch.get("valuation") or {}
            opening_only = False
            if not txns and close > 0:
                # Summary statement: no history, so record the holding once at its cost
                cost = _num(val.get("cost")) or _num(val.get("value"))
                txns.append({"date": _iso(val.get("date")) or as_of, "type": d.BUY, "quantity": round(close, 4),
                             "amount": round(cost, 2), "notes": "Opening balance from CAS summary"})
                opening_only = True
            if not txns:
                continue
            amfi = str(sch.get("amfi") or "").strip() or None
            out["funds"].append({
                "key": f"{folio.get('folio')}|{amfi or name}", "name": name, "amc": folio.get("amc"), "folio": folio.get("folio"),
                "amfi": amfi, "isin": sch.get("isin"), "category": _category(sch.get("type"), name),
                "closing_units": round(close, 4), "value": _num(val.get("value")) or None, "nav": _num(val.get("nav")) or None,
                "opening_only": opening_only, "skipped": skipped, "transactions": txns,
            })


def _nsdl(data: dict, out: dict):
    for acct in data.get("accounts") or []:
        for e in acct.get("equities") or []:
            out["demat"].append({"name": e.get("name"), "isin": e.get("isin"), "symbol": e.get("symbol"),
                                 "units": _num(e.get("num_shares")), "price": _num(e.get("price")) or None,
                                 "value": _num(e.get("value")) or None, "account": acct.get("name")})
        for m in acct.get("mutual_funds") or []:
            out["demat"].append({"name": m.get("name"), "isin": m.get("isin"), "symbol": None, "units": _num(m.get("balance")),
                                 "price": _num(m.get("nav")) or None, "value": _num(m.get("value")) or None,
                                 "account": acct.get("name"), "mutual_fund": True})
    for acct in data.get("nps") or []:
        for s in acct.get("schemes") or []:
            out["nps"].append({"key": f"{acct.get('pran')}|{s.get('scheme')}", "pran": acct.get("pran"),
                               "name": " ".join(str(s.get("scheme") or "NPS scheme").split()), "tier": s.get("tier"),
                               "fund_manager": s.get("fund_manager"), "units": round(_num(s.get("units")), 4),
                               "nav": _num(s.get("nav")) or None, "value": _num(s.get("value")) or None})
