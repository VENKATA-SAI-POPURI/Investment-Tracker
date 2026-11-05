import base64
import re
from collections import defaultdict
from datetime import date

from flask import Blueprint, current_app, g, jsonify, request

from .. import domain as d
from .. import prices as px
from ..analytics.portfolio import run_fifo
from ..importers import cas_import, csv_import, lenden
from ..ledger import ValidationError
from ..security import write_required

bp = Blueprint("ledger", __name__)


def L():
    return current_app.extensions["ledger"]


def S():
    return current_app.extensions["services"]


def body() -> dict:
    return request.get_json(silent=True) or {}


# ── instruments ──

@bp.get("/instruments")
def list_instruments():
    rows = L().load(g.scope)["instruments"]
    ac = request.args.get("asset_class")
    return jsonify([r for r in rows if not ac or r["asset_class"] == ac])


@bp.post("/instruments")
@write_required
def create_instrument():
    return jsonify(L().create_instrument(g.owner, body())), 201


@bp.put("/instruments/<int:iid>")
@write_required
def update_instrument(iid):
    return jsonify(L().update_instrument(iid, g.scope, body()))


@bp.delete("/instruments/<int:iid>")
@write_required
def delete_instrument(iid):
    L().delete_instrument(iid, g.scope)
    return jsonify({"message": "Deleted with all its transactions"})


@bp.get("/suggestions")
def suggestions():
    """Distinct names + metadata for autocomplete (no amounts)."""
    rows = L().load(g.scope)["instruments"]
    out = defaultdict(list)
    for r in rows:
        if r["asset_class"] in d.UNITISED + (d.EPF,):
            out[r["asset_class"]].append({k: r.get(k) for k in ("id", "name", "symbol", "market", "sector", "market_cap",
                                                                 "category", "sub_category")})
    out["sectors"] = sorted({r["sector"] for r in rows if r.get("sector")})
    out["platforms"] = sorted({r["platform"] for r in rows if r.get("platform")})
    return jsonify(out)


# ── transactions ──

@bp.get("/transactions")
def list_transactions():
    data = L().load(g.scope)
    inst = {i["id"]: i for i in data["instruments"]}
    a = request.args
    out = []
    for t in data["transactions"]:
        i = inst.get(t["instrument_id"])
        if not i:
            continue
        if a.get("asset_class") and i["asset_class"] != a["asset_class"]:
            continue
        if a.get("instrument_id") and str(t["instrument_id"]) != a["instrument_id"]:
            continue
        if a.get("type") and t["type"] != a["type"]:
            continue
        if a.get("from") and t["date"] < a["from"]:
            continue
        if a.get("to") and t["date"] > a["to"]:
            continue
        out.append({**t, "instrument_name": i["name"], "asset_class": i["asset_class"], "segment": d.segment_of(i),
                    "currency": i.get("currency")})
    out.sort(key=lambda t: (t["date"], t["id"]), reverse=True)
    return jsonify(out)


@bp.post("/transactions")
@write_required
def add_transaction():
    data = body()
    iid = data.get("instrument_id")
    if not iid:
        spec = data.get("instrument") or {}
        if not spec.get("name") or spec.get("asset_class") not in d.TRADABLE + (d.CASH, d.EPF, d.NPS):
            raise ValidationError("Choose an existing holding or give the new holding's name and type")
        iid = L().find_or_create_instrument(g.owner, spec["asset_class"], spec["name"], spec)["id"]
    return jsonify(L().add_transaction(g.owner, g.scope, int(iid), data)), 201


@bp.put("/transactions/<int:tid>")
@write_required
def update_transaction(tid):
    return jsonify(L().update_transaction(tid, g.scope, body()))


@bp.delete("/transactions/<int:tid>")
@write_required
def delete_transaction(tid):
    L().delete_transaction(tid, g.scope)
    return jsonify({"message": "Transaction deleted"})


@bp.post("/transactions/import/preview")
@write_required
def import_preview():
    text = body().get("csv") or ""
    try:
        parsed = csv_import.parse(text)
    except ValueError as e:
        raise ValidationError(str(e))
    data = L().load(g.scope)
    existing = {(i["asset_class"], i["name"].lower()): i for i in data["instruments"]}
    seen = {(t["instrument_id"], t["date"], t["type"], round(t["quantity"] or 0, 4), round(t["amount"] or 0, 2))
            for t in data["transactions"]}
    for r in parsed["rows"]:
        inst = existing.get((r["asset_class"], r["name"].lower()))
        r["instrument_id"] = inst["id"] if inst else None
        r["new_instrument"] = inst is None
        r["duplicate"] = bool(inst) and (inst["id"], r["date"], r["type"], round(r["quantity"] or 0, 4),
                                         round(r["amount"] or 0, 2)) in seen
        r["selected"] = not r["duplicate"]
    return jsonify(parsed)


@bp.post("/transactions/import/commit")
@write_required
def import_commit():
    results = []
    rows = sorted(body().get("rows") or [], key=lambda r: (r.get("date") or "", 0 if r.get("type") == d.BUY else 1))
    for r in rows:
        try:
            spec = {k: r.get(k) for k in ("name", "symbol", "market", "sector", "market_cap", "category")}
            inst = L().find_or_create_instrument(g.owner, r["asset_class"], r["name"], spec)
            t = L().add_transaction(g.owner, g.scope, inst["id"], r, source="import:csv")
            results.append({"name": r["name"], "date": r["date"], "ok": True, "id": t["id"]})
        except (ValidationError, KeyError) as e:
            results.append({"name": r.get("name"), "date": r.get("date"), "ok": False, "error": str(e)})
    return jsonify({"results": results, "imported": sum(1 for x in results if x["ok"])})


# ── CAS (consolidated account statement) import ──

def _cas_key(t: dict) -> tuple:
    return (str(t["date"])[:10], t["type"], round(float(t.get("quantity") or 0), 3))


def _match_fund(f: dict, funds: list[dict]) -> dict | None:
    if f.get("amfi"):
        hit = next((i for i in funds if (i.get("symbol") or "").upper() == f"AMFI:{f['amfi']}"), None)
        if hit:
            return hit
    n = cas_import.norm_name(f["name"])
    return next((i for i in funds if cas_import.norm_name(i["name"]) == n), None)


@bp.post("/import/cas/preview")
@write_required
def cas_preview():
    data = body()
    try:
        pdf = base64.b64decode((data.get("file") or "").split(",")[-1])
        parsed = cas_import.parse(pdf, (data.get("password") or "").strip())
    except cas_import.CasError as e:
        raise ValidationError(str(e))
    ledger = L().load(g.scope)
    by_inst = defaultdict(list)
    for t in ledger["transactions"]:
        by_inst[t["instrument_id"]].append(t)
    funds = [i for i in ledger["instruments"] if i["asset_class"] == d.MUTUAL_FUND]
    for f in parsed["funds"]:
        inst = _match_fund(f, funds)
        have = {_cas_key(t) for t in by_inst.get(inst["id"], [])} if inst else set()
        for t in f["transactions"]:
            t["duplicate"] = _cas_key(t) in have
        f["matched_id"], f["matched_name"] = (inst["id"], inst["name"]) if inst else (None, None)
        f["new_count"] = sum(1 for t in f["transactions"] if not t["duplicate"])
        f["duplicate_count"] = len(f["transactions"]) - f["new_count"]
        f["selected"] = f["new_count"] > 0
    nps = [i for i in ledger["instruments"] if i["asset_class"] == d.NPS]
    for n in parsed["nps"]:
        hit = next((i for i in nps if cas_import.norm_name(i["name"]) == cas_import.norm_name(n["name"])), None)
        n["matched_id"], n["action"] = (hit["id"], "update_nav") if hit else (None, "create")
        n["selected"] = True
    port, _ = S().portfolio(g.scope, S().settings())
    held = [p for p in port["positions"] if p["asset_class"] in d.UNITISED and p.get("is_open")]
    for h in parsed["demat"]:
        sym = (h.get("symbol") or "").upper()
        hit = next((p for p in held if sym and (p.get("symbol") or "").upper().split(".")[0] == sym), None) or             next((p for p in held if cas_import.norm_name(p["name"]) == cas_import.norm_name(h["name"] or "")), None)
        h["app_units"] = hit["quantity"] if hit else None
        h["app_name"] = hit["name"] if hit else None
        h["status"] = "missing" if not hit else ("match" if abs((hit["quantity"] or 0) - h["units"]) < 1e-3 else "differs")
    return jsonify(parsed)


@bp.post("/import/cas/commit")
@write_required
def cas_commit():
    data = body()
    results = []
    for f in data.get("funds") or []:
        try:
            if f.get("matched_id"):
                inst = L().instrument(int(f["matched_id"]), g.scope)
            else:
                spec = {"symbol": f"AMFI:{f['amfi']}" if f.get("amfi") else None, "category": f.get("category"),
                        "platform": f.get("amc"), "notes": f"Folio {f.get('folio')}" if f.get("folio") else None}
                inst = L().find_or_create_instrument(g.owner, d.MUTUAL_FUND, f["name"], {k: v for k, v in spec.items() if v})
            existing = L().db.query("SELECT * FROM transactions WHERE instrument_id = ?", (inst["id"],))
            have = {_cas_key(t) for t in existing}
            new = [t for t in f.get("transactions") or [] if _cas_key(t) not in have]
            if not new:
                results.append({"name": f["name"], "ok": True, "imported": 0})
                continue
            # check units never go negative before writing anything for this fund
            _, _, unmatched = run_fifo(inst["id"], existing + [{**t, "id": 10**9 + n} for n, t in enumerate(new)])
            if unmatched > 1e-6:
                raise ValidationError(f"redemptions exceed purchases by {unmatched:g} units; import the full-history (detailed) CAS")
            entries = [{"instrument": inst, "txn": {k: t.get(k) for k in ("date", "type", "quantity", "amount", "notes")},
                        "source": "import:cas"} for t in new]
            L().bulk_add(inst["owner"], entries, check_holdings=False)
            results.append({"name": f["name"], "ok": True, "imported": len(new)})
        except (ValidationError, KeyError, LookupError) as e:
            results.append({"name": f.get("name"), "ok": False, "error": str(e)})
    for n in data.get("nps") or []:
        try:
            if n.get("matched_id"):
                L().update_instrument(int(n["matched_id"]), g.scope, {"last_price": n.get("nav")})
                results.append({"name": n["name"], "ok": True, "imported": 0, "updated": "NAV"})
                continue
            inst = L().create_instrument(g.owner, {"asset_class": d.NPS, "name": n["name"], "platform": n.get("fund_manager"),
                                                   "ref": n.get("pran"), "category": n.get("tier")})
            if n.get("nav"):
                L().update_instrument(inst["id"], g.scope, {"last_price": n["nav"]})
            if n.get("units"):
                L().add_transaction(g.owner, g.scope, inst["id"], {
                    "date": data.get("as_of") or date.today().isoformat(), "type": d.BUY, "quantity": n["units"], "amount": n.get("value") or 0,
                    "notes": "Opening balance from NSDL CAS at market value; replace with your contributions for accurate returns"},
                    source="import:cas")
            results.append({"name": n["name"], "ok": True, "imported": 1})
        except (ValidationError, KeyError, LookupError) as e:
            results.append({"name": n.get("name"), "ok": False, "error": str(e)})
    return jsonify({"results": results, "imported": sum(r.get("imported", 0) for r in results if r["ok"])})


# ── cash movements (capital flows & P2P escrow) ──

@bp.get("/cash")
def list_cash():
    rows = L().load(g.scope)["cash_movements"]
    acct = request.args.get("account")
    return jsonify(sorted([r for r in rows if not acct or r["account"] == acct], key=lambda r: (r["date"], r["id"]), reverse=True))


@bp.post("/cash")
@write_required
def add_cash():
    return jsonify(L().add_cash(g.owner, body())), 201


@bp.put("/cash/<int:cid>")
@write_required
def update_cash(cid):
    return jsonify(L().update_cash(cid, g.scope, body()))


@bp.delete("/cash/<int:cid>")
@write_required
def delete_cash(cid):
    L().delete_cash(cid, g.scope)
    return jsonify({"message": "Deleted"})


# ── P2P ──

def _next_lending_number(instruments) -> int:
    nums = [int(m.group(1)) for i in instruments if i["asset_class"] == d.P2P
            for m in [re.match(r"P2P-(\d+)", i.get("ref") or "")] if m]
    return max(nums, default=0)


@bp.post("/p2p/loans")
@write_required
def add_loan():
    data = body()
    insts = L().load(g.scope)["instruments"]
    ref = (data.get("ref") or "").strip() or f"P2P-{str(_next_lending_number(insts) + 1).zfill(3)}"
    loan_id = (data.get("ref2") or "").strip().upper() or None
    if loan_id and any(i.get("ref2") == loan_id and i["asset_class"] == d.P2P for i in insts):
        raise ValidationError(f"Loan {loan_id} already exists")
    maturity = data.get("maturity_date") or lenden.maturity_from(data.get("date"), int(float(data.get("tenure_months") or 0)))
    inst = L().create_instrument(g.owner, {
        "asset_class": d.P2P, "name": data.get("name") or loan_id or ref, "platform": data.get("platform") or "LenDen",
        "ref": ref, "ref2": loan_id, "rate": data.get("rate"), "tenure_months": data.get("tenure_months"),
        "maturity_date": maturity, "status": data.get("status") or "active", "notes": data.get("notes"),
        "tax_class": d.TAX_INCOME})
    try:
        L().add_transaction(g.owner, g.scope, inst["id"], {"type": d.BUY, "date": data.get("date"), "amount": data.get("amount")})
    except ValidationError:
        L().delete_instrument(inst["id"], g.scope)
        raise
    return jsonify(inst), 201


def _file_bytes() -> bytes:
    raw = body().get("file_data")
    if not raw:
        raise ValidationError("No file uploaded")
    try:
        return base64.b64decode(raw)
    except (ValueError, TypeError):
        raise ValidationError("Invalid file data")


def _read_xlsx() -> list:
    try:
        return lenden.read_rows(_file_bytes())
    except ValidationError:
        raise
    except Exception as e:  # noqa: BLE001
        raise ValidationError(f"Could not read the Excel file: {e}")


@bp.post("/p2p/import/order-report/preview")
@write_required
def order_report_preview():
    insts = L().load(g.scope)["instruments"]
    existing = {(i.get("ref2") or "").upper() for i in insts if i["asset_class"] == d.P2P}
    try:
        return jsonify(lenden.parse_order_report(_read_xlsx(), existing, _next_lending_number(insts)))
    except ValueError as e:
        raise ValidationError(str(e))


@bp.post("/p2p/import/order-report/commit")
@write_required
def order_report_commit():
    insts = L().load(g.scope)["instruments"]
    existing = {(i.get("ref2") or "").upper() for i in insts if i["asset_class"] == d.P2P}
    used_refs = {i.get("ref") for i in insts if i["asset_class"] == d.P2P}
    number = _next_lending_number(insts)
    entries, results = [], []
    for r in body().get("rows") or []:
        loan_id = (r.get("loan_id") or "").strip().upper()
        if not loan_id or loan_id in existing:
            results.append({"loan_id": loan_id, "ok": False, "error": "already exists" if loan_id else "missing loan id"})
            continue
        ref = r.get("lending_id")
        if not ref or ref in used_refs:
            number += 1
            ref = f"P2P-{str(number).zfill(3)}"
        used_refs.add(ref)
        existing.add(loan_id)
        entries.append({"new_instrument": {
            "asset_class": d.P2P, "name": (r.get("name") or loan_id).strip(), "platform": r.get("platform") or "LenDen",
            "ref": ref, "ref2": loan_id, "rate": r.get("rate"), "tenure_months": r.get("tenure"),
            "maturity_date": r.get("maturity_date"), "status": r.get("status") or "active", "notes": r.get("notes"),
            "tax_class": d.TAX_INCOME},
            "txn": {"type": d.BUY, "date": r.get("date"), "amount": r.get("amount")}, "source": "import:lenden"})
        results.append({"loan_id": loan_id, "ok": True, "lending_id": ref})
    L().bulk_add(g.owner, entries)
    return jsonify({"results": results, "imported": len(entries)})


@bp.post("/p2p/import/statement/preview")
@write_required
def statement_preview():
    port, data = S().portfolio(g.scope, S().settings())
    loans = {(p.get("ref2") or "").upper(): p for p in port["positions"] if p["asset_class"] == d.P2P and p.get("ref2")}
    posted = defaultdict(lambda: {"principal": 0.0, "interest": 0.0, "fees": 0.0})
    for t in data["transactions"]:
        if t["type"] == d.REPAYMENT:
            p = float(t["principal"] or 0)
            posted[t["instrument_id"]]["principal"] += p
            posted[t["instrument_id"]]["interest"] += float(t["amount"] or 0) - p
            posted[t["instrument_id"]]["fees"] += float(t["fees"] or 0)
    try:
        return jsonify(lenden.parse_statement(_read_xlsx(), loans, posted))
    except ValueError as e:
        raise ValidationError(str(e))


@bp.post("/p2p/import/statement/commit")
@write_required
def statement_commit():
    payload = body()
    loans = {i["id"]: i for i in L().load(g.scope)["instruments"] if i["asset_class"] == d.P2P}
    entries, results = [], []
    for r in payload.get("rows") or []:
        inst = loans.get(int(r.get("instrument_id") or 0))
        dp, di, df = float(r.get("delta_principal") or 0), float(r.get("delta_interest") or 0), float(r.get("delta_fee") or 0)
        if not inst:
            results.append({"loan_id": r.get("loan_id"), "ok": False, "error": "loan not found"})
        elif dp < 0 or di < 0:
            results.append({"loan_id": r.get("loan_id"), "ok": False,
                            "error": "statement shows less than already recorded — review this loan manually"})
        elif dp or di or df:
            entries.append({"instrument": inst, "source": "import:lenden",
                            "txn": {"type": d.REPAYMENT, "date": r.get("date"), "amount": round(dp + di, 4),
                                    "principal": dp, "fees": max(df, 0), "notes": f"LenDen statement as on {r.get('date')}"}})
            results.append({"loan_id": r.get("loan_id"), "ok": True})
    updates = [(int(u["instrument_id"]), u["new_status"]) for u in payload.get("status_updates") or []
               if int(u.get("instrument_id") or 0) in loans and u.get("new_status")]
    L().bulk_add(g.owner, entries, updates)
    return jsonify({"results": results, "imported": len(entries), "status_updated": len(updates)})


# ── fixed deposits ──

@bp.post("/fixed-deposits")
@write_required
def add_fd():
    data = body()
    inst = L().create_instrument(g.owner, {
        "asset_class": d.FIXED_DEPOSIT, "name": data.get("name") or data.get("bank"), "platform": data.get("platform"),
        "rate": data.get("rate"), "maturity_date": data.get("maturity_date"), "ref2": data.get("ref2"),
        "notes": data.get("notes"), "tax_class": d.TAX_INCOME})
    try:
        L().add_transaction(g.owner, g.scope, inst["id"], {"type": d.BUY, "date": data.get("date"), "amount": data.get("amount")})
    except ValidationError:
        L().delete_instrument(inst["id"], g.scope)
        raise
    return jsonify(inst), 201


@bp.post("/fixed-deposits/<int:iid>/mature")
@write_required
def mature_fd(iid):
    data = body()
    inst = L().instrument(iid, g.scope)
    principal = sum(float(t["amount"]) for t in L().load(g.scope)["transactions"]
                    if t["instrument_id"] == iid and t["type"] == d.BUY)
    L().add_transaction(g.owner, g.scope, inst["id"], {"type": d.MATURITY, "date": data.get("date") or inst.get("maturity_date"),
                                                        "amount": data.get("amount"), "principal": principal})
    return jsonify({"message": "FD closed"})


# ── forex wallet ──

@bp.post("/forex")
@write_required
def add_forex():
    data = body()
    wallet = L().find_or_create_instrument(g.owner, d.CASH, "USD Wallet",
                                           {"market": "USA", "currency": "USD", "tax_class": d.TAX_INCOME})
    typ = d.FX_OUT if (data.get("type") or "").upper() in ("FX_OUT", "WITHDRAWAL") else d.FX_IN
    return jsonify(L().add_transaction(g.owner, g.scope, wallet["id"], {**data, "type": typ})), 201


# ── market data ──

@bp.post("/prices/refresh")
def refresh_prices():
    return jsonify(S().refresh_prices(g.scope, force=bool(body().get("force"))))


@bp.get("/prices/status")
def prices_status():
    return jsonify(S().prices_status())


@bp.get("/symbols/search")
def symbol_search():
    return jsonify(px.search_symbols(request.args.get("q", ""), request.args.get("asset_class")))
