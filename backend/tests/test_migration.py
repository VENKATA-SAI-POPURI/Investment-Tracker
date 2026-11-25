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
    assert run_migrations(db, log=lambda *_: None) == [1, 2, 3, 4, 5, 6, 7, 8]
    assert "goal_id" in db.columns("sip_plans")
    assert verify_legacy_import(db) == []
    assert legacy_fingerprint(db) == before
    assert run_migrations(db, log=lambda *_: None) == []  # idempotent


def _instrument(db, owner, name):
    ts = "2026-01-01T00:00:00Z"
    return db.execute("INSERT INTO instruments (owner, asset_class, name, created_at, updated_at) VALUES (?, 'equity', ?, ?, ?)",
                      (owner, name, ts, ts)).lastrowid


def test_m005_migrates_snoozes_to_the_right_owner_and_is_idempotent(tmp_path, monkeypatch):
    from datetime import date
    from tracker import migrations
    db = SqliteDatabase(str(tmp_path / "m005.db"))
    monkeypatch.setattr(migrations, "MIGRATIONS", migrations.MIGRATIONS[:4])
    assert run_migrations(db, log=lambda *_: None) == [1, 2, 3, 4]
    monkeypatch.undo()
    mine, theirs = _instrument(db, "user@example.com", "TCS"), _instrument(db, "other@example.com", "INFY")
    settings = {
        "__global__": {f"concentration:{theirs}": "2026-12-31", "fd:maturing:9999": "2026-12-01",   # instrument gone
                       f"tax:wait-lt:{mine}:2027-01-15": "2026-12-15", "review:due": "2026-11-30",
                       "winner:abc": "2026-12-02"},
        "user@example.com": {"tax:ltcg-harvest": "2027-01-01", f"loser:{mine}": "2026-12-20"},
    }
    for owner, value in settings.items():
        db.execute("INSERT INTO user_settings (owner, key, value, updated_at) VALUES (?, 'dismissedInsights', ?, 'x')",
                   (owner, json.dumps(value)))
    db.execute("INSERT INTO user_settings (owner, key, value, updated_at) VALUES ('bad@example.com', 'dismissedInsights', 'oops', 'x')")

    assert run_migrations(db, log=lambda *_: None) == [5, 6, 7, 8]
    rows = {(r["owner"], r["id"]): r for r in db.query("SELECT * FROM action_log")}
    assert {k: rows[k]["snooze_until"] for k in rows} == {
        ("other@example.com", f"concentration:{theirs}"): "2026-12-31",
        ("user@example.com", f"tax:wait-lt:{mine}:2027-01-15"): "2026-12-15",
        ("__global__", "review:due"): "2026-11-30",
        ("__global__", "winner:abc"): "2026-12-02",           # not an instrument id: stays with the setting's owner
        ("user@example.com", "tax:ltcg-harvest"): "2027-01-01",
        ("user@example.com", f"loser:{mine}"): "2026-12-20",
    }
    assert {r["status"] for r in rows.values()} == {"snoozed"}
    assert {r["first_seen"] for r in rows.values()} == {date.today().isoformat()}
    assert db.table_exists("kpi_snapshots")
    # The setting is kept for rollback
    assert db.one("SELECT COUNT(*) AS n FROM user_settings WHERE key = 'dismissedInsights'")["n"] == 3

    # Idempotent: the version is recorded, and replaying the step itself changes nothing
    assert run_migrations(db, log=lambda *_: None) == []
    db.execute("UPDATE action_log SET status = 'done' WHERE id = 'review:due'")
    db.batch(migrations.m005_actions_snapshots(db))
    after = {(r["owner"], r["id"]): r["status"] for r in db.query("SELECT * FROM action_log")}
    assert len(after) == len(rows) and after[("__global__", "review:due")] == "done"


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
