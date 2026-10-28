import hashlib
import json

from tracker.db import SqliteDatabase
from tracker.migrations import LEGACY_TABLES, run_migrations, verify_legacy_import
from tracker.analytics.portfolio import compute_portfolio


def legacy_fingerprint(db):
    out = {}
    for t in LEGACY_TABLES + ("allowlist", "users"):
        if db.table_exists(t):
            rows = db.query(f'SELECT * FROM "{t}" ORDER BY rowid')
            out[t] = hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()
    return out


def test_legacy_import_reconciles_and_never_touches_legacy_rows(legacy_copy):
    db = SqliteDatabase(legacy_copy)
    before = legacy_fingerprint(db)
    assert run_migrations(db, log=lambda *_: None) == [1, 2]
    assert verify_legacy_import(db) == []
    assert legacy_fingerprint(db) == before
    assert run_migrations(db, log=lambda *_: None) == []  # idempotent


def test_imported_p2p_outstanding_matches_legacy_dashboard(legacy_copy):
    db = SqliteDatabase(legacy_copy)
    run_migrations(db, log=lambda *_: None)
    # legacy dashboard: total lent minus principal repaid (capped per loan)
    legacy = db.one("""SELECT SUM(p.amount) - SUM(MIN(COALESCE((SELECT SUM(principal) FROM p2p_repayments r
                       WHERE r.lending_id = p.lending_id), 0), p.amount)) AS out FROM p2p p""")["out"]
    port = compute_portfolio(db.query("SELECT * FROM instruments"), db.query("SELECT * FROM transactions"), 90.0)
    seg = next(s for s in port["segments"] if s["segment"] == "P2P")
    assert abs(seg["value"] - legacy) < 0.05


def test_imported_open_cost_matches_legacy_fifo(legacy_copy):
    db = SqliteDatabase(legacy_copy)
    run_migrations(db, log=lambda *_: None)
    port = compute_portfolio(db.query("SELECT * FROM instruments"), db.query("SELECT * FROM transactions"), 90.0)
    # Mutual funds have no sales, so open cost must equal the sum of purchases
    mf_cost = sum(p["cost"] for p in port["positions"] if p["asset_class"] == "mutual_fund")
    legacy = db.one("SELECT SUM(buy_value) AS v FROM mutual_funds")["v"]
    assert abs(mf_cost - legacy) < 0.05
