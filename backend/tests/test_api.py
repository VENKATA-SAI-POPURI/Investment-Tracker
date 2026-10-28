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
