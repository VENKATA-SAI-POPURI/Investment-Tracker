"""LenDenClub reports (xlsx): the ORDER_REPORT (one row per loan funded) and the Investment Report
(loan-level summary of everything received so far, one file per lending type: Manual or Lumpsum).

Repayments in the ledger record the cash sent to the bank: amount = principal + interest − fees, so
`interest` (amount − principal) is already after fees and `fees` is kept for reference only."""
from __future__ import annotations

import io
import re
from datetime import date

ORDER_REPORT, INVESTMENT_REPORT = "order_report", "investment_report"
STATUS = {"DISBURSED": "active", "ACTIVE": "active", "CLOSED": "closed", "FORECLOSED": "closed", "NPA": "defaulted"}
LENDING_TYPE = {"MANUAL": "Manual", "MANUAL_LENDING": "Manual", "LUMPSUM": "Lumpsum", "LUMPSUM_LENDING": "Lumpsum"}

# Column names have changed between report versions; each field lists every header seen so far
COLUMNS = {
    "order_id": ("Order ID",), "loan_id": ("Loan ID",), "lending_type": ("Lending Type",),
    "rate": ("Interest Rate (%)", "Interest Rate (%p.a.)"), "tenure": ("Tenure (months)", "Tenure (in months)"),
    "score": ("LenDenClub Score", "LDC Score"), "date": ("Disbursement Date",), "first_emi": ("Repayment Start Date",),
    "amount": ("Disbursed Amount (₹)", "Invested Amount (₹)"), "status": ("Loan Status",), "dpd": ("DPD",),
    "principal": ("Principal Received (₹)",), "interest": ("Interest Received (₹)",),
    "npa_recovery": ("NPA Recovery (₹)",), "fee": ("Platform Fee (₹)",), "recovery_fee": ("Recovery Fees (₹)",),
    "recovery_exp": ("Recovery Expenses (₹)",), "net": ("Net Received  (sent to bank) (₹)", "Net Received (sent to bank) (₹)"),
    "outstanding": ("Principal Outstanding (₹)",), "npa": ("NPA (₹)",), "closed_on": ("Closure / NPA Date",),
}
SUMMARY = {"Disbursed/ invested amount": "invested", "Principal Received": "principal", "Interest Received": "interest",
           "NPA Recovered": "npa_recovery", "Platform Fee": "fee", "Recovery Fee": "recovery_fee",
           "Recovery Expenses": "recovery_exp", "Net Received (sent to bank)": "net",
           "Principal Outstanding": "outstanding", "NPA": "npa"}


def read_sheets(file_bytes: bytes) -> list[list[tuple]]:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=True)
    for ws in wb.worksheets:
        ws.reset_dimensions()  # don't trust the size a file declares; some exports get it wrong
    return [list(ws.iter_rows(values_only=True)) for ws in wb.worksheets]


def _f(v) -> float:
    if isinstance(v, str):
        v = v.replace("₹", "").replace(",", "").strip()
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
    if m:
        return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}"
    return s[:10] if re.match(r"\d{4}-\d{2}-\d{2}", s) else None


def _table(rows: list[tuple]):
    """Locate the loan table (the header row holding 'Loan ID') and the key/value block above it."""
    meta = {}
    for i, row in enumerate(rows):
        cells = [str(c).strip() if c is not None else "" for c in row]
        if "Loan ID" in cells and "Order ID" in cells:
            col = {k: next((cells.index(n) for n in names if n in cells), None) for k, names in COLUMNS.items()}
            return meta, i, col
        if cells and cells[0] and len(cells) > 1 and row[1] not in (None, ""):
            meta[re.sub(r"\s+", " ", cells[0])] = row[1]
    return meta, None, None


def detect(sheets: list[list[tuple]]) -> tuple[str, dict, list[tuple], dict]:
    """Return (kind, meta, data rows, column map) for the sheet that holds loan rows."""
    for rows in sheets:
        meta, hdr, col = _table(rows)
        if hdr is None:
            continue
        kind = INVESTMENT_REPORT if col["principal"] is not None else ORDER_REPORT
        return kind, meta, [r for r in rows[hdr + 1:] if any(c not in (None, "") for c in r)], col
    raise ValueError("This doesn't look like a LenDenClub order report or investment report (no 'Loan ID' table found)")


def _add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, min(d.day, 28))


def maturity_from(disbursed: str | None, tenure: int, first_emi: str | None = None) -> str | None:
    """The last EMI date: from the first EMI when the report gives it, otherwise estimated (EMIs on the
    5th, the first one next month if disbursed by the 20th)."""
    if not tenure:
        return None
    if first_emi:
        return _add_months(date.fromisoformat(first_emi), int(tenure) - 1).isoformat()
    if not disbursed:
        return None
    dd = date.fromisoformat(disbursed)
    return _add_months(date(dd.year, dd.month, 5), (1 if dd.day <= 20 else 2) + int(tenure) - 1).isoformat()


def last_emi_due(first_emi: str | None, tenure: int, on: str) -> str | None:
    """The most recent instalment date on or before `on`."""
    if not first_emi or first_emi > on:
        return None
    start, due = date.fromisoformat(first_emi), first_emi
    for k in range(1, max(int(tenure), 1)):
        nxt = _add_months(start, k).isoformat()
        if nxt > on:
            break
        due = nxt
    return due


def parse(file_bytes: bytes) -> dict:
    """Read one LenDen workbook into a uniform shape: {kind, from_date, to_date, summary, loans}."""
    kind, meta, rows, col = detect(read_sheets(file_bytes))
    get = lambda row, k: row[col[k]] if col[k] is not None and col[k] < len(row) else None  # noqa: E731
    loans, skipped = {}, 0
    for row in rows:
        loan_id = str(get(row, "loan_id") or "").strip().upper()
        if not loan_id:
            continue
        status = str(get(row, "status") or "").strip().upper()
        amount = _f(get(row, "amount"))
        if status in ("PENDING", "CANCELLED", "FAILED") or amount == 0:
            skipped += 1
            continue
        tenure, rate, score = int(_f(get(row, "tenure"))), _f(get(row, "rate")) or None, int(_f(get(row, "score"))) or None
        disbursed, first_emi = _dmy(get(row, "date")), _dmy(get(row, "first_emi"))
        loan = {"loan_id": loan_id, "order_id": str(get(row, "order_id") or "").strip() or None,
                "lending_type": LENDING_TYPE.get(str(get(row, "lending_type") or "").strip().upper().replace(" ", "_")),
                "date": disbursed, "amount": amount, "tenure": tenure, "rate": rate, "score": score,
                "status": STATUS.get(status, "active"), "first_emi": first_emi,
                "maturity_date": maturity_from(disbursed, tenure, first_emi)}
        if kind == INVESTMENT_REPORT:
            principal, interest = _f(get(row, "principal")), _f(get(row, "interest"))
            recovery = _f(get(row, "npa_recovery"))
            fees = _f(get(row, "fee")) + _f(get(row, "recovery_fee")) + _f(get(row, "recovery_exp"))
            net = _f(get(row, "net")) if col["net"] is not None else round(principal + interest + recovery - fees, 4)
            loan.update({"principal": min(round(principal + recovery, 4), amount), "interest": interest, "fees": round(fees, 4),
                         "net": net, "dpd": str(get(row, "dpd") or "").strip() or None,
                         "closed_on": _dmy(get(row, "closed_on")) if loan["status"] != "active" else None})
            if loan["principal"] >= amount - 0.01:
                loan["status"] = "closed"
        loans[loan_id] = loan
    summary = {key: _f(meta[label]) for label, key in SUMMARY.items() if label in meta} if kind == INVESTMENT_REPORT else {}
    return {"kind": kind, "from_date": _dmy(meta.get("From Date")), "to_date": _dmy(meta.get("To Date")),
            "summary": summary, "loans": list(loans.values()), "skipped": skipped}


def notes_for(loan: dict) -> str:
    parts = [f"Rate: {loan['rate']:g}%" if loan.get("rate") else None, f"Score: {loan['score']}" if loan.get("score") else None,
             f"Order {loan['order_id']}" if loan.get("order_id") else None]
    return ", ".join(p for p in parts if p)


# Instrument fields an import may fill in when they are empty: category holds the lending type, sub_category the order
FILLABLE = ("rate", "tenure_months", "category", "sub_category", "maturity_date")


def fill_in(inst: dict, loan: dict) -> dict:
    """Loan details the report knows and the app is missing; never overwrites anything already recorded."""
    want = dict(zip(FILLABLE, (loan.get("rate"), loan.get("tenure") or None, loan.get("lending_type"),
                               loan.get("order_id"), loan.get("maturity_date"))))
    return {k: v for k, v in want.items() if v not in (None, "") and inst.get(k) in (None, "")}


def reconcile(reports: list[dict], loans: dict[str, dict], posted: dict[int, dict], today: date | None = None) -> dict:
    """Compare parsed reports with what the app holds.

    loans: LOAN_ID -> instrument (id, ref, name, status, rate, category, …)
    posted: instrument id -> {"amount", "principal", "fees", "last"} of repayments already recorded.
    Returns the loans to add, the repayments still to post, status changes, details to fill in, and
    anything that needs a manual look."""
    today = today or date.today()
    merged: dict[str, dict] = {}
    for rep in sorted(reports, key=lambda r: r["kind"] == INVESTMENT_REPORT):  # investment report figures win
        for loan in rep["loans"]:
            merged[loan["loan_id"]] = {**merged.get(loan["loan_id"], {}), **{k: v for k, v in loan.items() if v is not None},
                                       "as_of": rep["to_date"] or today.isoformat()}
    new, repayments, status, details, review, overdue = [], [], [], [], [], []
    for loan_id, r in merged.items():
        inst = loans.get(loan_id)
        has_receipts = "net" in r
        if inst is None:
            new.append({**r, "notes": notes_for(r), "repayment": _repayment(r, {}, r.get("date"), today) if has_receipts else None,
                        "selected": True})
            continue
        extra = fill_in(inst, r)
        if extra:
            details.append({"instrument_id": inst["id"], "loan_id": loan_id, "ref": inst.get("ref"), "fields": extra})
        if not has_receipts:
            continue
        done = posted.get(inst["id"], {})
        rp = _repayment(r, done, done.get("last") or r.get("date"), today)
        if rp and rp.get("problem"):
            review.append({"loan_id": loan_id, "instrument_id": inst["id"], "ref": inst.get("ref"), "name": inst.get("name"),
                           "message": rp["problem"]})
        elif rp:
            repayments.append({"loan_id": loan_id, "instrument_id": inst["id"], "ref": inst.get("ref"), "name": inst.get("name"),
                               "lending_type": r.get("lending_type"), **rp, "selected": True})
        old = (inst.get("status") or "active").lower()
        if r["status"] != old and not (r["status"] == "active" and old == "closed"):
            status.append({"loan_id": loan_id, "instrument_id": inst["id"], "ref": inst.get("ref"), "name": inst.get("name"),
                           "old_status": old, "new_status": r["status"], "apply": True})
        if r.get("dpd") not in (None, "0", "") and r["status"] == "active":
            overdue.append({"loan_id": loan_id, "ref": inst.get("ref"), "dpd": r["dpd"]})
    return {"new_loans": sorted(new, key=lambda x: (x.get("date") or "", x["loan_id"])),
            "repayments": sorted(repayments, key=lambda x: x.get("ref") or ""), "status_changes": status,
            "details": details, "review": review, "overdue": overdue}


def _repayment(r: dict, done: dict, floor: str | None, today: date) -> dict | None:
    """The part of a loan's receipts not yet in the ledger, dated on closure, else on the latest EMI due
    (else the report date), and never before what is already recorded."""
    dp = round(r["principal"] - done.get("principal", 0.0), 2)
    da = round(r["net"] - done.get("amount", 0.0), 2)
    df = round(r["fees"] - done.get("fees", 0.0), 2)
    if abs(dp) < 0.01 and abs(da) < 0.01:
        return None
    if dp < -0.01 or da < -0.01:
        return {"problem": f"The report shows less received (principal ₹{r['principal']:,.2f}, net ₹{r['net']:,.2f}) "
                           f"than the app has recorded (₹{done.get('principal', 0):,.2f}, ₹{done.get('amount', 0):,.2f})"}
    dp, df = max(dp, 0.0), max(df, 0.0)
    if dp > da + 0.005:
        return {"problem": f"₹{dp:,.2f} of new principal but only ₹{da:,.2f} more cash received — check this loan's repayments"}
    as_of = r.get("as_of") or today.isoformat()
    when = r.get("closed_on") or last_emi_due(r.get("first_emi"), r.get("tenure") or 1, as_of) or as_of
    when = max(when, floor or when)
    when = min(when, today.isoformat())
    return {"date": when, "principal": dp, "interest": round(da - dp, 2), "fees": df, "amount": da,
            "closes": r["status"] != "active"}
