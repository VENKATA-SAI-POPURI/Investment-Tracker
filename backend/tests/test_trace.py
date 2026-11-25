"""Activity › Entry flow, Checks and Rules."""
import pytest

from tracker.analytics import trace as tr
from tracker.analytics.portfolio import compute_portfolio

from conftest import ADMIN, USER, auth
from demo_book import TODAY, USD_INR, book


def setup():
    insts, txns = book()
    port = compute_portfolio(insts, txns, USD_INR, today=TODAY)
    return insts, txns, port


def run(tid, rule=None, linked=None, auto=True):
    insts, txns, port = setup()
    t = next(x for x in txns if x["id"] == tid)
    inst = next(i for i in insts if i["id"] == t["instrument_id"])
    return tr.trace_txn(t, inst, [x for x in txns if x["instrument_id"] == inst["id"]], port, linked or [], rule, auto, TODAY)


def step(res, key):
    return next(s for s in res["steps"] if s["key"] == key)


def test_sell_matches_the_oldest_lot_and_books_the_gain():
    res = run(3)   # SELL 5 Infosys for 7,600 on 2025-08-20
    assert "You held 30 shares" in step(res, "saved")["text"]
    lots = step(res, "lots")
    assert lots["formula"] == "cost = ₹7,450" and "2024-03-12" in lots["items"][0]
    gain = step(res, "gain")
    assert gain["formula"] == "₹7,600 − ₹7,450 = ₹150" and gain["text"].startswith("Long-term")
    after = step(res, "after")
    assert after["text"].startswith("30 → 25 shares") and "₹1,650" in after["text"]
    assert after["formula"] == "cost ₹48,700 → ₹41,250"
    assert "+₹7,600" in step(res, "xirr")["text"]


def test_us_stock_buy_inside_the_wallet_is_not_a_cash_flow():
    res = run(7)   # Apple bought from the USD wallet
    assert step(res, "xirr")["text"].startswith("Not a cash flow: it happens inside your US broker account")


def test_buy_lot_and_tax_clock():
    res = run(1)
    assert "15 of 20 still open, 5 sold since" in step(res, "lots")["text"]
    assert "Long-term after 365 days" in step(res, "tax")["text"]
    assert "−₹29,800" in step(res, "xirr")["text"]


def test_cash_step_explains_missing_entries():
    rule = {"id": "R1", "entries": [], "import_entries": None, "note": "Stock buys are paid from your broker balance"}
    assert step(run(1, rule=rule), "cash")["text"].startswith("None: Stock buys")
    mf_rule = {"id": "R6", "entries": [{"account": "capital"}], "import_entries": None, "note": None}
    assert "switched off" in step(run(8, rule=mf_rule, auto=False), "cash")["text"]
    assert "None linked" in step(run(8, rule=mf_rule), "cash")["text"]
    linked = [{"account": "capital", "direction": "in", "amount": 70000, "category": "Mutual Funds"}]
    assert step(run(8, rule=mf_rule, linked=linked), "cash")["items"] == ["capital · in ₹70,000 · Mutual Funds"]


def test_p2p_repayment_split_and_legacy_estimate():
    assert "₹800 principal back · ₹150 interest" in step(run(13), "split")["text"]
    assert step(run(16), "split")["tone"] == "warn"


def test_checks_find_the_problems_in_the_sample_book():
    insts, txns, port = setup()
    ids = {c["id"] for c in tr.data_checks(port, txns, insts, {}, TODAY)}
    assert "p2p-no-split" in ids          # Borrower B's legacy repayment
    assert "p2p-overdue" in ids           # Borrower A was due in June
    assert "unmatched-sells" not in ids
    txns.append({**txns[0], "id": 99})    # a duplicate of the first buy
    port = compute_portfolio(insts, txns, USD_INR, today=TODAY)
    checks = tr.data_checks(port, txns, insts, {"autoCapitalFlows": "false"}, TODAY)
    assert {"duplicates", "auto-cash-off"} <= {c["id"] for c in checks}
    assert [c["severity"] for c in checks] == sorted((c["severity"] for c in checks), key={"bad": 0, "warn": 1, "info": 2}.get)


def test_rules_come_from_the_code(client):
    rules = client.get("/api/rules", headers=auth(USER, "user")).json
    by = {(r["asset_class"], r["type"]): r for r in rules}
    assert by[("mutual_fund", "BUY")]["entries"][0]["account"] == "capital"
    assert by[("equity", "BUY")]["entries"] == [] and by[("equity", "BUY")]["note"]
    rep = by[("p2p", "REPAYMENT")]
    assert len(rep["import_entries"]) == len(rep["entries"]) + 1   # escrow out only for imports


def test_trace_and_checks_api(client):
    h = auth(USER, "user")
    t = client.post("/api/transactions", headers=h, json={"type": "BUY", "date": "2025-01-10", "quantity": 10, "amount": 15000,
                                                          "instrument": {"asset_class": "mutual_fund", "name": "Index Fund"}}).json
    r = client.get(f"/api/trace/txn/{t['id']}", headers=h)
    assert r.status_code == 200
    cash = next(s for s in r.json["steps"] if s["key"] == "cash")
    assert cash["items"] and "capital · in ₹15,000" in cash["items"][0]
    assert client.get(f"/api/trace/txn/{t['id']}", headers=auth("other@example.com", "user")).status_code == 404
    assert client.get("/api/checks", headers=h).status_code == 200
