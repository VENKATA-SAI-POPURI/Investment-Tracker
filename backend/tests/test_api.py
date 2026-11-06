from conftest import ADMIN, GUEST, OTHER, USER, auth


def buy(client, who, name="TCS", qty=10, amount=35000, date="2026-01-05", ac="equity", **extra):
    return client.post("/api/transactions", headers=who, json={
        "type": "BUY", "date": date, "quantity": qty, "amount": amount,
        "instrument": {"asset_class": ac, "name": name, "market": "India", "sector": "IT", **extra}})


def test_requires_auth(client):
    assert client.get("/api/portfolio").status_code == 401
    assert client.get("/api/ping").status_code == 200


def test_revoked_user_is_rejected(client, app):
    h = auth(USER, "user")
    assert client.get("/api/portfolio", headers=h).status_code == 200
    app.extensions["directory"].remove(USER)
    assert client.get("/api/portfolio", headers=h).status_code == 401


def test_buy_sell_and_oversell_validation(client):
    h = auth(USER, "user")
    r = buy(client, h)
    assert r.status_code == 201, r.json
    iid = r.json["instrument_id"]
    bad = client.post("/api/transactions", headers=h, json={"instrument_id": iid, "type": "SELL", "date": "2026-02-01",
                                                             "quantity": 11, "amount": 40000})
    assert bad.status_code == 400 and "held 10" in bad.json["error"]
    ok = client.post("/api/transactions", headers=h, json={"instrument_id": iid, "type": "SELL", "date": "2026-02-01",
                                                            "quantity": 4, "amount": 16000})
    assert ok.status_code == 201
    pos = next(p for p in client.get("/api/portfolio", headers=h).json["positions"] if p["id"] == iid)
    assert pos["quantity"] == 6 and pos["realized"] == 2000


def test_guest_is_read_only(client):
    assert buy(client, auth(GUEST, "guest")).status_code == 403


def test_users_only_see_their_own_data(client):
    buy(client, auth(USER, "user"), name="Infosys")
    assert client.get("/api/instruments", headers=auth(OTHER, "user")).json == []
    assert len(client.get("/api/instruments", headers=auth(ADMIN, "admin")).json) == 1
    assert len(client.get("/api/instruments", headers=auth(ADMIN, "admin", view_as=OTHER)).json) == 0


def test_mf_buy_creates_linked_capital_flow_that_follows_edits(client):
    h = auth(USER, "user")
    t = buy(client, h, name="Axis ELSS", ac="mutual_fund", qty=5, amount=500, category="ELSS").json
    flows = client.get("/api/cash?account=capital", headers=h).json
    assert len(flows) == 1 and flows[0]["amount"] == 500 and flows[0]["transaction_id"] == t["id"]
    client.put(f"/api/transactions/{t['id']}", headers=h, json={"amount": 750})
    assert client.get("/api/cash?account=capital", headers=h).json[0]["amount"] == 750
    client.delete(f"/api/transactions/{t['id']}", headers=h)
    assert client.get("/api/cash?account=capital", headers=h).json == []


def test_p2p_loan_repayment_and_escrow(client):
    h = auth(USER, "user")
    loan = client.post("/api/p2p/loans", headers=h, json={"name": "Borrower", "ref2": "LOA-1", "date": "2026-01-01",
                                                          "amount": 1000, "tenure_months": 3, "rate": 40}).json
    assert loan["ref"] == "P2P-001" and loan["maturity_date"] == "2026-04-05"
    r = client.post("/api/transactions", headers=h, json={"instrument_id": loan["id"], "type": "REPAYMENT",
                                                           "date": "2026-02-05", "amount": 360, "principal": 330})
    assert r.status_code == 201
    pos = next(p for p in client.get("/api/portfolio", headers=h).json["positions"] if p["id"] == loan["id"])
    assert pos["outstanding"] == 670 and pos["interest"] == 30
    escrow = client.get("/api/cash?account=p2p_escrow", headers=h).json
    assert len(escrow) == 1 and escrow[0]["kind"] == "Deposit"


def test_settings_validation(client):
    h = auth(ADMIN, "admin")
    bad = client.put("/api/settings/targetAllocation", headers=h, json={"value": {"Equity (India)": 50}})
    assert bad.status_code == 400
    ok = client.put("/api/settings/targetAllocation", headers=h,
                    json={"value": {"Equity (India)": 60, "Mutual Funds": 40}})
    assert ok.status_code == 200
    assert client.get("/api/settings", headers=h).json["targetAllocation"]["Mutual Funds"] == 40


def test_tax_insights_and_goals_endpoints(client):
    h = auth(USER, "user")
    buy(client, h)
    assert client.get("/api/tax", headers=h).status_code == 200
    assert "insights" in client.get("/api/insights?performance=0", headers=h).json
    g = client.post("/api/goals", headers=h, json={"name": "House", "target_amount": 2000000,
                                                   "target_date": "2032-01-01", "monthly_contribution": 10000,
                                                   "allocation": {"Equity (India)": 100}})
    assert g.status_code == 201 and g.json[0]["projection"]["current"] == 35000


def test_csv_import_preview_and_commit(client):
    h = auth(USER, "user")
    csv = ("date,type,asset_class,name,symbol,quantity,amount\n"
           "2026-01-02,BUY,equity,HDFC Bank,HDFCBANK.NS,5,8000\n"
           "2026-01-03,SELL,equity,HDFC Bank,HDFCBANK.NS,2,3300\n")
    prev = client.post("/api/transactions/import/preview", headers=h, json={"csv": csv}).json
    assert len(prev["rows"]) == 2 and not prev["errors"]
    res = client.post("/api/transactions/import/commit", headers=h, json={"rows": prev["rows"]}).json
    assert res["imported"] == 2
    again = client.post("/api/transactions/import/preview", headers=h, json={"csv": csv}).json
    assert all(r["duplicate"] for r in again["rows"])


def test_family_switcher_scopes_reads_and_writes(client):
    me, other = auth(ADMIN, "admin"), auth(OTHER, "user")
    buy(client, other, name="INFY")
    as_member = {**me, "X-Portfolio": OTHER}
    names = [p["name"] for p in client.get("/api/portfolio", headers=as_member).json["positions"]]
    assert names == ["INFY"]
    # a purchase made while a member is selected belongs to that member
    assert buy(client, as_member, name="HDFC Bank").status_code == 201
    mine = client.get("/api/portfolio", headers=other).json["positions"]
    assert sorted(p["name"] for p in mine) == ["HDFC Bank", "INFY"]
    fam = client.get("/api/portfolios", headers=me).json
    assert fam["family"] and fam["members"][0]["self"]
    assert client.get("/api/portfolios", headers=other).json["family"] is False
    # members cannot widen their own scope
    assert len(client.get("/api/portfolio", headers={**other, "X-Portfolio": "family"}).json["positions"]) == 2


def test_reports_render_and_export(client):
    h = auth(USER, "user")
    buy(client, h)
    client.post("/api/transactions", headers=h, json={"type": "BUY", "date": "2026-01-10", "amount": 5000,
                                                      "instrument": {"asset_class": "epf", "name": "EPF"}})
    cat = client.get("/api/reports", headers=h).json
    assert {r["key"] for r in cat["reports"]} >= {"summary", "capital_gains", "schedule_112a", "income", "cashflow"}
    for key in ("summary", "holdings", "xirr", "statement", "transactions", "income", "unrealised", "capital_gains"):
        r = client.get(f"/api/reports/{key}", headers=h)
        assert r.status_code == 200, (key, r.json)
        assert r.json["columns"] and "rows" in r.json
    xl = client.get("/api/reports/holdings/export.xlsx", headers=h)
    assert xl.status_code == 200 and xl.data[:2] == b"PK"


def test_notifications_endpoint(client):
    h = auth(USER, "user")
    buy(client, h)
    r = client.get("/api/notifications", headers=h)
    assert r.status_code == 200 and isinstance(r.json["items"], list)


def _xlsx(blocks: list[list[tuple]]) -> str:
    """A workbook with one sheet per block, base64-encoded the way the frontend uploads it."""
    import base64
    import io
    import openpyxl
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for i, rows in enumerate(blocks):
        ws = wb.create_sheet(f"S{i}")
        for r in rows:
            ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    return base64.b64encode(buf.getvalue()).decode()


ORDER_HDR = ("Order ID", "Loan ID", "Lending Type", "Interest Rate (%)", "Tenure (months)", "Loan Order Amount (₹)",
             "Repayment Type", "LenDenClub Score", "Order Date", "Disbursement Date", "Disbursed Amount (₹)",
             "Cancellation Date", "Cancelled Amount (₹)", "Loan Status", "Platform Fee (₹)")
LOAN_HDR = ("Lending Type", "Product", "Order ID", "Loan ID", "Repayment Type", "Disbursement Date", "Repayment Start Date",
            "Invested Amount (₹)", "Interest Rate (%p.a.)", "Tenure (in months)", "LDC Score", "Loan Status", "DPD",
            "Total Received (₹)", "Principal Received (₹)", "Interest Received (₹)", "NPA Recovery (₹)", "Platform Fee (₹)",
            "Recovery Fees (₹)", "Recovery Expenses (₹)", "Net Received  (sent to bank) (₹)", "Absolute Return (%)",
            "Annualised Net Return (%)", "Principal Outstanding (₹)", "NPA (₹)", "Closure / NPA Date")


def _investment_report(loans):
    head = [("Investment report",), (), ("Period summary",), ("From Date", "01/01/2026"), ("To Date", "10/04/2026"),
            ("Disbursed/ invested amount", sum(l[7] for l in loans)), ()]
    return [[("Order Level Summary",), ("Lending Type", "Order ID")], head + [LOAN_HDR, *loans]]


def test_lenden_reports_reconcile_on_net_cash(client):
    h = auth(USER, "user")
    loan = client.post("/api/p2p/loans", headers=h, json={"ref2": "LOA-A", "date": "2026-01-02", "amount": 1000,
                                                          "tenure_months": 3}).json
    # One EMI already recorded the app's way: cash to the bank (after the ₹3 fee), fee kept for reference
    client.post("/api/transactions", headers=h, json={"instrument_id": loan["id"], "type": "REPAYMENT", "date": "2026-02-01",
                                                       "amount": 360, "principal": 333.33, "fees": 3})
    order = [("Lender Details",), ("From Date", "01/01/2026"), ("To Date", "10/04/2026"), ("Order Amount", "₹1500.0"), (),
             ORDER_HDR,
             ("11", "LOA-A", "MANUAL_LENDING", 40, 3, 1000, "MONTHLY", 750, "02/01/2026", "02/01/2026", 1000, None, 0, "DISBURSED", 0),
             ("22", "LOA-B", "LUMPSUM", 36, 2, 500, "MONTHLY", 780, "05/03/2026", "05/03/2026", 500, None, 0, "DISBURSED", 0),
             ("22", "LOA-C", "LUMPSUM", 36, 2, 500, "MONTHLY", 780, "05/03/2026", "05/03/2026", 0, "06/03/2026", 500, "CANCELLED", 0)]
    report = _investment_report([
        ("Manual", "Personal Loan", "11", "LOA-A", "Monthly", "02/01/2026", "01/02/2026", 1000, 40, 3, 750, "CLOSED", "0",
         1090, 1000, 90, 0, 9, 0, 0, 1081, 8.1, 40, 0, 0, "01/04/2026"),
        ("Lumpsum", "Personal Loan", "22", "LOA-B", "Monthly", "05/03/2026", "01/04/2026", 500, 36, 2, 780, "ACTIVE", "1-30",
         265, 250, 15, 0, 2, 0, 0, 263, "—", "—", 250, 0, "—")])
    files = [{"name": "order.xlsx", "file_data": _xlsx([order])}, {"name": "report.xlsx", "file_data": _xlsx(report)}]
    pv = client.post("/api/p2p/import/preview", headers=h, json={"files": files})
    assert pv.status_code == 200, pv.json
    p = pv.json
    assert [f["kind"] for f in p["files"]] == ["order_report", "investment_report"]
    assert p["files"][1]["summary"]["invested"] == 1500 and p["review"] == []
    # LOA-A: the rest of the loan, measured on net cash (1081 − 360), dated on closure
    (rp,) = p["repayments"]
    assert (rp["loan_id"], rp["date"], rp["amount"], rp["principal"], rp["fees"]) == ("LOA-A", "2026-04-01", 721, 666.67, 6)
    assert [(s["loan_id"], s["new_status"]) for s in p["status_changes"]] == [("LOA-A", "closed")]
    # LOA-B is new (LOA-C was cancelled): created with its receipts so far, on the latest EMI date
    (nl,) = p["new_loans"]
    assert nl["loan_id"] == "LOA-B" and nl["lending_type"] == "Lumpsum" and nl["order_id"] == "22"
    assert nl["repayment"]["date"] == "2026-04-01" and nl["repayment"]["amount"] == 263 and nl["maturity_date"] == "2026-05-01"
    assert p["overdue"] == [] and p["details"][0]["fields"]["category"] == "Manual"

    done = client.post("/api/p2p/import/commit", headers=h, json=p).json
    assert done == {"loans_added": 1, "repayments": 1, "status_updated": 1, "details_filled": 1, "errors": []}
    pos = {x["ref2"]: x for x in client.get("/api/portfolio", headers=h).json["positions"] if x["asset_class"] == "p2p"}
    a, b = pos["LOA-A"], pos["LOA-B"]
    assert a["status"] == "closed" and a["principal_repaid"] == 1000 and a["interest"] == 81 and a["category"] == "Manual"
    assert b["outstanding"] == 250 and b["interest"] == 13 and b["sub_category"] == "22"
    # Importing the same files again finds nothing left to do
    again = client.post("/api/p2p/import/preview", headers=h, json={"files": files}).json
    assert not (again["new_loans"] or again["repayments"] or again["status_changes"] or again["details"])
    assert again["overdue"] == [{"loan_id": "LOA-B", "ref": "P2P-002", "dpd": "1-30"}]


def test_lenden_flags_reports_showing_less_than_recorded(client):
    h = auth(USER, "user")
    loan = client.post("/api/p2p/loans", headers=h, json={"ref2": "LOA-A", "date": "2026-01-02", "amount": 1000,
                                                          "tenure_months": 3}).json
    client.post("/api/transactions", headers=h, json={"instrument_id": loan["id"], "type": "REPAYMENT", "date": "2026-02-01",
                                                       "amount": 700, "principal": 600})
    report = _investment_report([("Manual", "Personal Loan", "11", "LOA-A", "Monthly", "02/01/2026", "01/02/2026", 1000, 40,
                                  3, 750, "ACTIVE", "0", 400, 333, 67, 0, 3, 0, 0, 397, "—", "—", 667, 0, "—")])
    p = client.post("/api/p2p/import/preview", headers=h, json={"files": [{"name": "r.xlsx", "file_data": _xlsx(report)}]}).json
    assert p["repayments"] == [] and len(p["review"]) == 1 and "less received" in p["review"][0]["message"]
    bad = client.post("/api/p2p/import/preview", headers=h, json={"files": [{"name": "x.xlsx", "file_data": _xlsx([[("hello",)]])}]})
    assert bad.status_code == 400 and "x.xlsx" in bad.json["error"]
