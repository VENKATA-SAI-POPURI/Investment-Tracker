"""LenDenClub ORDER_REPORT and account-statement parsers (xlsx)."""
from __future__ import annotations

import io
import re
from datetime import date

STATUS_ORDER = {"DISBURSED": "active", "CLOSED": "closed", "NPA": "defaulted", "ACTIVE": "active", "FORECLOSED": "closed"}
STATUS_STMT = {"ACTIVE": "active", "CLOSED": "closed", "NPA": "defaulted"}


def read_rows(file_bytes: bytes) -> list[tuple]:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=True)
    return list(wb.active.iter_rows(values_only=True))


def _f(v) -> float:
    try:
        return round(float(v or 0), 4)
    except (TypeError, ValueError):
        return 0.0


def _dmy(v) -> str | None:
    if not v:
        return None
    if hasattr(v, "isoformat"):
        return v.isoformat()[:10]
    s = str(v).strip()
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}" if m else s[:10]


def _header(rows, require_loan_col: bool):
    meta, hdr = {}, None
    for i, row in enumerate(rows):
        first = str(row[0]).strip() if row and row[0] else ""
        if first in ("From Date", "To Date") and len(row) > 1 and row[1]:
            meta[first] = _dmy(row[1])
        elif first == "Order ID" and (not require_loan_col or (len(row) > 1 and row[1] == "Loan ID")):
            hdr = i
            break
    if hdr is None:
        raise ValueError("Could not find the loan table (missing 'Order ID' header row)")
    headers = [str(c).strip() if c else "" for c in rows[hdr]]
    col = lambda name: headers.index(name) if name in headers else None  # noqa: E731
    return meta, hdr, col


def maturity_from(disbursed: str | None, tenure: int) -> str | None:
    """LenDen EMIs fall on the 5th; the first EMI is next month if disbursed by the 20th."""
    if not disbursed or not tenure:
        return None
    dd = date.fromisoformat(disbursed)
    offset = (1 if dd.day <= 20 else 2) + int(tenure) - 1
    y = dd.year + (dd.month + offset - 1) // 12
    m = (dd.month + offset - 1) % 12 + 1
    return date(y, m, 5).isoformat()


def parse_order_report(rows: list[tuple], existing_loan_ids: set[str], next_number: int) -> dict:
    meta, hdr, col = _header(rows, require_loan_col=False)
    idx = {k: col(v) for k, v in {"loan_id": "Loan ID", "rate": "Interest Rate (%)", "tenure": "Tenure (months)",
                                   "date": "Disbursement Date", "amount": "Disbursed Amount (₹)",
                                   "status": "Loan Status", "score": "LenDenClub Score"}.items()}
    get = lambda row, k: row[idx[k]] if idx[k] is not None and idx[k] < len(row) else None  # noqa: E731
    out, skipped, seen = [], 0, set()
    for row in rows[hdr + 1:]:
        if not any(row):
            continue
        loan_id = str(get(row, "loan_id") or "").strip().upper()
        if not loan_id:
            continue
        status = str(get(row, "status") or "").strip().upper()
        amount = _f(get(row, "amount"))
        if status in ("PENDING", "CANCELLED") or amount == 0:
            skipped += 1
            continue
        if loan_id in seen:
            continue
        seen.add(loan_id)
        rate, tenure, score = _f(get(row, "rate")), int(_f(get(row, "tenure"))), int(_f(get(row, "score")))
        disb = _dmy(get(row, "date"))
        exists = loan_id in existing_loan_ids
        if not exists:
            next_number += 1
        out.append({
            "loan_id": loan_id, "lending_id": f"P2P-{str(next_number).zfill(3)}" if not exists else None,
            "platform": "LenDen", "name": loan_id, "date": disb, "amount": amount, "tenure": tenure,
            "rate": rate, "score": score, "status": STATUS_ORDER.get(status, "active"),
            "maturity_date": maturity_from(disb, tenure), "notes": f"Rate: {rate}%, Score: {score}",
            "selected": not exists, "already_exists": exists,
        })
    return {"from_date": meta.get("From Date"), "to_date": meta.get("To Date"), "rows": out, "skipped": skipped}


def parse_statement(rows: list[tuple], loans_by_loan_id: dict[str, dict], posted: dict[int, dict]) -> dict:
    """loans_by_loan_id: LOAN_ID -> loan position (id, ref, name, status, invested)
    posted: instrument id -> {"principal", "interest", "fees"} already recorded."""
    meta, hdr, col = _header(rows, require_loan_col=True)
    idx = {k: col(v) for k, v in {"loan_id": "Loan ID", "disb_date": "Disbursement Date",
                                   "disb_amount": "Disbursed Amount (₹)", "status": "Loan Status",
                                   "principal": "Principal Received (₹)", "interest": "Interest Received (₹)",
                                   "fee": "Platform Fee (₹)"}.items()}
    get = lambda row, k: row[idx[k]] if idx[k] is not None and idx[k] < len(row) else None  # noqa: E731
    as_of = meta.get("To Date") or date.today().isoformat()
    suggested, warnings = [], []
    for row in rows[hdr + 1:]:
        if not any(row):
            continue
        loan_id = str(get(row, "loan_id") or "").strip().upper()
        if not loan_id:
            continue
        p, i, fee = _f(get(row, "principal")), _f(get(row, "interest")), _f(get(row, "fee"))
        disbursed = _f(get(row, "disb_amount"))
        new_status = STATUS_STMT.get(str(get(row, "status") or "").strip().upper())
        loan = loans_by_loan_id.get(loan_id)
        if not loan:
            warnings.append({"type": "unmatched", "loan_id": loan_id, "disbursement_date": _dmy(get(row, "disb_date")),
                             "disbursed_amount": disbursed or None,
                             "message": f"Loan {loan_id} is not in your P2P loans. Import the order report first."})
            continue
        if disbursed and p >= disbursed - 1:
            new_status = "closed"
        if new_status and new_status != (loan.get("status") or "").lower():
            warnings.append({"type": "status_change", "loan_id": loan_id, "instrument_id": loan["id"],
                             "old_status": loan.get("status"), "new_status": new_status,
                             "message": f"{loan_id}: status changes from {loan.get('status')} to {new_status}"})
        done = posted.get(loan["id"], {"principal": 0.0, "interest": 0.0, "fees": 0.0})
        dp, di, df = round(p - done["principal"], 4), round(i - done["interest"], 4), round(fee - done["fees"], 4)
        if not (dp or di or df):
            continue
        suggested.append({
            "loan_id": loan_id, "instrument_id": loan["id"], "lending_id": loan.get("ref"), "name": loan.get("name"),
            "date": as_of, "stmt_principal": p, "stmt_interest": i, "stmt_fee": fee,
            "posted_principal": round(done["principal"], 4), "posted_interest": round(done["interest"], 4),
            "posted_fee": round(done["fees"], 4), "delta_principal": dp, "delta_interest": di, "delta_fee": df,
            "delta_total": round(dp + di, 4), "new_status": new_status if new_status != (loan.get("status") or "").lower() else None,
            "selected": True,
        })
    return {"from_date": meta.get("From Date"), "to_date": as_of, "suggested": suggested, "warnings": warnings}
