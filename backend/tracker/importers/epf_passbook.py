"""EPFO member passbook PDFs (one per member ID and financial year, from passbook.epfindia.gov.in).

Each statement lists the opening balance, monthly contributions, withdrawals ("Claim Against PARA …"),
transfers between member IDs of the same UAN, the interest credited on 31 March and the closing
balance, as employee / employer / pension shares. The app keeps one EPF holding per UAN:
contributions become BUY, withdrawals SELL, interest CREDIT (employee + employer shares; the pension
share is a separate scheme and is not part of the EPF balance). Transfers between the uploaded member
IDs cancel out and are left out; a transfer from an account whose statements weren't uploaded counts
as money coming in.
"""
from __future__ import annotations

import io
import re
from datetime import datetime

ROW = re.compile(r"^([A-Z][a-z]{2}-\d{4}) (\d{2}-\d{2}-\d{4}) (CR|DR)\b ?(.*)$")
NUM = r"-?[\d,]+(?:\.\d+)?"
FIVE = re.compile(rf"({NUM}) ({NUM}) ({NUM}) ({NUM}) ({NUM})\s*$")
THREE = re.compile(rf"({NUM}) ({NUM}) ({NUM})\s*$")


class PassbookError(ValueError):
    pass


def _n(v: str) -> float:
    return float(v.replace(",", ""))


def _d(v: str) -> str:
    return datetime.strptime(v.replace("/", "-"), "%d-%m-%Y").date().isoformat()


def pdf_text(file_bytes: bytes, password: str | None = None) -> str:
    import pypdfium2 as pdfium
    try:
        pdf = pdfium.PdfDocument(io.BytesIO(file_bytes), password=password or None)
    except pdfium.PdfiumError as e:
        raise PassbookError("Couldn't open the PDF" + (" (it may need a password)" if "password" in str(e).lower() else f" ({e})"))
    return "\n".join(pdf[i].get_textpage().get_text_range() for i in range(len(pdf)))


def parse(text: str) -> dict:
    lines = [l.strip() for l in text.splitlines()]
    joined = "\n".join(lines)
    member = re.search(r"Member ID/Name\s+(\S+)\s*/\s*(.+)", joined)
    if not member:
        raise PassbookError("This doesn't look like an EPFO member passbook (no Member ID found)")
    est = re.search(r"Establishment ID/Name\s+(\S+)\s*/\s*(.+)", joined)
    uan = re.search(r"UAN\s+(\d{12})", joined)
    fy = re.search(r"Financial Year - (\d{4})-(\d{4})", joined)

    def shares(pattern):
        m = re.search(pattern + rf"\s+({NUM}) ({NUM}) ({NUM})", joined)
        return (m.group(1), _n(m.group(2)), _n(m.group(3))) if m else None

    ob = re.search(rf"OB Int\. Updated upto (\d{{2}}/\d{{2}}/\d{{4}})\s+({NUM}) ({NUM}) ({NUM})", joined)
    closing = re.search(rf"Closing Balance as on (\d{{2}}/\d{{2}}/\d{{4}})\s+({NUM}) ({NUM}) ({NUM})", joined)
    interest = re.search(rf"^Int\. Updated upto (\d{{2}}/\d{{2}}/\d{{4}})\s+({NUM}) ({NUM}) ({NUM})", joined, re.M)

    # A row starts with "Mon-YYYY DD-MM-YYYY CR|DR"; its text and amounts can wrap onto the next lines
    rows, cur = [], None
    for line in lines:
        m = ROW.match(line)
        if m:
            if cur:
                rows.append(cur)
            cur = {"wage_month": m.group(1), "date": _d(m.group(2)), "dr": m.group(3) == "DR", "text": m.group(4)}
        elif cur is not None:
            if line.startswith(("Total ", "Int. Updated", "Closing Balance")):
                rows.append(cur)
                cur = None
            elif line:
                cur["text"] += " " + line
    if cur:
        rows.append(cur)

    entries = []
    for r in rows:
        m = FIVE.search(r["text"])
        if not m:
            raise PassbookError(f"Couldn't read the amounts on the {r['wage_month']} line dated {r['date']}")
        employee, employer, pension = _n(m.group(3)), _n(m.group(4)), _n(m.group(5))
        desc = re.sub(r"\s+", " ", r["text"][:m.start()]).strip()
        upper = desc.upper()
        transfer = "TRANSFER" in upper or "PARA 57" in upper
        old = re.search(r"Old Member\s*Id-?\s*:?\s*(\w+)", desc, re.I)
        kind = ("transfer_out" if r["dr"] else "transfer_in") if transfer else ("withdrawal" if r["dr"] else "contribution")
        entries.append({"date": r["date"], "wage_month": r["wage_month"], "kind": kind, "employee": employee, "employer": employer,
                        "pension": pension, "amount": round(employee + employer, 2), "note": desc,
                        "counterpart": old.group(1).upper() if old else None})

    stmt = {"member_id": member.group(1).upper(), "name": member.group(2).strip(),
            "establishment": est.group(2).strip() if est else None, "uan": uan.group(1) if uan else None,
            "fy": f"{fy.group(1)}-{fy.group(2)[2:]}" if fy else None,
            "opening": {"date": _d(ob.group(1)), "employee": _n(ob.group(2)), "employer": _n(ob.group(3))} if ob else None,
            "interest": ({"date": _d(interest.group(1)), "employee": _n(interest.group(2)), "employer": _n(interest.group(3))}
                         if interest else None),
            "closing": {"date": _d(closing.group(1)), "employee": _n(closing.group(2)), "employer": _n(closing.group(3))} if closing else None,
            "entries": entries}
    stmt["check"] = _check(stmt)
    return stmt


def _check(s: dict) -> dict:
    """Opening + credits − debits + interest should equal the closing balance, per share."""
    out = {}
    for side in ("employee", "employer"):
        bal = (s["opening"] or {}).get(side, 0.0)
        for e in s["entries"]:
            bal += -e[side] if e["kind"] in ("withdrawal", "transfer_out") else e[side]
        bal += (s["interest"] or {}).get(side, 0.0)
        want = (s["closing"] or {}).get(side)
        out[side] = {"computed": round(bal, 2), "statement": want, "ok": want is None or abs(bal - want) < 1.5}
    out["ok"] = out["employee"]["ok"] and out["employer"]["ok"]
    return out


def plan(statements: list[dict]) -> dict:
    """Merge statements (any order, possibly several member IDs of one UAN) into ledger transactions."""
    uans = {s["uan"] for s in statements if s["uan"]}
    if len(uans) > 1:
        raise PassbookError("These passbooks belong to different UANs; import one UAN at a time")
    stmts = sorted(statements, key=lambda s: (s["opening"] or {}).get("date") or "")
    members = {s["member_id"] for s in stmts}
    seen_years = {(s["member_id"], s["fy"]) for s in stmts}
    if len(seen_years) != len(stmts):
        raise PassbookError("The same member ID and financial year was uploaded twice")
    txns, notes = [], []
    first_by_member = {}
    for s in stmts:
        first_by_member.setdefault(s["member_id"], s)
    for mid, s in first_by_member.items():
        ob = s["opening"] or {}
        amt = round(ob.get("employee", 0.0) + ob.get("employer", 0.0), 2)
        if amt > 0.5:  # earlier years weren't uploaded: start from the balance carried in
            txns.append({"date": ob["date"], "type": "BUY", "amount": amt, "kind": "opening", "member_id": mid,
                         "notes": f"Opening balance, FY {s['fy']} ({mid})"})
            notes.append(f"{mid}: statements before FY {s['fy']} weren't uploaded, so its ₹{amt:,.0f} opening balance counts as one contribution")
    for s in stmts:
        who = s["establishment"] or s["member_id"]
        for e in s["entries"]:
            if e["amount"] <= 0:
                continue
            if e["kind"] in ("transfer_in", "transfer_out"):
                other = e["counterpart"]
                internal = (other in members) if e["kind"] == "transfer_in" else bool(members - {s["member_id"]})
                if internal:
                    continue  # money moving between the uploaded accounts of this UAN
                txns.append({"date": e["date"], "type": "BUY" if e["kind"] == "transfer_in" else "SELL", "amount": e["amount"],
                             "kind": e["kind"], "member_id": s["member_id"], "notes": f"{e['note']} · {who}"[:300]})
                continue
            if e["kind"] == "contribution":
                txns.append({"date": e["date"], "type": "BUY", "amount": e["amount"], "kind": "contribution", "member_id": s["member_id"],
                             "notes": f"{e['wage_month']} contribution: employee ₹{e['employee']:,.0f} + employer ₹{e['employer']:,.0f} · {who}"})
            else:
                txns.append({"date": e["date"], "type": "SELL", "amount": e["amount"], "kind": "withdrawal", "member_id": s["member_id"],
                             "notes": f"Withdrawal: {e['note']} · {who}"[:300]})
        i = s["interest"] or {}
        amt = round(i.get("employee", 0.0) + i.get("employer", 0.0), 2)
        if amt > 0:
            txns.append({"date": i["date"], "type": "CREDIT", "amount": amt, "kind": "interest", "member_id": s["member_id"],
                         "notes": f"Interest for FY {s['fy']}: employee ₹{i['employee']:,.0f} + employer ₹{i['employer']:,.0f} · {who}"})
    order = {"opening": 0, "transfer_in": 1, "contribution": 2, "interest": 3, "withdrawal": 4, "transfer_out": 5}
    txns.sort(key=lambda t: (t["date"], order[t["kind"]]))
    # Where the money stands: latest closing balance of each member ID still open
    latest = {}
    for s in stmts:
        latest[s["member_id"]] = s
    balance = sum((s["closing"] or {}).get("employee", 0) + (s["closing"] or {}).get("employer", 0) for s in latest.values())
    return {"uan": next(iter(uans), None), "name": stmts[0]["name"] if stmts else None, "transactions": txns, "notes": notes,
            "closing_balance": round(balance, 2),
            "statements": [{"member_id": s["member_id"], "establishment": s["establishment"], "fy": s["fy"],
                            "entries": len(s["entries"]), "check": s["check"],
                            "closing": round((s["closing"] or {}).get("employee", 0) + (s["closing"] or {}).get("employer", 0), 2)}
                           for s in stmts]}
