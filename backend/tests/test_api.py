import base64

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
    assert {r["key"] for r in cat["reports"]} == {"summary", "holdings", "performance", "capital_gains", "schedule_112a", "income", "transactions"}
    for key in ("summary", "holdings", "transactions", "income", "capital_gains", "schedule_112a"):
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


SHARED_READS = ("/api/insights", "/api/pulse", "/api/notifications", "/api/brief", "/api/portfolio", "/api/tax")


def test_shared_context_builds_the_portfolio_once_per_write(client, offline_prices, monkeypatch):
    import tracker.services as services
    calls = []
    real = services.compute_portfolio
    monkeypatch.setattr(services, "compute_portfolio", lambda *a, **k: calls.append(1) or real(*a, **k))
    h = auth(USER, "user")
    assert buy(client, h, symbol="TCS.NS").status_code == 201
    for path in SHARED_READS:
        assert client.get(path, headers=h).status_code == 200, path
    assert len(calls) == 1
    assert buy(client, h, name="Infosys", symbol="INFY.NS").status_code == 201  # a write invalidates once
    for path in SHARED_READS:
        assert client.get(path, headers=h).status_code == 200, path
    assert len(calls) == 2
    assert client.get("/api/brief", headers=h).status_code == 200   # A5: a warm /brief builds nothing
    assert len(calls) == 2


def test_portfolio_response_is_a_copy_and_tax_keeps_realised_lots(client):
    h = auth(USER, "user")
    iid = buy(client, h, date="2026-05-04").json["instrument_id"]
    sell = client.post("/api/transactions", headers=h, json={"instrument_id": iid, "type": "SELL", "date": "2026-06-01",
                                                              "quantity": 4, "amount": 16000})
    assert sell.status_code == 201
    first = client.get("/api/tax", headers=h).json
    port = client.get("/api/portfolio", headers=h).json
    assert "realized_lots" not in port and port["positions"]
    again = client.get("/api/tax", headers=h).json
    assert again["realized"] and again["realized"] == first["realized"]
    assert again["total_realized"] == 2000 and again["fy"] in again["years"]
    assert client.get("/api/tax?fy=FY2025-26", headers=h).json["realized"] == []


def test_peek_reads_the_memo_without_building_it(app, client, offline_prices):
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    svc = app.extensions["services"]
    assert svc.peek_performance(USER) is None
    assert client.get("/api/performance", headers=h).status_code == 200
    assert svc.peek_performance(USER) is not None
    buy(client, h, name="Infosys", symbol="INFY.NS")  # a ledger write makes the entry stale
    assert svc.peek_performance(USER) is None


def test_ipo_notification_links_to_the_watchlist(client):
    from datetime import date, timedelta
    h = auth(USER, "user")
    soon = (date.today() + timedelta(days=2)).isoformat()
    assert client.post("/api/ipos", headers=h, json={"name": "Acme Ltd", "open_date": soon}).status_code == 201
    items = client.get("/api/notifications", headers=h).json["items"]
    (ipo,) = [n for n in items if n["kind"] == "ipo"]
    assert ipo["link"] == "/markets?tab=watchlist" and ipo["days"] == 2 and "in 2 days" in ipo["title"]


def test_refresh_stores_the_nifty_quote_and_keeps_it_on_failure(app, client, monkeypatch):
    import json
    from tracker import prices as px
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    seen = []

    def quotes(syms, timeout=15):
        seen.append(list(syms))
        return {s: ({"price": 24100.0, "prev_close": 24000.0, "date": "2026-11-13"} if s == "^NSEI" else
                    {"price": 3600.0, "prev_close": 3550.0} if s == "TCS.NS" else None) for s in syms}
    monkeypatch.setattr(px, "fetch_quotes", quotes)
    svc, ledger = app.extensions["services"], app.extensions["ledger"]
    res = svc.refresh_prices(USER, force=True)
    assert "^NSEI" in seen[0] and "TCS.NS" in seen[0] and len(seen) == 1   # one batch
    assert res["failed"] == [] and res["updated"] == 1                     # the index is not a holding
    assert json.loads(ledger.system_value("quote:^NSEI")) == {"price": 24100.0, "prev_close": 24000.0, "date": "2026-11-13"}
    stamp = ledger.system_value("prices:last_refresh")
    ledger.set_system_value("prices:last_refresh", "2026-01-01T00:00:00+00:00")
    monkeypatch.setattr(px, "fetch_quotes", lambda syms, timeout=15: {s: None for s in syms})
    res = svc.refresh_prices(USER, force=True)
    assert json.loads(ledger.system_value("quote:^NSEI"))["price"] == 24100.0
    # an outage (no holding quote came back) does not stamp prices as refreshed
    assert stamp and ledger.system_value("prices:last_refresh") == "2026-01-01T00:00:00+00:00"
    assert res["updated"] == 0 and res["failed"] == ["TCS.NS"] and res["last_refresh"] == "2026-01-01T00:00:00+00:00"


def test_action_log_and_kpi_writes_never_bump_the_ledger(app, client):
    h = auth(USER, "user")
    buy(client, h)
    ledger = app.extensions["ledger"]
    loaded = ledger.load(USER)
    version, rev = ledger._version, ledger.actions_rev

    row = ledger.set_action_status(USER, "tax:ltcg-harvest:FY2026-27", "snoozed", snooze_until="2026-12-31", note="later")
    assert row["status"] == "snoozed" and row["snooze_until"] == "2026-12-31" and row["first_seen"]
    assert ledger.actions_rev == rev + 1 and ledger._version == version
    assert ledger.load(USER) is loaded                                    # the cached load survived
    done = ledger.set_action_status(USER, "tax:ltcg-harvest:FY2026-27", "done", evidence={"txn_ids": [1]})
    assert done["evidence"] == {"txn_ids": [1]} and done["done_via"] == "manual" and done["done_at"]
    undo = ledger.set_action_status(USER, "tax:ltcg-harvest:FY2026-27", "open")
    assert (undo["status"], undo["done_at"], undo["done_via"], undo["evidence"], undo["snooze_until"]) == ("open", None, None, None, None)
    assert undo["note"] == "later" and undo["first_seen"] == row["first_seen"]
    assert ledger.actions_rev == rev + 3

    ledger.upsert_action_seen(USER, [{"id": "cash:usd", "first_seen": "2026-11-01", "tier_first": "now", "title": "Idle dollars",
                                      "impact": 42000.0, "due": "2026-12-01"},
                                     {"id": "tax:ltcg-harvest:FY2026-27", "first_seen": "2020-01-01", "tier_first": "month"}])
    ledger.upsert_action_seen(USER, [{"id": "cash:usd", "first_seen": "2026-11-10", "tier_first": "month", "title": "Idle USD",
                                      "impact": 900.0, "due": "2027-01-01",
                                      "status": "done", "done_via": "auto", "evidence": {"condition": "cleared"}}])
    log = ledger.action_log([USER, OTHER])
    usd = log[(USER, "cash:usd")]
    # A6 / §8.4: only the status and done fields move; title, impact and due stay as first seen
    assert (usd["first_seen"], usd["tier_first"], usd["title"], usd["impact"], usd["due"], usd["status"], usd["evidence"]) == \
        ("2026-11-01", "now", "Idle dollars", 42000.0, "2026-12-01", "done", {"condition": "cleared"})
    assert log[(USER, "tax:ltcg-harvest:FY2026-27")]["first_seen"] == row["first_seen"]  # never overwritten
    # ...but a row created by a status POST before it was seen gets its blank tier_first filled (follow-through)
    assert log[(USER, "tax:ltcg-harvest:FY2026-27")]["tier_first"] == "month"
    ledger.upsert_action_seen(USER, [{"id": "tax:ltcg-harvest:FY2026-27", "tier_first": "now", "category": "tax"}])
    filled = ledger.action_log([USER])[(USER, "tax:ltcg-harvest:FY2026-27")]
    assert (filled["tier_first"], filled["category"]) == ("month", "tax")   # a value already there is kept
    # A row the user closed is not reopened by the computed-on-read upsert
    ledger.set_action_status(USER, "review:due:2026-Q4", "dismissed", reason="not relevant")
    ledger.upsert_action_seen(USER, [{"id": "review:due:2026-Q4", "status": "expired"}])
    assert ledger.action_log([USER])[(USER, "review:due:2026-Q4")]["status"] == "dismissed"
    # A live snooze is the user's; a lapsed snooze and an expired row are computed states and can be closed
    from datetime import date, timedelta
    yesterday, tomorrow = (date.today() - timedelta(days=1)).isoformat(), (date.today() + timedelta(days=1)).isoformat()
    ledger.set_action_status(USER, "data:missing-prices", "snoozed", snooze_until=yesterday)
    ledger.set_action_status(USER, "cushion:low", "snoozed", snooze_until=tomorrow)
    ledger.upsert_action_seen(USER, [{"id": "p2p:overdue", "tier_first": "month", "category": "p2p"}])
    ledger.upsert_action_seen(USER, [{"id": "p2p:overdue", "status": "expired"}])
    closing = {"status": "done", "done_via": "auto", "evidence": {"condition": "cleared"}, "done_at": date.today().isoformat()}
    ledger.upsert_action_seen(USER, [{"id": aid, **closing} for aid in ("data:missing-prices", "cushion:low", "p2p:overdue")])
    log = ledger.action_log([USER])
    lapsed = log[(USER, "data:missing-prices")]
    assert (lapsed["status"], lapsed["done_via"], lapsed["snooze_until"]) == ("done", "auto", None)
    assert log[(USER, "p2p:overdue")]["status"] == "done"
    assert (log[(USER, "cushion:low")]["status"], log[(USER, "cushion:low")]["snooze_until"]) == ("snoozed", tomorrow)

    assert ledger.kpi_snapshot_write(USER, "2026-11-10", {"value": 100}) is True
    assert ledger.kpi_snapshot_write(USER, "2026-11-10", {"value": 999}) is False   # once per day
    ledger.kpi_snapshot_write(USER, "2026-11-12", {"value": 120})
    assert ledger.kpi_snapshot_at(USER, "2026-11-11") == {"date": "2026-11-10", "data": {"value": 100}}
    assert ledger.kpi_snapshot_at(USER, "2026-11-30")["data"] == {"value": 120}
    assert ledger.kpi_snapshot_at(USER, "2026-11-01") is None and ledger.kpi_snapshot_at(OTHER, "2026-11-30") is None

    assert ledger._version == version and ledger.load(USER) is loaded
    assert set(ledger.action_log([OTHER])) == set()


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


KITE_HDR = ("", "Symbol", "ISIN", "Trade Date", "Exchange", "Segment", "Series", "Trade Type", "Auction", "Quantity", "Price",
            "Trade ID", "Order ID", "Order Execution Time")


def _kite_book(trades):
    """Kite's .xlsx layout: a few header lines, then the table starting in column B."""
    head = [("", "Client ID", "AB1234"), (), ("", "Tradebook for Equity from 2026-04-01 to 2026-06-30"), ()]
    body = [("", sym, "INE000000000", day, ex, "EQ", "EQ", side, False, qty, price, f"T{n}", f"O{n}", f"{day}T10:00:00")
            for n, (sym, day, ex, side, qty, price) in enumerate(trades)]
    return [{"name": "tradebook-AB1234-EQ.xlsx", "file_data": _xlsx([head + [KITE_HDR, *body]])}]


def test_kite_tradebook_splits_combined_entries_and_adds_missing_trades(client):
    h = auth(USER, "user")
    # The app holds one combined row for three Kite fills, an IPO allotment, and a buy ₹10 off Kite's figure
    red = buy(client, h, name="Redington", symbol="REDINGTON.NS", qty=30, amount=6300, date="2026-05-13").json["instrument_id"]
    ipo = buy(client, h, name="Jio", symbol="JPL.NS", qty=12, amount=13428, date="2026-05-20").json["instrument_id"]
    gold = buy(client, h, name="Goldbees", symbol="GOLDBEES.NS", qty=10, amount=1010, date="2026-05-26", ac="commodity").json["instrument_id"]
    files = _kite_book([("REDINGTON", "2026-05-13", "NSE", "buy", 10, 200), ("REDINGTON", "2026-05-13", "BSE", "buy", 5, 200),
                        ("REDINGTON", "2026-05-14", "NSE", "buy", 15, 220), ("JPL", "2026-05-20", "BSE", "sell", 12, 1356.5),
                        ("GOLDBEES", "2026-05-26", "NSE", "buy", 10, 100), ("KEC", "2026-06-02", "NSE", "buy", 5, 325.1)])
    pv = client.post("/api/import/tradebook/preview", headers=h, json={"files": files})
    assert pv.status_code == 200, pv.json
    st = {s["symbol"]: s for s in pv.json["stocks"]}
    assert pv.json["trades"] == 6 and pv.json["from_date"] == "2026-04-01" and pv.json["client_ids"] == ["AB1234"]
    (split,) = st["REDINGTON"]["split"]
    assert [r["id"] for r in split["remove"]] and [(r["date"], r["quantity"], r["amount"]) for r in split["add"]] == \
        [("2026-05-13", 15, 3000), ("2026-05-14", 15, 3300)]
    assert st["REDINGTON"]["add"] == [] and split["selected"]
    assert st["JPL"]["kept"][0]["quantity"] == 12 and st["JPL"]["add"][0]["type"] == "SELL"   # IPO stays; the sale is added
    (fix,) = st["GOLDBEES"]["corrections"]
    assert (fix["app_amount"], fix["kite_amount"], fix["selected"]) == (1010, 1000, False)
    assert st["KEC"]["instrument_id"] is None and st["KEC"]["new_instrument"]["symbol"] == "KEC.NS"

    stocks = [{**s, "corrections": []} for s in pv.json["stocks"]]  # leave the amount difference alone
    res = client.post("/api/import/tradebook/commit", headers=h, json={"stocks": stocks}).json
    assert (res["added"], res["removed"], res["corrected"]) == (4, 1, 0), res  # two Redington days, the Jio sale, KEC
    pos = {p["name"]: p for p in client.get("/api/portfolio", headers=h).json["positions"]}
    assert pos["Redington"]["quantity"] == 30 and pos["Redington"]["cost"] == 6300     # same holding, now per trade
    assert pos["Jio"]["quantity"] == 0 and pos["Jio"]["realized"] == 2850
    assert pos["Goldbees"]["cost"] == 1010 and pos["KEC"]["quantity"] == 5
    again = client.post("/api/import/tradebook/preview", headers=h, json={"files": files}).json
    assert all(not (s["add"] or s["split"] or s["review"]) for s in again["stocks"])
    assert [len(s["corrections"]) for s in again["stocks"] if s["corrections"]] == [1]
    assert {red, ipo, gold} <= {p["id"] for p in pos.values()}


def test_kite_tradebook_csv_and_guards(client):
    h = auth(USER, "user")
    csv = ("symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time\n"
           "ONGC,INE213A01029,2026-05-13,NSE,EQ,EQ,sell,false,5,250,1,1,2026-05-13T10:00:00\n"
           "NIFTY26MAYFUT,,2026-05-13,NFO,FO,,buy,false,50,22000,2,2,2026-05-13T10:00:00\n")
    files = [{"name": "tradebook.csv", "file_data": base64.b64encode(csv.encode()).decode()}]
    pv = client.post("/api/import/tradebook/preview", headers=h, json={"files": files}).json
    (ongc,) = pv["stocks"]
    assert pv["trades"] == 1 and ongc["add"][0]["type"] == "SELL"
    res = client.post("/api/import/tradebook/commit", headers=h, json={"stocks": pv["stocks"]}).json
    assert res["added"] == 0 and "sold without a matching buy" in res["results"][0]["error"]
    # Tradebooks dropped into the template CSV importer are sent to the reconciling import instead
    bad = client.post("/api/transactions/import/preview", headers=h, json={"csv": csv})
    assert bad.status_code == 400 and "Kite tradebook" in bad.json["error"]


# ── wave 2: /brief, /actions and the status POST (SPEC §7.2–§7.4, AMENDMENTS E3–E13) ──

BRIEF_KEYS = {"status", "hero", "vitals", "actions", "on_track", "why", "allocation", "upcoming", "tax", "deploy",
              "freshness", "pending", "empty", "context_line", "assumptions_check", "market_state",
              "assumptions", "cushion", "risk_est"}   # H11: the P1 fields services adds to build_brief's A6 keys
ACTIONS_KEYS = {"summary", "actions", "planned", "done", "snoozed", "follow_through", "notes"}


def _review_id():
    from datetime import date
    from tracker.analytics.actions import action_id_for_insight
    return action_id_for_insight("review:due", date.today())   # review:due:<YYYY-Qn> (A8)


def _status(client, who, aid, **body):
    from urllib.parse import quote
    return client.post(f"/api/actions/{quote(aid, safe='')}/status", headers=who, json=body)


def test_brief_and_actions_payloads(client, offline_prices):
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    br = client.get("/api/brief", headers=h)
    assert br.status_code == 200 and set(br.json) == BRIEF_KEYS and br.json["empty"] is False
    assert not br.json["status"]["headline"].endswith("family plan")      # a user's own scope
    acts = client.get("/api/actions", headers=h).json
    assert set(acts) == ACTIONS_KEYS and acts["notes"] == []
    assert {a["status"] for a in acts["actions"]} <= {"open"} and all(a["first_seen"] for a in acts["actions"])
    assert _review_id() in {a["id"] for a in acts["actions"]}
    review = client.get("/api/actions?category=review", headers=h).json
    assert review["actions"] and {a["category"] for a in review["actions"]} == {"review"}
    assert review["summary"]["consider"] == len([a for a in review["actions"] if a["tier"] == "consider"])
    assert client.get("/api/actions?instrument_id=abc", headers=h).status_code == 400
    assert client.get("/api/actions?status=closed", headers=h).status_code == 400
    # an empty ledger is onboarding, and writes no snapshot
    empty = client.get("/api/brief", headers=auth(OTHER, "user")).json
    assert empty["empty"] is True and [a["id"] for a in empty["actions"]] == ["onboard:import", "onboard:add"]


def test_brief_writes_one_snapshot_a_day_and_never_bumps(app, client, offline_prices, monkeypatch):
    import json
    from datetime import date
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    ledger = app.extensions["ledger"]
    writes = []
    real = ledger.kpi_snapshot_write
    monkeypatch.setattr(ledger, "kpi_snapshot_write", lambda *a, **k: writes.append(a) or real(*a, **k))
    version = ledger._version
    assert client.get("/api/brief", headers=h).status_code == 200
    # a different `since` misses the memo, but the snapshot for today is already written (in-process set)
    assert client.get(f"/api/brief?since={date.today().isoformat()}", headers=h).status_code == 200
    assert client.get("/api/brief", headers=h).status_code == 200
    rows = ledger.db.query("SELECT owner, date, data FROM kpi_snapshots")
    assert len(rows) == 1 and len(writes) == 1 and ledger._version == version
    snap = rows[0]
    data = json.loads(snap["data"])
    assert (snap["owner"], snap["date"]) == (USER, date.today().isoformat())
    assert {"value", "invested", "total_gain", "xirr", "day_change", "goal_probs", "retirement_probability", "vitals",
            "action_ids"} <= set(data)
    assert _review_id() in data["action_ids"] and data["vitals"]["data"] in ("good", "watch", "act")
    # the family view: the headline says so, and its snapshot belongs to '__family__'
    fam = client.get("/api/brief", headers=auth(ADMIN, "admin")).json
    assert fam["status"]["headline"].endswith(" · family plan")
    assert ledger.kpi_snapshot_at("__family__", date.today().isoformat()) is not None


def test_brief_since_is_validated(client):
    from datetime import date, timedelta
    h = auth(USER, "user")
    buy(client, h)
    today = date.today()
    for bad in ("2026-13-01", "yesterday", "2026-1-5", (today + timedelta(days=2)).isoformat()):
        assert client.get(f"/api/brief?since={bad}", headers=h).status_code == 400, bad
    # the browser's IST date can run a day ahead of a UTC server: clamped to today
    assert client.get(f"/api/brief?since={(today + timedelta(days=1)).isoformat()}", headers=h).status_code == 200
    assert client.get(f"/api/brief?since={(today - timedelta(days=7)).isoformat()}", headers=h).status_code == 200


def test_brief_since_counts_new_actions_against_that_snapshot(app, client, offline_prices):
    from datetime import date, timedelta
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    ledger = app.extensions["ledger"]
    week_ago = (date.today() - timedelta(days=7)).isoformat()
    ledger.kpi_snapshot_write(USER, week_ago, {"value": 30000, "action_ids": [_review_id()]})
    br = client.get(f"/api/brief?since={week_ago}", headers=h).json
    visible = [a["id"] for a in client.get("/api/actions", headers=h).json["actions"]]
    since = br["hero"]["since_last"]
    assert since["date"] == week_ago and since["actions_new"] == len([i for i in visible if i != _review_id()])
    assert all(a["is_new"] == (a["id"] != _review_id()) for a in br["actions"])


def test_status_post_bumps_actions_rev_only(app, client, offline_prices, monkeypatch):
    import tracker.services as services
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    counts = {"tax": 0, "port": 0}
    real_tax, real_port = services.compute_tax, services.compute_portfolio
    monkeypatch.setattr(services, "compute_tax", lambda *a, **k: counts.__setitem__("tax", counts["tax"] + 1) or real_tax(*a, **k))
    monkeypatch.setattr(services, "compute_portfolio",
                        lambda *a, **k: counts.__setitem__("port", counts["port"] + 1) or real_port(*a, **k))
    ledger, svc = app.extensions["ledger"], app.extensions["services"]
    assert client.get("/api/tax", headers=h).status_code == 200
    assert client.get("/api/actions", headers=h).status_code == 200
    ctx = svc.context(USER, ledger.get_settings(USER, "user"))
    before, version, rev = dict(counts), ledger._version, ledger.actions_rev
    r = _status(client, h, _review_id(), status="snoozed", until=None)
    assert r.status_code == 200 and r.json["status"] == "snoozed" and r.json["snooze_until"]
    assert ledger.actions_rev == rev + 1 and ledger._version == version
    assert client.get("/api/tax", headers=h).status_code == 200
    assert svc.context(USER, ledger.get_settings(USER, "user")) is ctx   # the context memo survived
    assert counts == before
    acts = client.get("/api/actions", headers=h).json                  # re-read: the overlay moved it
    assert _review_id() not in {a["id"] for a in acts["actions"]}
    assert _review_id() in {a["id"] for a in acts["snoozed"]}
    assert counts == before


def test_status_post_validation_and_guests(client):
    h = auth(USER, "user")
    buy(client, h)
    rid = _review_id()
    assert _status(client, auth(GUEST, "guest"), rid, status="done").status_code == 403
    assert _status(client, h, "bogus:thing", status="done").status_code == 400
    assert _status(client, h, "goal:" + "x" * 200, status="done").status_code == 400
    assert _status(client, h, rid, status="closed").status_code == 400
    assert _status(client, h, rid, status="expired").status_code == 400     # computed, never posted
    assert _status(client, h, rid, status="snoozed", until="2020-01-01").status_code == 400
    assert _status(client, h, rid, status="snoozed", until="2099-01-01").status_code == 400
    assert _status(client, h, rid, status="planned", planned_for="not-a-date").status_code == 400
    assert _status(client, h, rid, status="done", txn_ids="7").status_code == 400


def test_manual_done_records_first_sight_and_evidence(app, client, offline_prices):
    h = auth(USER, "user")
    tid = buy(client, h, symbol="TCS.NS").json["id"]
    rid = _review_id()
    # never fetched: the POST itself builds the list, so the row gets the first-sight fields
    r = _status(client, h, rid, status="done", txn_ids=[tid], evidence={"txn_ids": [tid]})
    assert r.status_code == 200 and r.json["status"] == "done" and r.json["done_via"] == "manual"
    assert r.json["evidence"] == {"txn_ids": [tid]}
    row = app.extensions["ledger"].action_row(USER, rid)
    assert (row["status"], row["done_via"], row["tier_first"], row["category"]) == ("done", "manual", "consider", "review")
    assert row["title"] == "Time for a portfolio review" and row["first_seen"] and row["done_at"]
    done = client.get("/api/actions", headers=h).json["done"]
    assert [a["id"] for a in done] == [rid] and done[0]["tier"] == "consider" and done[0]["status"] == "done"
    # Undo reopens it
    assert _status(client, h, rid, status="open").json["status"] == "open"
    assert rid in {a["id"] for a in client.get("/api/actions", headers=h).json["actions"]}


def test_insight_dismiss_is_an_alias_for_a_snooze(app, client, offline_prices):
    from datetime import date, timedelta
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    rid = _review_id()
    assert rid in {a["id"] for a in client.get("/api/actions", headers=h).json["actions"]}
    r = client.post("/api/insights/review:due/dismiss", headers=h, json={"days": 7})
    until = (date.today() + timedelta(days=7)).isoformat()
    assert r.status_code == 200 and r.json["dismissed"] == "review:due" and r.json["until"] == until
    row = app.extensions["ledger"].action_row(USER, rid)          # period-keyed, in the action log
    assert (row["status"], row["snooze_until"]) == ("snoozed", until)
    assert "dismissedInsights" not in client.get("/api/settings", headers=h).json
    assert rid not in {a["id"] for a in client.get("/api/actions", headers=h).json["actions"]}
    assert client.post("/api/insights/review:due/dismiss", headers=h, json={"days": 0}).status_code == 400
    assert client.post("/api/insights/review:due/dismiss", headers=auth(GUEST, "guest"), json={}).status_code == 403


def test_notifications_drop_insights_whose_action_is_hidden(app, client, offline_prices):
    """R9: the bell lists tier-now actions as act:<id> notices (no ins:* items any more), so an action the user
    hides leaves the bell with it."""
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    # an unpriced holding (offline quotes all fail) is a tier-now data action while the Data vital is act
    res = client.get("/api/notifications", headers=h).json
    before = [n["id"] for n in res["items"]]
    assert "act:data:missing-prices" in before and not any(i.startswith("ins:") for i in before)
    assert _status(client, h, "data:missing-prices", status="snoozed").status_code == 200
    after = [n["id"] for n in client.get("/api/notifications", headers=h).json["items"]]
    assert "act:data:missing-prices" not in after


def test_brief_risk_vital_is_the_optimizer_estimate(app, client, offline_prices):
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    client.post("/api/fixed-deposits", headers=h, json={"name": "HDFC FD", "amount": 50000, "rate": 7.1,
                                                        "date": "2025-06-01", "maturity_date": "2027-06-01"})
    ledger, svc = app.extensions["ledger"], app.extensions["services"]
    for profile in (None, "growth"):
        if profile:
            assert client.put("/api/settings/riskProfile", headers=h, json={"value": profile}).status_code == 200
        risk = next(v for v in client.get("/api/brief", headers=h).json["vitals"] if v["key"] == "risk")
        vol = svc.optimizer(USER, ledger.get_settings(USER, "user"), profile or "balanced")["current"]["vol_pct"]
        assert f"Est. volatility {vol:.1f}%" in risk["value"], (profile, risk)


def test_retirement_gap_only_with_a_saved_plan(client, offline_prices):
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    ids = {a["id"] for a in client.get("/api/actions", headers=h).json["actions"]}
    assert not any(i.startswith("retirement:") for i in ids)
    rows = client.get("/api/brief", headers=h).json["on_track"]["plan"]["rows"]
    assert not any(r["kind"] == "retirement" for r in rows)
    # a saved plan that cannot work does raise it
    plan = {"current_age": 40, "retire_age": 45, "monthly_expenses": 500000}
    assert client.put("/api/settings/retirementPlan", headers=h, json={"value": plan}).status_code == 200
    ids = {a["id"] for a in client.get("/api/actions", headers=h).json["actions"]}
    assert "retirement:gap" in ids
    rows = client.get("/api/brief", headers=h).json["on_track"]["plan"]["rows"]
    assert [r["kind"] for r in rows if r["kind"] == "retirement"] == ["retirement"]


def test_rebalance_net_deploy_subtracts_held_value(app, client, offline_prices):
    from datetime import date, timedelta
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS", date="2026-01-05")
    today = date.today()
    client.post("/api/fixed-deposits", headers=h, json={"name": "Short FD", "amount": 50000, "rate": 7.0,
                                                        "date": (today - timedelta(days=340)).isoformat(),
                                                        "maturity_date": (today + timedelta(days=20)).isoformat()})
    client.put("/api/settings/targetAllocation", headers=h, json={"value": {"Equity (India)": 50, "Fixed Deposits": 50}})
    plain = client.get("/api/rebalance?new_money=60000", headers=h).json
    net = client.get("/api/rebalance?new_money=60000&net=deploy", headers=h).json
    svc, ledger = app.extensions["services"], app.extensions["ledger"]
    (fd_src,) = [s for s in svc.deploy(USER, ledger.get_settings(USER, "user"))["sources"] if s["kind"] == "fd"]
    row = lambda plan, seg: next(r for r in plan["rows"] if r["segment"] == seg)  # noqa: E731
    fd_plain, fd_net = row(plain, "Fixed Deposits")["current"], row(net, "Fixed Deposits")["current"]
    assert fd_src["held_value"] > 50000 and fd_net == round(max(fd_plain - fd_src["held_value"], 0), 2)
    assert net["netted"] == {"Fixed Deposits": fd_src["held_value"]} and net["net"] == "deploy"
    assert row(net, "Equity (India)")["current"] == row(plain, "Equity (India)")["current"]
    # the maturing FD no longer counts as already filling its target, so more new money goes to FDs
    assert row(net, "Fixed Deposits")["amount"] > row(plain, "Fixed Deposits")["amount"]
    assert client.get("/api/rebalance?net=other", headers=h).status_code == 400


def test_brief_memo_picks_up_a_warm_performance(client, offline_prices):
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    cold = client.get("/api/brief", headers=h).json
    assert cold["pending"] == ["market"] and cold["on_track"]["market"]["status"] == "pending"
    assert client.get("/api/performance", headers=h).status_code == 200   # ALL: the key /brief peeks (A16)
    warm = client.get("/api/brief", headers=h).json
    assert warm["pending"] == [] and warm["on_track"]["market"]["status"] != "pending"


def test_brief_retirement_picks_up_a_warm_performance(app, client, offline_prices):
    """The shared action inputs are keyed on perf_ready too: once /performance is warm, Home's retirement row (and
    /actions' plan) use the record-blended estimate the Retirement tab shows, not the cold one built first."""
    from datetime import date, timedelta
    h = auth(USER, "user")
    # more than two years of record, so blended_assumptions uses the user's own TWR and volatility (≥ 730 days)
    buy(client, h, symbol="TCS.NS", date=(date.today() - timedelta(days=1000)).isoformat(), qty=100, amount=150000)
    plan = {"current_age": 35, "retire_age": 55, "monthly_expenses": 40000, "monthly_sip": 60000}
    assert client.put("/api/settings/retirementPlan", headers=h, json={"value": plan}).status_code == 200
    svc, ledger = app.extensions["services"], app.extensions["ledger"]
    settings = ledger.get_settings(USER, "user")

    def ret_row(brief):
        return next(r for r in brief["on_track"]["plan"]["rows"] if r["kind"] == "retirement")

    cold_row = ret_row(client.get("/api/brief", headers=h).json)
    cold = svc.retirement(USER, settings, {}, build_history=False)
    assert cold_row["probability"] == cold["probability"]
    assert client.get("/api/performance", headers=h).status_code == 200   # warms ALL (A16)
    page = svc.retirement(USER, settings, {})                               # what the Retirement tab shows
    assert page["probability"] != cold["probability"], "the record must change the estimate for this test to bite"
    warm_row = ret_row(client.get("/api/brief", headers=h).json)
    assert (warm_row["probability"], warm_row["status"]) == (page["probability"], brief_status(page["status"]))


def brief_status(status):
    from tracker.analytics.brief import GOAL_STATUS
    return GOAL_STATUS.get(status, "unset")


def test_actions_rank_data_actions_with_the_data_vital_like_the_brief(app, client, offline_prices):
    """SPEC §1.7: a data:* action is 'now' while the Data vital is act, on /actions exactly as on Home. Prices a
    week old make the vital act while data:stale-prices is only a warning, so only the vital can make it 'now'."""
    from datetime import datetime, timedelta, timezone
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    ledger = app.extensions["ledger"]
    week_old = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    ledger.db.execute("UPDATE instruments SET last_price = 3600, prev_close = 3590, last_price_at = ?", (week_old,))
    ledger._bump()
    br = client.get("/api/brief", headers=h).json
    assert next(v for v in br["vitals"] if v["key"] == "data")["status"] == "act"
    acts = client.get("/api/actions", headers=h).json
    tiers = {a["id"]: a["tier"] for a in acts["actions"] if a["id"].startswith("data:")}
    stale = next(a for a in acts["actions"] if a["id"] == "data:stale-prices")
    assert stale["severity"] == "warn" and tiers == {"data:stale-prices": "now"}, tiers
    home = {a["id"]: a["tier"] for a in br["actions"] if a["id"].startswith("data:")}
    assert home and all(tiers[i] == t for i, t in home.items())
    assert (acts["summary"]["now"], acts["summary"]["month"]) == (br["status"]["count_now"], br["status"]["count_month"])
