"""Wave 6 ledger work (W6-B1): migration 006 and the goal link on SIP plans, transaction paging, all-or-nothing
CSV / CAS import commits, and the action-log seen / pushed helpers."""
import pytest

from conftest import OTHER, USER, auth
from tracker import migrations
from tracker.analytics.actions import follow_through
from tracker.db import SqliteDatabase
from tracker.ledger import ValidationError
from tracker.migrations import run_migrations


def L(app):
    return app.extensions["ledger"]


def buy(client, who, name="TCS", qty=10, amount=35000, date="2026-01-05", ac="equity", typ="BUY", notes=None, **extra):
    return client.post("/api/transactions", headers=who, json={
        "type": typ, "date": date, "quantity": qty, "amount": amount, "notes": notes,
        "instrument": {"asset_class": ac, "name": name, "market": "India", **extra}})


def counts(app):
    db = L(app).db
    return (db.one("SELECT COUNT(*) AS n FROM transactions")["n"], db.one("SELECT COUNT(*) AS n FROM instruments")["n"])


# ── migration 006 and the goal link ──

def test_m006_adds_goal_id_once_and_is_idempotent(tmp_path, monkeypatch):
    db = SqliteDatabase(str(tmp_path / "m006.db"))
    monkeypatch.setattr(migrations, "MIGRATIONS", migrations.MIGRATIONS[:5])
    assert run_migrations(db, log=lambda *_: None) == [1, 2, 3, 4, 5]
    monkeypatch.undo()
    assert "goal_id" not in db.columns("sip_plans")
    assert run_migrations(db, log=lambda *_: None) == [6, 7, 8]
    assert "goal_id" in db.columns("sip_plans")
    assert run_migrations(db, log=lambda *_: None) == []
    assert migrations.m006_sip_goal(db) == []           # replaying the step itself is a no-op
    assert db.one("SELECT name FROM schema_migrations WHERE version = 6")["name"] == "sip_goal"


def test_fresh_app_has_goal_id(app):
    assert "goal_id" in L(app).db.columns("sip_plans")


def test_sip_goal_link_is_validated_against_the_plans_owner(app):
    led = L(app)
    mine = led.save_goal(USER, USER, {"name": "House", "target_amount": 5e6, "target_date": "2032-01-01"})
    theirs = led.save_goal(OTHER, OTHER, {"name": "Car", "target_amount": 1e6, "target_date": "2029-01-01"})
    plan = led.save_sip(USER, USER, {"name": "Index SIP", "amount": 10000, "goal_id": mine["id"]})
    assert plan["goal_id"] == mine["id"]
    assert next(s for s in led.sips(USER) if s["id"] == plan["id"])["goal_id"] == mine["id"]
    # another owner's goal, an unknown id and junk are refused, on create and on update
    for bad in (theirs["id"], 99999, "abc", 1.5, True):
        with pytest.raises(ValidationError, match="isn't one of this portfolio's goals"):
            led.save_sip(USER, USER, {"name": "X", "amount": 1000, "goal_id": bad})
        with pytest.raises(ValidationError):
            led.save_sip(USER, USER, {"goal_id": bad}, sid=plan["id"])
    assert led.save_sip(USER, USER, {"goal_id": str(mine["id"])}, sid=plan["id"])["goal_id"] == mine["id"]
    assert led.save_sip(USER, USER, {"goal_id": ""}, sid=plan["id"])["goal_id"] is None
    assert led.save_sip(USER, USER, {"goal_id": mine["id"]}, sid=plan["id"])["goal_id"] == mine["id"]
    assert led.save_sip(USER, USER, {"goal_id": None}, sid=plan["id"])["goal_id"] is None
    # on update the stored row's owner decides, not the caller's (an admin editing a member's plan)
    other_plan = led.save_sip(OTHER, OTHER, {"name": "Car SIP", "amount": 5000})
    assert led.save_sip("admin@example.com", None, {"goal_id": theirs["id"]}, sid=other_plan["id"])["goal_id"] == theirs["id"]
    with pytest.raises(ValidationError):
        led.save_sip("admin@example.com", None, {"goal_id": mine["id"]}, sid=other_plan["id"])


def test_deleting_a_goal_unlinks_its_plans_and_keeps_them(app):
    led = L(app)
    goal = led.save_goal(USER, USER, {"name": "House", "target_amount": 5e6, "target_date": "2032-01-01"})
    keep = led.save_goal(USER, USER, {"name": "Trip", "target_amount": 2e5, "target_date": "2027-06-01"})
    a = led.save_sip(USER, USER, {"name": "A", "amount": 1000, "goal_id": goal["id"]})
    b = led.save_sip(USER, USER, {"name": "B", "amount": 2000, "goal_id": goal["id"]})
    c = led.save_sip(USER, USER, {"name": "C", "amount": 3000, "goal_id": keep["id"]})
    v = led._version
    led.delete_goal(goal["id"], USER)
    assert led._version > v
    plans = {s["id"]: s for s in led.sips(USER)}
    assert set(plans) == {a["id"], b["id"], c["id"]}
    assert plans[a["id"]]["goal_id"] is None and plans[b["id"]]["goal_id"] is None
    assert plans[c["id"]]["goal_id"] == keep["id"]


# ── paging ──

@pytest.fixture
def ledger_rows(client):
    h = auth(USER, "user")
    for n in range(25):
        buy(client, h, name="TCS" if n % 2 else "Infosys", qty=1, amount=1000 + n, date=f"2026-{1 + n % 3:02d}-{1 + n:02d}",
            notes="monthly top-up" if n == 7 else None)
    assert buy(client, h, name="TCS", typ="SELL", qty=2, amount=5000, date="2026-03-28").status_code == 201
    assert buy(client, h, name="TCS", typ="DIVIDEND", qty=None, amount=300, date="2026-03-29").status_code == 201
    return h


def test_paging_totals_sums_and_months_cover_every_row(app, ledger_rows):
    led = L(app)
    pages = [led.transactions_page(USER, page=p, size=10) for p in (1, 2, 3, 4)]
    first = pages[0]
    assert first["total"] == 27 and first["pages"] == 3 and first["size"] == 10 and first["page"] == 1
    assert [len(p["rows"]) for p in pages] == [10, 10, 7, 0]
    assert pages[3]["total"] == 27                        # past the end: no rows, true total
    ids = [r["id"] for p in pages for r in p["rows"]]
    assert len(ids) == len(set(ids)) == 27
    buys = sum(1000 + n for n in range(25))
    for p in pages:                                       # the same sums and months on every page
        assert p["sums"] == {"count": 27, "out": buys, "in": 5300.0, "net": buys - 5300.0}
        assert p["months"] == first["months"]
    months = first["months"]
    assert [m["month"] for m in months] == ["2026-03", "2026-02", "2026-01"]
    assert sum(m["count"] for m in months) == 27
    assert months[0]["in"] == 5300.0
    assert sum(m["out"] for m in months) == buys
    # rows have today's GET /transactions shape, newest first
    listing = app.test_client().get("/api/transactions", headers=ledger_rows).json
    assert first["rows"] == listing[:10]
    assert set(first["rows"][0]) == set(listing[0])
    assert {"instrument_name", "asset_class", "segment", "currency"} <= set(first["rows"][0])


def test_paging_clamps_and_validates(app, ledger_rows):
    led = L(app)
    assert led.transactions_page(USER, size=3)["size"] == 10
    assert led.transactions_page(USER, size=5000)["size"] == 200
    assert led.transactions_page(USER, page=0)["page"] == 1
    assert led.transactions_page(USER, page="2", size="10")["page"] == 2
    for bad in ({"sort": "price"}, {"page": "x"}, {"size": "ten"}, {"page": 1.5}):
        with pytest.raises(ValidationError):
            led.transactions_page(USER, **bad)
    empty = led.transactions_page(OTHER)
    assert empty["rows"] == [] and empty["total"] == 0 and empty["pages"] == 1
    assert empty["sums"] == {"count": 0, "out": 0.0, "in": 0.0, "net": 0.0} and empty["months"] == []


def test_query_filters_and_sort(app, ledger_rows):
    led = L(app)
    tcs = led.transactions_page(USER, q="  tcs ", size=200)
    assert tcs["total"] == 14 and {r["instrument_name"] for r in tcs["rows"]} == {"TCS"}
    assert tcs["sums"]["count"] == 14 and tcs["sums"]["in"] == 5300.0
    assert led.transactions_page(USER, q="TOP-UP")["total"] == 1      # notes
    assert led.transactions_page(USER, q="sell")["total"] == 1        # type
    assert led.transactions_page(USER, q="x" * 300)["total"] == 0
    assert led.transactions_page(USER, filters={"type": "BUY", "from": "2026-02-01", "to": "2026-02-28"})["total"] == 8
    inf = next(i for i in led.load(USER)["instruments"] if i["name"] == "Infosys")
    assert led.transactions_page(USER, filters={"instrument_id": inf["id"]})["total"] == 13
    assert led.transactions_page(USER, filters={"instrument_id": str(inf["id"])})["total"] == 13

    def order(sort):
        return led.transactions_page(USER, sort=sort, size=200)["rows"]
    amounts = [r["amount"] for r in order("amount")]
    assert amounts == sorted(amounts) and [r["amount"] for r in order("-amount")] == amounts[::-1]
    dates = [(r["date"], r["id"]) for r in order("date")]
    assert dates == sorted(dates) and [(r["date"], r["id"]) for r in order("-date")] == dates[::-1]
    names = [r["instrument_name"] for r in order("name")]
    assert names[0] == "Infosys" and names[-1] == "TCS"
    by_name = [(r["instrument_name"].lower(), r["id"]) for r in order("-name")]
    assert by_name == sorted(by_name, reverse=True)


def test_route_pages_only_when_asked(client, ledger_rows):
    plain = client.get("/api/transactions", headers=ledger_rows)
    assert plain.status_code == 200 and isinstance(plain.json, list) and len(plain.json) == 27
    paged = client.get("/api/transactions?page=2&size=10&sort=-amount&type=BUY", headers=ledger_rows).json
    assert paged["page"] == 2 and paged["total"] == 25 and len(paged["rows"]) == 10
    assert set(paged) == {"rows", "total", "page", "size", "pages", "sums", "months"}
    assert [r["amount"] for r in paged["rows"]] == sorted((r["amount"] for r in paged["rows"]), reverse=True)
    assert client.get("/api/transactions?page=1&q=infosys", headers=ledger_rows).json["total"] == 13
    for bad in ("page=abc", "page=1&size=x", "page=1&sort=bogus"):
        res = client.get(f"/api/transactions?{bad}", headers=ledger_rows)
        assert res.status_code == 400 and res.json["error"]
    # the other user sees none of these rows
    assert client.get("/api/transactions?page=1", headers=auth(OTHER, "user")).json["total"] == 0


# ── all-or-nothing imports ──

CSV_HEAD = "date,type,asset_class,name,symbol,quantity,amount\n"


def preview(client, h, csv):
    res = client.post("/api/transactions/import/preview", headers=h, json={"csv": csv})
    assert res.status_code == 200
    return res.json["rows"]


def test_csv_with_one_bad_row_writes_nothing_then_the_fixed_file_writes_both(app, client):
    h = auth(USER, "user")
    buy(client, h, name="Infosys", qty=5, amount=7000)
    before = counts(app)
    bad = CSV_HEAD + "2026-01-02,BUY,equity,HDFC Bank,HDFCBANK.NS,5,8000\n2026-01-03,SELL,equity,HDFC Bank,HDFCBANK.NS,9,3300\n"
    res = client.post("/api/transactions/import/commit", headers=h, json={"rows": preview(client, h, bad)})
    assert res.status_code == 400
    assert res.json["error"] == "Nothing was imported: 1 row(s) need fixing"
    assert [r["ok"] for r in res.json["results"]] == [True, False] and res.json["results"][1]["error"]
    assert counts(app) == before                          # no transaction and no new holding

    # a row that fails validation (a date in the future) blocks the rest the same way
    future = CSV_HEAD + "2026-01-02,BUY,equity,HDFC Bank,,5,8000\n2099-01-03,BUY,equity,Wipro,,1,500\n"
    res = client.post("/api/transactions/import/commit", headers=h, json={"rows": preview(client, h, future)})
    assert res.status_code == 400 and counts(app) == before

    fixed = bad.replace(",9,3300", ",2,3300")
    res = client.post("/api/transactions/import/commit", headers=h, json={"rows": preview(client, h, fixed)})
    assert res.status_code == 200 and res.json["imported"] == 2 and all(r["ok"] for r in res.json["results"])
    assert counts(app) == (before[0] + 2, before[1] + 1)
    hdfc = next(i for i in L(app).load(USER)["instruments"] if i["name"] == "HDFC Bank")
    assert hdfc["symbol"] == "HDFCBANK.NS" and hdfc["price_source"] == "yahoo" and hdfc["owner"] == USER
    txn_ids = {t["id"] for t in L(app).load(USER)["transactions"] if t["instrument_id"] == hdfc["id"]}
    assert {r["id"] for r in res.json["results"]} == txn_ids
    assert all(t["source"] == "import:csv" for t in L(app).load(USER)["transactions"] if t["id"] in txn_ids)


def test_csv_sale_of_an_existing_holding_checks_the_end_state(app, client):
    h = auth(USER, "user")
    buy(client, h, name="Infosys", qty=5, amount=7000, date="2026-01-05")
    before = counts(app)
    over = CSV_HEAD + "2026-02-01,SELL,equity,infosys,,6,9000\n"
    res = client.post("/api/transactions/import/commit", headers=h, json={"rows": preview(client, h, over)})
    assert res.status_code == 400 and counts(app) == before
    ok = CSV_HEAD + "2026-02-01,SELL,equity,infosys,,5,9000\n"
    res = client.post("/api/transactions/import/commit", headers=h, json={"rows": preview(client, h, ok)})
    assert res.status_code == 200 and counts(app) == (before[0] + 1, before[1])   # matched case-insensitively


def cas_fund(name, *txns, amfi=None):
    return {"name": name, "amfi": amfi, "amc": "Some AMC", "category": "Equity", "folio": "123",
            "transactions": [{"date": dt, "type": typ, "quantity": q, "amount": a} for dt, typ, q, a in txns]}


def test_cas_with_one_bad_fund_writes_nothing(app, client):
    h = auth(USER, "user")
    before = counts(app)
    good = cas_fund("Alpha Index Fund", ("2026-01-10", "BUY", 100, 10000), ("2026-02-10", "BUY", 50, 5200), amfi="120000")
    bad = cas_fund("Beta Flexi Cap", ("2026-01-10", "BUY", 10, 1000), ("2026-02-10", "SELL", 30, 3500))
    nps = {"name": "SBI Pension Scheme E Tier I", "pran": "110011", "fund_manager": "SBI", "tier": "Tier I",
           "nav": 45.5, "units": 200, "value": 9100}
    res = client.post("/api/import/cas/commit", headers=h, json={"funds": [good, bad], "nps": [nps], "as_of": "2026-03-31"})
    assert res.status_code == 400 and res.json["error"] == "Nothing was imported: 1 row(s) need fixing"
    assert [r["ok"] for r in res.json["results"]] == [True, False, True]
    assert counts(app) == before

    res = client.post("/api/import/cas/commit", headers=h, json={"funds": [good], "nps": [nps], "as_of": "2026-03-31"})
    assert res.status_code == 200 and res.json["imported"] == 3
    insts = {i["name"]: i for i in L(app).load(USER)["instruments"]}
    alpha, pension = insts["Alpha Index Fund"], insts["SBI Pension Scheme E Tier I"]
    assert alpha["symbol"] == "AMFI:120000" and alpha["price_source"] == "amfi"
    assert pension["ref"] == "110011" and pension["last_price"] == 45.5 and pension["price_source"] == "manual"
    assert pension["last_price_at"]
    opening = [t for t in L(app).load(USER)["transactions"] if t["instrument_id"] == pension["id"]]
    assert len(opening) == 1 and opening[0]["quantity"] == 200 and opening[0]["date"] == "2026-03-31"

    # a second CAS: the matched NPS scheme gets a NAV update and repeated fund rows are skipped, in one write
    res = client.post("/api/import/cas/commit", headers=h, json={
        "funds": [{**good, "matched_id": alpha["id"]}],
        "nps": [{**nps, "matched_id": pension["id"], "nav": 47.25}], "as_of": "2026-04-30"})
    assert res.status_code == 200 and res.json["imported"] == 0
    assert L(app).instrument(pension["id"], USER)["last_price"] == 47.25


def test_cas_two_nps_schemes_on_one_pran_get_their_own_opening_balance(app, client):
    h = auth(USER, "user")
    tier = {"pran": "220022", "fund_manager": "SBI", "as_of": None}
    nps = [{**tier, "name": "Scheme E Tier I", "tier": "Tier I", "nav": 40, "units": 10, "value": 400},
           {**tier, "name": "Scheme E Tier II", "tier": "Tier II", "nav": 30, "units": 20, "value": 600}]
    res = client.post("/api/import/cas/commit", headers=h, json={"funds": [], "nps": nps, "as_of": "2026-03-31"})
    assert res.status_code == 200
    insts = {i["name"]: i["id"] for i in L(app).load(USER)["instruments"]}
    units = {t["instrument_id"]: t["quantity"] for t in L(app).load(USER)["transactions"]}
    assert units == {insts["Scheme E Tier I"]: 10, insts["Scheme E Tier II"]: 20}


def test_bulk_add_finds_a_new_instrument_without_a_ref_by_name(app):
    led = L(app)
    led.bulk_add(USER, [{"new_instrument": {"asset_class": "equity", "name": "Wipro"},
                         "txns": [{"date": "2026-01-02", "type": "BUY", "quantity": 3, "amount": 900},
                                  {"date": "2026-01-05", "type": "SELL", "quantity": 1, "amount": 320}],
                         "source": "import:csv"}], check_holdings=False)
    wipro = next(i for i in led.load(USER)["instruments"] if i["name"] == "Wipro")
    assert sorted(t["type"] for t in led.load(USER)["transactions"] if t["instrument_id"] == wipro["id"]) == ["BUY", "SELL"]
    before = counts(app)
    with pytest.raises(ValidationError):                  # one bad transaction: nothing of the batch is written
        led.bulk_add(USER, [{"new_instrument": {"asset_class": "equity", "name": "Tata Steel"},
                             "txns": [{"date": "2026-01-02", "type": "BUY", "quantity": 3, "amount": 900},
                                      {"date": "2026-01-03", "type": "BUY", "quantity": 0, "amount": 100}]}])
    assert counts(app) == before


def test_bulk_add_rolls_back_when_sql_fails_partway_through_the_batch(app):
    """A statement that fails inside `db.batch`, after earlier deletes, updates and inserts have run, leaves nothing
    behind (the pre-batch validation test above never reaches the database)."""
    led = L(app)
    led.bulk_add(USER, [{"new_instrument": {"asset_class": "equity", "name": "Wipro"},
                         "txns": [{"date": "2026-01-02", "type": "BUY", "quantity": 3, "amount": 900},
                                  {"date": "2026-01-05", "type": "SELL", "quantity": 1, "amount": 320}]}],
                 check_holdings=False)
    wipro = next(i for i in led.load(USER)["instruments"] if i["name"] == "Wipro")
    txns = {t["type"]: t for t in led.load(USER)["transactions"] if t["instrument_id"] == wipro["id"]}
    db = led.db
    # the status update is the batch's last statement: make SQLite itself refuse it
    db.execute("CREATE TRIGGER refuse_boom BEFORE UPDATE OF status ON instruments WHEN NEW.status = 'boom' "
               "BEGIN SELECT RAISE(ABORT, 'boom'); END")

    def snapshot():
        return (counts(app), db.one("SELECT COUNT(*) AS n FROM cash_movements")["n"],
                db.query("SELECT id, quantity, amount, notes FROM transactions ORDER BY id"),
                db.query("SELECT id, name, status FROM instruments ORDER BY id"))

    before = snapshot()
    with pytest.raises(Exception, match="boom"):
        led.bulk_add(USER, [{"new_instrument": {"asset_class": "equity", "name": "Tata Steel"},
                             "txns": [{"date": "2026-01-02", "type": "BUY", "quantity": 3, "amount": 900}]},
                            {"instrument": wipro, "txn": {"date": "2026-01-06", "type": "BUY", "quantity": 2, "amount": 640}}],
                     remove_txns=[txns["SELL"]["id"]], txn_updates=[(txns["BUY"]["id"], {"notes": "edited"})],
                     field_updates=[(wipro["id"], {"name": "Wipro Ltd"})], status_updates=[(wipro["id"], "boom")],
                     check_holdings=False)
    assert snapshot() == before
    db.execute("DROP TRIGGER refuse_boom")
    led.bulk_add(USER, [], status_updates=[(wipro["id"], "boom")])   # the same write lands once SQLite allows it
    assert led.instrument(wipro["id"], USER)["status"] == "boom"


# ── action-log helpers ──

def test_mark_seen_and_pushed_stamp_once_and_never_bump(app):
    led = L(app)
    led.set_action_status(USER, "fd:maturing:1", "planned")
    version, rev = led._version, led.actions_rev
    cache = dict(led._cache)
    assert led.mark_seen(USER, ["fd:maturing:1", "notice:market-dip", "tax:ltcg-harvest", "fd:maturing:1"],
                         at="2026-11-01T09:00:00Z") == 3
    assert led.mark_seen(USER, ["fd:maturing:1", "notice:market-dip"], at="2026-11-02T09:00:00Z") == 0   # already seen
    assert led.mark_pushed(USER, ["fd:maturing:1", "notice:sip-due"], at="2026-11-03T09:00:00Z") == 2
    assert led.mark_pushed(USER, ["fd:maturing:1"]) == 0
    assert led.mark_seen(USER, []) == 0 and led.mark_pushed(USER, None) == 0
    assert (led._version, led.actions_rev) == (version, rev) and led._cache == cache

    log = led.action_log([USER])
    fd, notice, tax, pushed = (log[(USER, k)] for k in ("fd:maturing:1", "notice:market-dip", "tax:ltcg-harvest", "notice:sip-due"))
    assert fd["status"] == "planned" and fd["seen_at"] == "2026-11-01T09:00:00Z" and fd["pushed_at"] == "2026-11-03T09:00:00Z"
    assert (notice["status"], notice["tier_first"], notice["done_via"], notice["seen_at"]) == ("done", None, "seen", "2026-11-01T09:00:00Z")
    assert tax["status"] == "open" and tax["seen_at"] and tax["pushed_at"] is None
    assert pushed["status"] == "open" and pushed["pushed_at"] == "2026-11-03T09:00:00Z" and pushed["seen_at"] is None
    # a pushed notice that is then seen is closed like any seen notice
    assert led.mark_seen(USER, ["notice:sip-due"]) == 1
    assert led.action_row(USER, "notice:sip-due")["status"] == "done"
    # rows are per owner
    assert led.mark_seen(OTHER, ["notice:market-dip"]) == 1


def test_notice_rows_never_count_toward_follow_through(app):
    led = L(app)
    led.mark_seen(USER, [f"notice:n{k}" for k in range(5)])
    ft = follow_through(led.action_log([USER]), None)
    assert ft["acted_90d"] == {"done": 0, "total": 0, "pct": None}
    assert ft["median_days_to_act"] is None and ft["impact_realised_fy"] == 0
    led.upsert_action_seen(USER, [{"id": "fd:maturing:9", "tier_first": "now", "status": "done", "done_at": "2026-11-10"}])
    ft = follow_through(led.action_log([USER]), None)
    assert ft["acted_90d"]["done"] == 1 and ft["acted_90d"]["total"] == 1


def test_kpi_snapshots_ascending_and_skips_malformed_rows(app):
    led = L(app)
    for day, val in (("2026-03-01", 3), ("2026-01-01", 1), ("2026-02-01", 2)):
        led.kpi_snapshot_write(USER, day, {"total": val})
    led.kpi_snapshot_write(OTHER, "2026-01-15", {"total": 99})
    led.db.execute("INSERT INTO kpi_snapshots (owner, date, data) VALUES (?, '2026-01-20', 'not json')", (USER,))
    led.db.execute("INSERT INTO kpi_snapshots (owner, date, data) VALUES (?, '2026-01-21', '[1, 2]')", (USER,))
    version = led._version
    assert led.kpi_snapshots(USER) == [{"date": "2026-01-01", "data": {"total": 1}}, {"date": "2026-02-01", "data": {"total": 2}},
                                       {"date": "2026-03-01", "data": {"total": 3}}]
    assert [s["date"] for s in led.kpi_snapshots(USER, since="2026-01-02")] == ["2026-02-01", "2026-03-01"]
    assert [s["date"] for s in led.kpi_snapshots(USER, until="2026-02-01")] == ["2026-01-01", "2026-02-01"]
    assert led.kpi_snapshots(USER, since="2026-02-01", until="2026-02-01") == [{"date": "2026-02-01", "data": {"total": 2}}]
    assert led.kpi_snapshots("nobody@example.com") == []
    assert led._version == version
