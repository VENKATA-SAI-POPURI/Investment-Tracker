"""Versioned schema migrations.

Each migration runs exactly once, atomically, and is recorded in schema_migrations.
Migration 2 copies the legacy per-asset tables (equity, mutual_funds, commodity, p2p,
p2p_repayments, p2p_escrow, fixed_deposits, forex, capital_flows, equity_dividends,
tickers, settings) into the unified ledger. Legacy tables are only read, never modified.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timezone

from . import domain as d
from .db import Database


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


CORE_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS allowlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT, added_date TEXT, role TEXT NOT NULL DEFAULT 'user')""",
    """CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT, google_id TEXT, name TEXT, picture TEXT, created_at TEXT, last_login TEXT)""",
    """CREATE TABLE instruments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        name TEXT NOT NULL,
        symbol TEXT,
        price_source TEXT,
        market TEXT,
        currency TEXT NOT NULL DEFAULT 'INR',
        sector TEXT,
        market_cap TEXT,
        category TEXT,
        sub_category TEXT,
        tax_class TEXT,
        platform TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        ref TEXT,
        ref2 TEXT,
        rate REAL,
        tenure_months REAL,
        maturity_date TEXT,
        notes TEXT,
        last_price REAL,
        prev_close REAL,
        last_price_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        legacy_ref TEXT)""",
    "CREATE INDEX idx_instruments_owner ON instruments(owner, asset_class)",
    "CREATE INDEX idx_instruments_ref ON instruments(owner, ref)",
    """CREATE UNIQUE INDEX ux_instruments_name ON instruments(owner, asset_class, name)
        WHERE asset_class IN ('equity', 'mutual_fund', 'commodity', 'cash')""",
    """CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        type TEXT NOT NULL,
        quantity REAL,
        amount REAL NOT NULL DEFAULT 0,
        amount_fc REAL,
        principal REAL,
        fees REAL,
        notes TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        legacy_ref TEXT)""",
    "CREATE INDEX idx_txn_owner ON transactions(owner, date)",
    "CREATE INDEX idx_txn_instrument ON transactions(instrument_id, date)",
    """CREATE TABLE cash_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        account TEXT NOT NULL,
        date TEXT NOT NULL,
        direction TEXT NOT NULL,
        amount REAL NOT NULL,
        category TEXT,
        kind TEXT,
        notes TEXT,
        transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        legacy_ref TEXT)""",
    "CREATE INDEX idx_cash_owner ON cash_movements(owner, account, date)",
    "CREATE INDEX idx_cash_txn ON cash_movements(transaction_id)",
    """CREATE TABLE user_settings (
        owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT,
        PRIMARY KEY (owner, key))""",
    """CREATE TABLE goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        target_amount REAL NOT NULL,
        target_date TEXT NOT NULL,
        monthly_contribution REAL NOT NULL DEFAULT 0,
        expected_return REAL,
        allocation TEXT,
        priority TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL)""",
    "CREATE INDEX idx_goals_owner ON goals(owner)",
    """CREATE TABLE price_history (
        symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
        PRIMARY KEY (symbol, date))""",
    """CREATE TABLE price_meta (
        symbol TEXT PRIMARY KEY, fetched_at TEXT, first_date TEXT, last_date TEXT)""",
]


def m001_core_schema(db: Database) -> list:
    return [(sql, None) for sql in CORE_SCHEMA]


# ─────────────────────────── legacy import ───────────────────────────

LEGACY_TABLES = ("equity", "mutual_funds", "commodity", "p2p", "p2p_repayments", "p2p_escrow",
                 "fixed_deposits", "forex", "capital_flows", "equity_dividends", "tickers", "settings")

_RATE_RE = re.compile(r"Rate:\s*([\d.]+)\s*%", re.I)


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _opt(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_legacy(db: Database) -> dict[str, list[dict]]:
    data = {}
    for t in LEGACY_TABLES:
        data[t] = db.query(f'SELECT * FROM "{t}" ORDER BY rowid') if db.table_exists(t) else []
    return data


def build_ledger_from_legacy(legacy: dict[str, list[dict]], fallback_owner: str) -> dict[str, list[dict]]:
    """Pure transformation legacy rows -> {instruments, transactions, cash_movements, user_settings}."""
    ts = now_iso()
    instruments: list[dict] = []
    txns: list[dict] = []
    cash: list[dict] = []
    by_key: dict[tuple, dict] = {}
    tickers = {(t["asset_type"], t["name"]): t for t in legacy["tickers"]}

    def owner_of(row):
        return (row.get("created_by") or "").strip() or fallback_owner

    def instrument(owner, asset_class, name, **fields) -> dict:
        key = (owner, asset_class, name)
        inst = by_key.get(key)
        if inst is None:
            inst = {"id": len(instruments) + 1, "owner": owner, "asset_class": asset_class, "name": name,
                    "symbol": None, "price_source": None, "market": None, "currency": "INR",
                    "sector": None, "market_cap": None, "category": None, "sub_category": None,
                    "tax_class": None, "platform": None, "status": "active", "ref": None, "ref2": None,
                    "rate": None, "tenure_months": None, "maturity_date": None, "notes": None,
                    "last_price": None, "prev_close": None, "last_price_at": None, "created_at": ts, "updated_at": ts,
                    "legacy_ref": None}
            instruments.append(inst)
            if asset_class in d.TRADABLE or asset_class == d.CASH:
                by_key[key] = inst
        for k, v in fields.items():
            if v not in (None, ""):
                inst[k] = v
        return inst

    def txn(inst, date, type_, legacy_ref, **fields) -> dict:
        t = {"id": len(txns) + 1, "owner": inst["owner"], "instrument_id": inst["id"], "date": date,
             "type": type_, "quantity": None, "amount": 0.0, "amount_fc": None, "principal": None,
             "fees": None, "notes": None, "source": "migration", "created_at": ts, "updated_at": ts,
             "legacy_ref": legacy_ref}
        t.update(fields)
        txns.append(t)
        return t

    def apply_ticker(inst, asset_type):
        t = tickers.get((asset_type, inst["name"]))
        if t and t.get("ticker"):
            inst["symbol"] = t["ticker"]
            inst["price_source"] = "yahoo"
            if t.get("price") is not None:
                inst["last_price"] = float(t["price"])

    # Equity — instrument metadata from the latest row per name
    for row in sorted(legacy["equity"], key=lambda r: (r.get("date") or "", r["id"])):
        inst = instrument(owner_of(row), d.EQUITY, row["name"].strip(), market=row.get("market"),
                          sector=row.get("sector"), market_cap=row.get("market_cap"))
    for inst in instruments:
        if inst["asset_class"] == d.EQUITY:
            inst["currency"] = d.currency_for(d.EQUITY, inst["market"])
            inst["tax_class"] = d.default_tax_class(d.EQUITY, inst["market"])
            apply_ticker(inst, "equity")
    for row in legacy["equity"]:
        inst = by_key[(owner_of(row), d.EQUITY, row["name"].strip())]
        txn(inst, row["date"], d.SELL if row.get("buy_sell") == "Sell" else d.BUY, f"equity:{row['id']}",
            quantity=_opt(row.get("quantity")), amount=_f(row.get("value")),
            amount_fc=_opt(row.get("value_usd")) or None, notes=row.get("remarks") or None)

    # Mutual funds & commodity share the buy_*/sell_* layout
    for table, ac, asset_type in (("mutual_funds", d.MUTUAL_FUND, "mf"), ("commodity", d.COMMODITY, "commodity")):
        rows = sorted(legacy[table], key=lambda r: (r.get("date") or "", r["id"]))
        for row in rows:
            if ac == d.MUTUAL_FUND:
                instrument(owner_of(row), ac, row["name"].strip(), category=row.get("category"),
                           sub_category=row.get("fund_type"))
            else:
                instrument(owner_of(row), ac, row["name"].strip(), category=row.get("commodity"))
        for inst in instruments:
            if inst["asset_class"] == ac and inst["tax_class"] is None:
                inst["tax_class"] = d.default_tax_class(ac, None, inst["category"], inst["name"])
                apply_ticker(inst, asset_type)
        for row in legacy[table]:
            inst = by_key[(owner_of(row), ac, row["name"].strip())]
            bq, bv, sq, sv = (_f(row.get(k)) for k in ("buy_quantity", "buy_value", "sell_quantity", "sell_value"))
            if bq or bv:
                txn(inst, row["date"], d.BUY, f"{table}:{row['id']}:buy", quantity=bq or None, amount=bv,
                    notes=row.get("remarks") or None)
            if sq or sv:
                txn(inst, row["date"], d.SELL, f"{table}:{row['id']}:sell", quantity=sq or None, amount=sv,
                    notes=row.get("remarks") or None)

    # Dividends -> DIVIDEND on the equity instrument (linked capital flow remembered)
    dividend_txn_by_cf: dict[int, int] = {}
    for row in legacy["equity_dividends"]:
        owner = owner_of(row)
        inst = by_key.get((owner, d.EQUITY, row["name"].strip())) or instrument(
            owner, d.EQUITY, row["name"].strip(), market="India", tax_class=d.TAX_EQUITY)
        t = txn(inst, row["date"], d.DIVIDEND, f"equity_dividends:{row['id']}", amount=_f(row.get("amount")),
                notes=row.get("remarks") or None)
        if row.get("capital_flow_id"):
            dividend_txn_by_cf[int(float(row["capital_flow_id"]))] = t["id"]

    # P2P loans: one instrument per loan
    loans_by_lid: dict[tuple, dict] = {}
    for row in legacy["p2p"]:
        owner = owner_of(row)
        m = _RATE_RE.search(row.get("remarks") or "")
        inst = instrument(owner, d.P2P, (row.get("name") or row.get("loan_id") or row["lending_id"]).strip(),
                          platform=row.get("platform"), ref=row.get("lending_id"), ref2=row.get("loan_id"),
                          tenure_months=_opt(row.get("tenure")), maturity_date=row.get("maturity_date"),
                          status=(row.get("status") or "Active").lower(),
                          rate=float(m.group(1)) if m else None, notes=row.get("remarks") or None,
                          tax_class=d.TAX_INCOME, legacy_ref=f"p2p:{row['id']}")
        loans_by_lid[(owner, row.get("lending_id"))] = inst
        loans_by_lid.setdefault(("*", row.get("lending_id")), inst)
        txn(inst, row["date"], d.BUY, f"p2p:{row['id']}", amount=_f(row.get("amount")))
    for row in legacy["p2p_repayments"]:
        inst = loans_by_lid.get((owner_of(row), row.get("lending_id"))) or loans_by_lid.get(("*", row.get("lending_id")))
        if inst is None:
            raise ValueError(f"p2p_repayments:{row['id']} references unknown lending_id {row.get('lending_id')}")
        principal = _opt(row.get("principal"))
        credited = (principal or 0) + _f(row.get("interest")) if principal is not None else _f(row.get("amount"))
        src = row.get("source")
        txn(inst, row["date"], d.REPAYMENT, f"p2p_repayments:{row['id']}", amount=round(credited, 4),
            principal=principal, fees=_opt(row.get("platform_fee")), notes=row.get("remarks") or None,
            source="import:lenden" if src == "statement_import" else "migration")

    # Fixed deposits
    for row in legacy["fixed_deposits"]:
        ret = _f(row.get("return_value"))
        inst = instrument(owner_of(row), d.FIXED_DEPOSIT, (row.get("bank_name") or "FD").strip(),
                          platform=row.get("platform"), rate=_opt(row.get("interest")),
                          maturity_date=row.get("maturity_date"), status="closed" if ret > 0 else "active",
                          tax_class=d.TAX_INCOME, notes=row.get("remarks") or None, legacy_ref=f"fixed_deposits:{row['id']}")
        txn(inst, row["date"], d.BUY, f"fixed_deposits:{row['id']}:buy", amount=_f(row.get("fd_value")))
        if ret > 0:
            txn(inst, row.get("maturity_date") or row["date"], d.MATURITY, f"fixed_deposits:{row['id']}:maturity",
                amount=ret, principal=_f(row.get("fd_value")))

    # Forex -> USD wallet
    for row in legacy["forex"]:
        inst = instrument(owner_of(row), d.CASH, "USD Wallet", market="USA", currency="USD", tax_class=d.TAX_INCOME)
        txn(inst, row["date"], d.FX_OUT if (row.get("type") or "").lower() == "withdrawal" else d.FX_IN,
            f"forex:{row['id']}", amount=_f(row.get("inr_amount")), amount_fc=_f(row.get("usd_amount")),
            notes=row.get("remarks") or None)

    # Capital flows & P2P escrow -> cash_movements
    for row in legacy["capital_flows"]:
        kind = row.get("type") or "Deposit"
        cash.append({"id": len(cash) + 1, "owner": owner_of(row), "account": "capital", "date": row["date"],
                     "direction": "in" if kind == "Deposit" else "out", "amount": _f(row.get("amount")),
                     "category": row.get("category"), "kind": kind, "notes": row.get("remarks") or None,
                     "transaction_id": dividend_txn_by_cf.get(row["id"]), "source": "migration",
                     "created_at": ts, "updated_at": ts, "legacy_ref": f"capital_flows:{row['id']}"})
    for row in legacy["p2p_escrow"]:
        kind = row.get("type") or "Deposit"
        cash.append({"id": len(cash) + 1, "owner": owner_of(row), "account": "p2p_escrow", "date": row["date"],
                     "direction": "in" if kind == "Deposit" else "out", "amount": _f(row.get("amount")),
                     "category": row.get("platform"), "kind": kind, "notes": row.get("remarks") or None,
                     "transaction_id": None, "source": "migration", "created_at": ts, "updated_at": ts,
                     "legacy_ref": f"p2p_escrow:{row['id']}"})

    settings = [{"owner": "__global__", "key": s["key"], "value": s["value"], "updated_at": ts}
                for s in legacy["settings"]]
    return {"instruments": instruments, "transactions": txns, "cash_movements": cash, "user_settings": settings}


def legacy_totals(legacy: dict[str, list[dict]]) -> dict[str, float]:
    """Control totals computed straight from the legacy rows."""
    t: dict[str, float] = defaultdict(float)
    for r in legacy["equity"]:
        side = "sell" if r.get("buy_sell") == "Sell" else "buy"
        t[f"equity.{side}.value"] += _f(r.get("value"))
        t[f"equity.{side}.qty"] += _f(r.get("quantity"))
        t[f"equity.{side}.usd"] += _f(r.get("value_usd"))
    for table in ("mutual_funds", "commodity"):
        for r in legacy[table]:
            t[f"{table}.buy.value"] += _f(r.get("buy_value"))
            t[f"{table}.buy.qty"] += _f(r.get("buy_quantity"))
            t[f"{table}.sell.value"] += _f(r.get("sell_value"))
            t[f"{table}.sell.qty"] += _f(r.get("sell_quantity"))
    t["dividends"] = sum(_f(r.get("amount")) for r in legacy["equity_dividends"])
    t["p2p.lent"] = sum(_f(r.get("amount")) for r in legacy["p2p"])
    t["p2p.loans"] = len(legacy["p2p"])
    for r in legacy["p2p_repayments"]:
        t["p2p.principal"] += _f(r.get("principal"))
        t["p2p.fees"] += _f(r.get("platform_fee"))
        t["p2p.credited"] += (_f(r.get("principal")) + _f(r.get("interest"))) if r.get("principal") is not None else _f(r.get("amount"))
    for r in legacy["fixed_deposits"]:
        t["fd.value"] += _f(r.get("fd_value"))
        t["fd.return"] += _f(r.get("return_value"))
    for r in legacy["forex"]:
        side = "out" if (r.get("type") or "").lower() == "withdrawal" else "in"
        t[f"forex.{side}.inr"] += _f(r.get("inr_amount"))
        t[f"forex.{side}.usd"] += _f(r.get("usd_amount"))
    for r in legacy["capital_flows"]:
        t[f"capital.{r.get('type')}"] += _f(r.get("amount"))
    for r in legacy["p2p_escrow"]:
        t[f"escrow.{r.get('type')}"] += _f(r.get("amount"))
    t["rows.capital_flows"] = len(legacy["capital_flows"])
    t["rows.p2p_escrow"] = len(legacy["p2p_escrow"])
    return dict(t)


def ledger_totals(ledger: dict[str, list[dict]]) -> dict[str, float]:
    """The same control totals computed from ledger rows (works on in-memory rows or DB rows)."""
    inst = {i["id"]: i for i in ledger["instruments"]}
    t: dict[str, float] = defaultdict(float)
    table_of = {d.MUTUAL_FUND: "mutual_funds", d.COMMODITY: "commodity"}
    for x in ledger["transactions"]:
        ac = inst[x["instrument_id"]]["asset_class"]
        amt, qty = _f(x["amount"]), _f(x["quantity"])
        typ = x["type"]
        if ac == d.EQUITY and typ in (d.BUY, d.SELL):
            side = typ.lower()
            t[f"equity.{side}.value"] += amt
            t[f"equity.{side}.qty"] += qty
            t[f"equity.{side}.usd"] += _f(x["amount_fc"])
        elif ac in table_of and typ in (d.BUY, d.SELL):
            side = typ.lower()
            t[f"{table_of[ac]}.{side}.value"] += amt
            t[f"{table_of[ac]}.{side}.qty"] += qty
        elif typ == d.DIVIDEND:
            t["dividends"] += amt
        elif ac == d.P2P and typ == d.BUY:
            t["p2p.lent"] += amt
            t["p2p.loans"] += 1
        elif typ == d.REPAYMENT:
            t["p2p.principal"] += _f(x["principal"])
            t["p2p.fees"] += _f(x["fees"])
            t["p2p.credited"] += amt
        elif ac == d.FIXED_DEPOSIT and typ == d.BUY:
            t["fd.value"] += amt
        elif typ == d.MATURITY:
            t["fd.return"] += amt
        elif typ in (d.FX_IN, d.FX_OUT):
            side = "in" if typ == d.FX_IN else "out"
            t[f"forex.{side}.inr"] += amt
            t[f"forex.{side}.usd"] += _f(x["amount_fc"])
    for c in ledger["cash_movements"]:
        acct = "capital" if c["account"] == "capital" else "escrow"
        t[f"{acct}.{c['kind']}"] += _f(c["amount"])
        t[f"rows.{'capital_flows' if acct == 'capital' else 'p2p_escrow'}"] += 1
    return dict(t)


def compare_totals(expected: dict, actual: dict, tol: float = 0.01) -> list[str]:
    problems = []
    for k in sorted(set(expected) | set(actual)):
        e, a = round(expected.get(k, 0.0), 6), round(actual.get(k, 0.0), 6)
        if abs(e - a) > tol:
            problems.append(f"{k}: legacy={e} ledger={a}")
    return problems


_COLS = {
    "instruments": ["id", "owner", "asset_class", "name", "symbol", "price_source", "market", "currency", "sector",
                    "market_cap", "category", "sub_category", "tax_class", "platform", "status", "ref", "ref2", "rate",
                    "tenure_months", "maturity_date", "notes", "last_price", "prev_close", "last_price_at", "created_at",
                    "updated_at", "legacy_ref"],
    "transactions": ["id", "owner", "instrument_id", "date", "type", "quantity", "amount", "amount_fc", "principal",
                     "fees", "notes", "source", "created_at", "updated_at", "legacy_ref"],
    "cash_movements": ["id", "owner", "account", "date", "direction", "amount", "category", "kind", "notes",
                       "transaction_id", "source", "created_at", "updated_at", "legacy_ref"],
    "user_settings": ["owner", "key", "value", "updated_at"],
}


def insert_statements(table: str, rows: list[dict], chunk: int = 40) -> list:
    cols = _COLS[table]
    out = []
    for i in range(0, len(rows), chunk):
        part = rows[i:i + chunk]
        ph = "(" + ",".join("?" * len(cols)) + ")"
        sql = f"INSERT INTO {table} ({','.join(cols)}) VALUES " + ",".join([ph] * len(part))
        out.append((sql, [r.get(c) for r in part for c in cols]))
    return out


def m002_legacy_import(db: Database) -> list:
    if not db.table_exists("equity"):
        return []  # fresh install, nothing to import
    if db.one("SELECT COUNT(*) AS n FROM instruments")["n"]:
        return []
    admin = db.one("SELECT email FROM allowlist WHERE role='admin' ORDER BY id LIMIT 1")
    legacy = load_legacy(db)
    ledger = build_ledger_from_legacy(legacy, fallback_owner=(admin or {}).get("email") or "unknown")
    problems = compare_totals(legacy_totals(legacy), ledger_totals(ledger))
    if problems:
        raise RuntimeError("Legacy import reconciliation failed; nothing written:\n" + "\n".join(problems))
    stmts = []
    for table in ("instruments", "transactions", "cash_movements", "user_settings"):
        stmts += insert_statements(table, ledger[table])
    report = {"at": now_iso(), "counts": {k: len(v) for k, v in ledger.items()}, "reconciled": True}
    stmts.append(("INSERT INTO user_settings (owner, key, value, updated_at) VALUES ('__system__', 'legacy_import', ?, ?)",
                  (json.dumps(report), now_iso())))
    return stmts


MIGRATIONS = [
    (1, "core_schema", m001_core_schema),
    (2, "legacy_import", m002_legacy_import),
]


def run_migrations(db: Database, log=print) -> list[int]:
    db.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)""")
    applied = {r["version"] for r in db.query("SELECT version FROM schema_migrations")}
    done = []
    for version, name, fn in MIGRATIONS:
        if version in applied:
            continue
        stmts = list(fn(db))
        # Recording the version in the same transaction makes a concurrent second runner fail cleanly.
        stmts.insert(0, ("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                         (version, name, now_iso())))
        db.batch(stmts)
        log(f"[migrations] applied {version:03d}_{name} ({len(stmts) - 1} statements)")
        done.append(version)
    return done


def verify_legacy_import(db: Database) -> list[str]:
    """Re-read both sides from the database and compare control totals."""
    if not db.table_exists("equity"):
        return []
    ledger = {t: db.query(f"SELECT * FROM {t}") for t in ("instruments", "transactions", "cash_movements")}
    ledger["cash_movements"] = [c for c in ledger["cash_movements"] if c["source"] == "migration"]
    ledger["transactions"] = [x for x in ledger["transactions"] if x["legacy_ref"]]
    return compare_totals(legacy_totals(load_legacy(db)), ledger_totals(ledger))
