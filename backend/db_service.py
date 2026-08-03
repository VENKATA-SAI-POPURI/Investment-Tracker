import os
import sqlite3
import threading
import time
import warnings
import requests
from contextlib import contextmanager


class TursoConnection:
    """Minimal sqlite3-compatible wrapper around Turso HTTP API."""

    def __init__(self, url, token):
        # Convert libsql:// to https://
        self._url = url.replace("libsql://", "https://") + "/v2/pipeline"
        self._headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        # On Windows/local dev, SSL cert verification can fail; allow override via env var
        self._verify_ssl = os.environ.get("TURSO_VERIFY_SSL", "true").lower() != "false"

    def execute(self, sql, params=None):
        stmt = {"sql": sql}
        if params:
            args = []
            for v in params:
                if v is None:
                    args.append({"type": "null"})
                elif isinstance(v, bool):
                    args.append({"type": "integer", "value": str(int(v))})
                elif isinstance(v, int):
                    args.append({"type": "integer", "value": str(v)})
                elif isinstance(v, float):
                    args.append({"type": "float", "value": v})
                else:
                    args.append({"type": "text", "value": str(v)})
            stmt["args"] = args
        body = {"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            resp = requests.post(self._url, json=body, headers=self._headers, timeout=15, verify=self._verify_ssl)
        if resp.status_code != 200:
            raise Exception(f"Turso HTTP {resp.status_code}: {resp.text}")
        data = resp.json()
        if "results" not in data:
            raise Exception(f"Turso unexpected response: {data}")
        result = data["results"][0]
        if result["type"] == "error":
            raise Exception(result["error"]["message"])
        res = result["response"]["result"]
        return TursoCursor(res)

    def execute_pipeline(self, queries):
        """Batch multiple SQL queries into a single HTTP round-trip.
        queries: list of (sql, params_list_or_None)
        Returns: list of TursoCursor, one per query.
        """
        def _make_args(params):
            if not params:
                return None
            args = []
            for v in params:
                if v is None:
                    args.append({"type": "null"})
                elif isinstance(v, bool):
                    args.append({"type": "integer", "value": str(int(v))})
                elif isinstance(v, int):
                    args.append({"type": "integer", "value": str(v)})
                elif isinstance(v, float):
                    args.append({"type": "float", "value": v})
                else:
                    args.append({"type": "text", "value": str(v)})
            return args

        requests_list = []
        for sql, params in queries:
            stmt = {"sql": sql}
            args = _make_args(params)
            if args:
                stmt["args"] = args
            requests_list.append({"type": "execute", "stmt": stmt})
        requests_list.append({"type": "close"})

        body = {"requests": requests_list}
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            resp = requests.post(self._url, json=body, headers=self._headers, timeout=15, verify=self._verify_ssl)
        if resp.status_code != 200:
            raise Exception(f"Turso HTTP {resp.status_code}: {resp.text}")
        data = resp.json()
        if "results" not in data:
            raise Exception(f"Turso unexpected response: {data}")

        cursors = []
        for i in range(len(queries)):
            result = data["results"][i]
            if result["type"] == "error":
                raise Exception(result["error"]["message"])
            res = result["response"]["result"]
            cursors.append(TursoCursor(res))
        return cursors

    def commit(self):
        pass  # Turso auto-commits

    def close(self):
        pass


class TursoCursor:
    """Wraps Turso HTTP response to look like sqlite3 cursor."""

    def __init__(self, result):
        self._cols = [c["name"] for c in result.get("cols", [])]
        self._rows = result.get("rows", [])
        self._idx = 0
        self.lastrowid = result.get("last_insert_rowid")
        self.rowcount = result.get("affected_row_count", 0)

    def fetchone(self):
        if self._idx >= len(self._rows):
            return None
        row = self._rows[self._idx]
        self._idx += 1
        return _TursoRow(self._cols, row)

    def fetchall(self):
        rows = []
        while self._idx < len(self._rows):
            rows.append(_TursoRow(self._cols, self._rows[self._idx]))
            self._idx += 1
        return rows

    def __iter__(self):
        for i in range(len(self._rows)):
            yield _TursoRow(self._cols, self._rows[i])


class _TursoRow:
    """Dict-like row to mimic sqlite3.Row."""

    def __init__(self, cols, row_data):
        self._data = {}
        for i, col in enumerate(cols):
            cell = row_data[i]
            if isinstance(cell, dict):
                ctype = cell.get("type", "text")
                if ctype == "null":
                    val = None
                elif ctype == "integer":
                    val = int(cell["value"])
                elif ctype == "float":
                    val = float(cell["value"])
                else:
                    val = cell.get("value")
            else:
                val = cell
            self._data[col] = val

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self._data.values())[key]
        return self._data[key]

    def keys(self):
        return self._data.keys()

TABLES = {
    "equity": {
        "columns": ["market", "market_cap", "date", "sector", "name", "quantity", "value", "value_usd", "buy_sell", "remarks"],
        "buy_col": "value",
        "buy_where": "buy_sell = 'Buy'",
        "sell_col": "value",
        "sell_where": "buy_sell = 'Sell'",
        "no_upsert": True,
    },
    "commodity": {
        "columns": ["year", "commodity", "name", "date", "buy_quantity", "buy_value", "sell_quantity", "sell_value", "buy_sell", "remarks"],
        "buy_col": "buy_value",
        "sell_col": "sell_value",
    },
    "mutual_funds": {
        "columns": ["year", "category", "fund_type", "name", "date", "buy_quantity", "buy_value", "sell_quantity", "sell_value", "buy_sell", "remarks"],
        "buy_col": "buy_value",
        "sell_col": "sell_value",
    },
    "p2p": {
        "columns": ["lending_id", "loan_id", "platform", "name", "date", "amount", "tenure", "maturity_date", "status", "remarks"],
        "buy_col": "amount",
        "sell_col": None,
    },
    "p2p_repayments": {
        "columns": ["lending_id", "date", "principal", "interest", "platform_fee", "amount", "source", "remarks"],
        "buy_col": None,
        "sell_col": "amount",
    },
    "p2p_escrow": {
        "columns": ["date", "type", "amount", "platform", "remarks"],
        "buy_col": "amount",
        "sell_col": None,
    },
    "fixed_deposits": {
        "columns": ["year", "platform", "bank_name", "date", "fd_value", "interest", "maturity_date", "return_value", "remarks"],
        "buy_col": "fd_value",
        "sell_col": "return_value",
    },
    "forex": {
        "columns": ["date", "type", "inr_amount", "usd_amount", "rate", "remarks"],
        "buy_col": "inr_amount",
        "sell_col": "usd_amount",
    },
    "capital_flows": {
        "columns": ["date", "amount", "type", "category", "remarks"],
        "buy_col": None,
        "sell_col": None,
        "no_upsert": True,
    },
    "equity_dividends": {
        "columns": ["name", "date", "amount", "remarks", "capital_flow_id"],
        "buy_col": None,
        "sell_col": None,
        "no_upsert": True,
    },
    "allowlist": {
        "columns": ["email", "added_date", "role"],
        "no_upsert": True,
    },
    "users": {
        "columns": ["email", "google_id", "name", "picture", "created_at", "last_login"],
        "no_upsert": True,
    },
}

# Map sheet names used in app.py to table names
SHEET_TO_TABLE = {
    "Equity": "equity",
    "Commodity": "commodity",
    "Mutual Funds": "mutual_funds",
    "P2P": "p2p",
    "P2P Repayments": "p2p_repayments",
    "P2P Escrow": "p2p_escrow",
    "Fixed Deposits": "fixed_deposits",
    "Forex": "forex",
    "Capital Flows": "capital_flows",
    "Equity Dividends": "equity_dividends",
}

NUMERIC_FIELDS = {
    # New transaction-level equity fields
    "quantity", "value", "value_usd",
    # Legacy fields (kept for migration queries)
    "buy_quantity", "buy_value", "buy_value_usd", "sell_quantity", "sell_value", "sell_value_usd",
    "amount", "tenure", "fd_value",
    "interest", "return_value",
    "inr_amount", "usd_amount", "rate",
    # P2P repayment breakdown fields
    "principal", "platform_fee",
    # Dividend capital flow linkage
    "capital_flow_id",
}

UPSERT_FIELDS = NUMERIC_FIELDS | {"date", "maturity_date", "buy_sell"}


def _col_type(col):
    if col in NUMERIC_FIELDS:
        return "REAL"
    return "TEXT"


class _Cache:
    """Simple in-memory TTL cache for DB query results."""
    def __init__(self, ttl=60):
        self._store = {}
        self._ttl = ttl
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            entry = self._store.get(key)
        if entry:
            val, ts = entry
            if time.time() - ts < self._ttl:
                return val
            with self._lock:
                self._store.pop(key, None)
        return None

    def set(self, key, val):
        with self._lock:
            self._store[key] = (val, time.time())

    def invalidate(self, *keys):
        with self._lock:
            for k in keys:
                self._store.pop(k, None)

    def clear(self):
        with self._lock:
            self._store.clear()


class DbService:
    def __init__(self, db_path, turso_url=None, turso_token=None):
        self.db_path = db_path
        self.turso_url = turso_url
        self.turso_token = turso_token
        self._lock = threading.Lock()
        self._cache = _Cache(ttl=60)
        self._init_db()

    def _connect(self):
        if self.turso_url and self.turso_token:
            return TursoConnection(self.turso_url, self.turso_token)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @contextmanager
    def _db_lock(self):
        """Skip threading lock for Turso (each call is a stateless HTTP request);
        use lock only for local SQLite to prevent concurrent write corruption."""
        if self.turso_url:
            yield
        else:
            with self._lock:
                yield

    def _migrate_p2p_v3(self, conn):
        """Add loan_id to p2p and source to p2p_repayments if missing."""
        for tbl, col in [("p2p", "loan_id"), ("p2p_repayments", "source")]:
            try:
                conn.execute(f"SELECT {col} FROM {tbl} LIMIT 0")
            except Exception as e:
                if "no such table" in str(e).lower():
                    continue
                try:
                    conn.execute(f"ALTER TABLE {tbl} ADD COLUMN {col} TEXT")
                    conn.commit()
                    print(f"[db_service] {tbl} migrated: added {col} column.")
                except Exception:
                    import traceback
                    traceback.print_exc()

    def _migrate_p2p_repayments_v2(self, conn):
        """Add principal, interest, platform_fee columns to p2p_repayments if missing."""
        try:
            conn.execute("SELECT principal FROM p2p_repayments LIMIT 0")
            return  # Already migrated
        except Exception as e:
            if "no such table" in str(e).lower():
                return  # Table not yet created; will be created with correct schema
        try:
            conn.execute("ALTER TABLE p2p_repayments ADD COLUMN principal REAL")
            conn.execute("ALTER TABLE p2p_repayments ADD COLUMN interest REAL")
            conn.execute("ALTER TABLE p2p_repayments ADD COLUMN platform_fee REAL")
            conn.commit()
            print("[db_service] p2p_repayments migrated: added principal, interest, platform_fee columns.")
        except Exception:
            import traceback
            traceback.print_exc()

    def _migrate_equity_v2(self, conn):
        """Migrate equity table from master (buy/sell columns) to transaction-level schema."""
        try:
            conn.execute("SELECT buy_quantity FROM equity LIMIT 0")
        except Exception:
            return  # Already on new schema or table doesn't exist yet
        try:
            conn.execute("DROP TABLE IF EXISTS equity_txn_new")
            conn.execute("""
                CREATE TABLE equity_txn_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    market TEXT, market_cap TEXT, date TEXT, sector TEXT, name TEXT,
                    quantity REAL, value REAL, value_usd REAL, buy_sell TEXT, remarks TEXT
                )
            """)
            conn.execute("""
                INSERT INTO equity_txn_new
                    (market, market_cap, date, sector, name, quantity, value, value_usd, buy_sell, remarks)
                SELECT
                    market, market_cap, date, sector, name,
                    CASE WHEN COALESCE(buy_sell,'Buy')='Buy' THEN COALESCE(buy_quantity,0) ELSE COALESCE(sell_quantity,0) END,
                    CASE WHEN COALESCE(buy_sell,'Buy')='Buy' THEN COALESCE(buy_value,0) ELSE COALESCE(sell_value,0) END,
                    NULL,
                    COALESCE(buy_sell,'Buy'),
                    remarks
                FROM equity
            """)
            conn.execute("DROP TABLE equity")
            conn.execute("ALTER TABLE equity_txn_new RENAME TO equity")
            conn.commit()
            print("[db_service] Equity table migrated to transaction-level schema.")
        except Exception:
            import traceback
            traceback.print_exc()

    def _migrate_rbac(self, conn):
        """Add role column to allowlist and created_by to all data tables."""
        # allowlist: add role column
        try:
            conn.execute("SELECT role FROM allowlist LIMIT 0")
        except Exception:
            try:
                conn.execute("ALTER TABLE allowlist ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
                conn.commit()
                print("[db_service] allowlist migrated: added role column.")
            except Exception:
                pass

        # All data tables: add created_by column
        data_tables = ["equity", "commodity", "mutual_funds", "p2p", "p2p_repayments",
                       "p2p_escrow", "fixed_deposits", "forex", "capital_flows", "equity_dividends"]
        for tbl in data_tables:
            try:
                conn.execute(f"SELECT created_by FROM {tbl} LIMIT 0")
            except Exception:
                try:
                    conn.execute(f"ALTER TABLE {tbl} ADD COLUMN created_by TEXT")
                    conn.commit()
                    print(f"[db_service] {tbl} migrated: added created_by column.")
                except Exception:
                    pass

    def _migrate_updated_at(self, conn):
        """Add updated_at column to all data tables if missing."""
        data_tables = ["equity", "commodity", "mutual_funds", "p2p", "p2p_repayments",
                       "p2p_escrow", "fixed_deposits", "forex", "capital_flows", "equity_dividends"]
        for tbl in data_tables:
            try:
                conn.execute(f"SELECT updated_at FROM {tbl} LIMIT 0")
            except Exception:
                try:
                    # Use plain TEXT column without DEFAULT expression — Turso (and older SQLite)
                    # do not support function expressions in ALTER TABLE ADD COLUMN DEFAULT clauses.
                    conn.execute(f"ALTER TABLE {tbl} ADD COLUMN updated_at TEXT")
                    conn.commit()
                    print(f"[db_service] {tbl} migrated: added updated_at column.")
                except Exception as e:
                    print(f"[db_service] Could not add updated_at to {tbl}: {e}")

    def _migrate_tickers_unified(self, conn):
        """Copy any remaining data from old separate ticker tables into the unified tickers table.
        Safe to run repeatedly — uses INSERT OR IGNORE. Old tables dropped from Turso on 2026-06-20."""
        for asset_type, old_table in [("equity", "equity_tickers"), ("mf", "mf_tickers"), ("commodity", "commodity_tickers")]:
            try:
                conn.execute(f"SELECT name FROM {old_table} LIMIT 0")
            except Exception:
                continue  # Old table doesn't exist
            try:
                rows = conn.execute(f"SELECT name, ticker, price FROM {old_table}").fetchall()
                for row in rows:
                    conn.execute(
                        "INSERT OR IGNORE INTO tickers (name, asset_type, ticker, price) VALUES (?, ?, ?, ?)",
                        (row["name"], asset_type, row["ticker"], row["price"])
                    )
                conn.commit()
            except Exception as e:
                print(f"[db_service] Ticker migration for {old_table}: {e}")

    def _migrate_ticker_symbol_column(self, conn):
        """Save any ticker symbols stored inline on data rows into the unified tickers table,
        before the orphan 'Ticker Symbol' column is dropped."""
        mappings = [
            ("equity",       "equity"),
            ("commodity",    "commodity"),
            ("mutual_funds", "mf"),
        ]
        for tbl, asset_type in mappings:
            # Check column exists first
            col_exists = False
            try:
                conn.execute(f'SELECT "Ticker Symbol" FROM {tbl} LIMIT 0')
                col_exists = True
            except Exception:
                pass
            if not col_exists:
                continue
            try:
                rows = conn.execute(
                    f'SELECT DISTINCT name, "Ticker Symbol" FROM {tbl} '
                    f'WHERE "Ticker Symbol" IS NOT NULL AND "Ticker Symbol" != \'\''
                ).fetchall()
                saved = 0
                for row in rows:
                    conn.execute(
                        "INSERT OR IGNORE INTO tickers (name, asset_type, ticker) VALUES (?, ?, ?)",
                        (row["name"], asset_type, row["Ticker Symbol"])
                    )
                    saved += 1
                if saved:
                    conn.commit()
                    print(f"[db_service] Saved {saved} ticker symbols from {tbl}.\"Ticker Symbol\" → tickers")
            except Exception as e:
                print(f"[db_service] _migrate_ticker_symbol_column {tbl}: {e}")

    def _migrate_drop_orphan_columns(self, conn):
        """Drop legacy columns that are no longer used by the application.
        Ticker symbols are now in the unified tickers table; Loan ID is a duplicate of loan_id."""
        orphans = [
            ("equity",       "Ticker Symbol"),
            ("commodity",    "Ticker Symbol"),
            ("mutual_funds", "Ticker Symbol"),
            ("p2p",          "Loan ID"),
        ]
        for tbl, col in orphans:
            try:
                conn.execute(f'SELECT "{col}" FROM {tbl} LIMIT 0')
            except Exception:
                continue  # Column already gone
            try:
                conn.execute(f'ALTER TABLE {tbl} DROP COLUMN "{col}"')
                conn.commit()
                print(f"[db_service] {tbl}: dropped orphan column '{col}'")
            except Exception as e:
                print(f"[db_service] Could not drop '{col}' from {tbl}: {e}")

    def _archive_exited_equity(self, conn):
        """Compress fully-exited equity positions (net qty ≈ 0, more than 2 rows) into
        2 aggregate rows (1 Buy + 1 Sell) to reduce row count while preserving P&L accuracy.
        Uses COUNT > 2 guard so already-archived or simple 1-trade positions are never touched."""
        try:
            exited = conn.execute("""
                SELECT name,
                    SUM(CASE WHEN buy_sell='Buy'  THEN quantity ELSE 0 END) as buy_qty,
                    SUM(CASE WHEN buy_sell='Sell' THEN quantity ELSE 0 END) as sell_qty,
                    COUNT(*) as txn_count
                FROM equity
                GROUP BY name
                HAVING buy_qty > 0
                   AND ABS(buy_qty - sell_qty) < 0.001
                   AND txn_count > 2
            """).fetchall()
        except Exception as e:
            print(f"[db_service] _archive_exited_equity query failed: {e}")
            return

        for row in exited:
            name = row["name"]
            try:
                txns = conn.execute(
                    "SELECT * FROM equity WHERE name = ? ORDER BY date", (name,)
                ).fetchall()
                if not txns:
                    continue

                buys  = [t for t in txns if t["buy_sell"] == "Buy"]
                sells = [t for t in txns if t["buy_sell"] == "Sell"]
                if not buys or not sells:
                    continue

                ref = buys[-1]  # metadata from most recent buy row

                # Aggregate totals
                tot_bq = sum(float(t["quantity"] or 0) for t in buys)
                tot_bv = sum(float(t["value"]    or 0) for t in buys)
                tot_bv_usd = sum(float(t["value_usd"] or 0) for t in buys)
                earliest_buy = min((t["date"] or "") for t in buys)

                tot_sq = sum(float(t["quantity"] or 0) for t in sells)
                tot_sv = sum(float(t["value"]    or 0) for t in sells)
                tot_sv_usd = sum(float(t["value_usd"] or 0) for t in sells)
                latest_sell = max((t["date"] or "") for t in sells)

                # Delete all individual rows for this stock
                ids = [t["id"] for t in txns]
                placeholders = ",".join("?" for _ in ids)
                conn.execute(f"DELETE FROM equity WHERE id IN ({placeholders})", ids)

                # Insert 2 aggregate rows
                for bs, qty, val, val_usd, date in [
                    ("Buy",  tot_bq, tot_bv, tot_bv_usd, earliest_buy),
                    ("Sell", tot_sq, tot_sv, tot_sv_usd, latest_sell),
                ]:
                    conn.execute(
                        "INSERT INTO equity (market, market_cap, date, sector, name, "
                        "quantity, value, value_usd, buy_sell, remarks, created_by) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[Archived aggregate]', ?)",
                        (ref["market"], ref["market_cap"], date, ref["sector"],
                         name, qty, val, val_usd, bs, ref["created_by"])
                    )
                conn.commit()
                print(f"[db_service] Archived '{name}': {len(ids)} txns → 2 aggregate rows")
            except Exception as e:
                print(f"[db_service] Failed to archive '{name}': {e}")

    def _aggregate_old_capital_flows(self, conn):
        """Collapse all capital_flows rows older than the current month into one
        aggregate row per (year-month, type, category) group.
        Rows already aggregated (remarks starts with '[Aggregated') are skipped.
        Rows referenced by equity_dividends are excluded from aggregation entirely.
        Idempotent — safe to call on every startup."""
        from datetime import date as _date
        cutoff = _date.today().replace(day=1).isoformat()  # e.g. '2026-06-01'

        try:
            # Find groups, excluding rows protected by equity_dividends FK
            groups = conn.execute(
                "SELECT strftime('%Y-%m', date) as ym, type, category, "
                "    SUM(amount) as total, COUNT(*) as cnt, MAX(created_by) as cb "
                "FROM capital_flows "
                "WHERE date < ? AND (remarks IS NULL OR remarks NOT LIKE '[Aggregated%') "
                "  AND id NOT IN ("
                "    SELECT capital_flow_id FROM equity_dividends "
                "    WHERE capital_flow_id IS NOT NULL) "
                "GROUP BY ym, type, category "
                "HAVING cnt > 0",
                (cutoff,)
            ).fetchall()
        except Exception as e:
            print(f"[db_service] _aggregate_old_capital_flows query failed: {e}")
            return

        if not groups:
            return

        total_before = sum(g["cnt"] for g in groups)
        for g in groups:
            ym = g["ym"]          # e.g. '2026-05'
            agg_date = ym + "-01" # first of the month
            try:
                # Delete all non-aggregated rows for this group in that month,
                # but preserve any rows referenced by equity_dividends.capital_flow_id
                conn.execute(
                    "DELETE FROM capital_flows "
                    "WHERE strftime('%Y-%m', date) = ? "
                    "  AND type = ? AND category = ? "
                    "  AND (remarks IS NULL OR remarks NOT LIKE '[Aggregated%') "
                    "  AND id NOT IN ("
                    "    SELECT capital_flow_id FROM equity_dividends "
                    "    WHERE capital_flow_id IS NOT NULL)",
                    (ym, g["type"], g["category"])
                )
                # Insert one aggregate row
                conn.execute(
                    "INSERT INTO capital_flows (date, type, category, amount, remarks, created_by) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (agg_date, g["type"], g["category"],
                     round(float(g["total"] or 0), 4),
                     f"[Aggregated: {g['cnt']} entries]",
                     g["cb"])
                )
                conn.commit()
            except Exception as e:
                print(f"[db_service] Failed to aggregate capital_flows {ym}/{g['type']}/{g['category']}: {e}")

        print(f"[db_service] capital_flows: {total_before} old rows → {len(groups)} aggregate rows")

    def _aggregate_closed_p2p_repayments(self, conn):
        """For each closed P2P loan that has more than 1 repayment row, collapse all
        rows into a single aggregate (sum of amount, principal, interest, platform_fee).
        Idempotent — skips loans that already have exactly 1 row or are not closed."""
        try:
            closed = conn.execute(
                "SELECT pr.lending_id, COUNT(*) as cnt "
                "FROM p2p_repayments pr "
                "JOIN p2p ON p2p.lending_id = pr.lending_id "
                "WHERE p2p.status = 'Closed' "
                "GROUP BY pr.lending_id HAVING cnt > 1"
            ).fetchall()
        except Exception as e:
            print(f"[db_service] _aggregate_closed_p2p_repayments query failed: {e}")
            return

        for row in closed:
            lid = row["lending_id"]
            try:
                rows = conn.execute(
                    "SELECT * FROM p2p_repayments WHERE lending_id = ?", (lid,)
                ).fetchall()
                if not rows:
                    continue

                total_amt   = round(sum(float(r["amount"]       or 0) for r in rows), 4)
                total_prin  = round(sum(float(r["principal"]    or 0) for r in rows), 4)
                total_int   = round(sum(float(r["interest"]     or 0) for r in rows), 4)
                total_fee   = round(sum(float(r["platform_fee"] or 0) for r in rows), 4)
                latest_date = max((r["date"] or "") for r in rows)
                cb          = rows[-1]["created_by"]

                ids = [r["id"] for r in rows]
                placeholders = ",".join("?" for _ in ids)
                conn.execute(
                    f"DELETE FROM p2p_repayments WHERE id IN ({placeholders})", ids
                )
                conn.execute(
                    "INSERT INTO p2p_repayments "
                    "(lending_id, date, amount, principal, interest, platform_fee, remarks, created_by, source) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aggregated')",
                    (lid, latest_date, total_amt, total_prin, total_int, total_fee,
                     f"[Aggregated: {len(ids)} repayments]", cb)
                )
                conn.commit()
                print(f"[db_service] p2p_repayments: {lid} — {len(ids)} rows → 1 aggregate")
            except Exception as e:
                print(f"[db_service] Failed to aggregate repayments for {lid}: {e}")

    def _create_indexes(self, conn):
        """Create performance indexes on frequently filtered columns."""
        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_equity_created_by ON equity(created_by)",
            "CREATE INDEX IF NOT EXISTS idx_equity_name ON equity(name)",
            "CREATE INDEX IF NOT EXISTS idx_commodity_created_by ON commodity(created_by)",
            "CREATE INDEX IF NOT EXISTS idx_commodity_name ON commodity(name)",
            "CREATE INDEX IF NOT EXISTS idx_mutual_funds_created_by ON mutual_funds(created_by)",
            "CREATE INDEX IF NOT EXISTS idx_mutual_funds_name ON mutual_funds(name)",
            "CREATE INDEX IF NOT EXISTS idx_p2p_created_by ON p2p(created_by)",
            "CREATE INDEX IF NOT EXISTS idx_p2p_loan_id ON p2p(loan_id)",
            "CREATE INDEX IF NOT EXISTS idx_p2p_repayments_lending_id ON p2p_repayments(lending_id)",
            "CREATE INDEX IF NOT EXISTS idx_p2p_repayments_created_by ON p2p_repayments(created_by)",
            "CREATE INDEX IF NOT EXISTS idx_fixed_deposits_created_by ON fixed_deposits(created_by)",
            "CREATE INDEX IF NOT EXISTS idx_forex_created_by ON forex(created_by)",
            "CREATE INDEX IF NOT EXISTS idx_capital_flows_created_by ON capital_flows(created_by)",
            "CREATE INDEX IF NOT EXISTS idx_capital_flows_type ON capital_flows(type)",
            "CREATE INDEX IF NOT EXISTS idx_equity_dividends_created_by ON equity_dividends(created_by)",
            "CREATE INDEX IF NOT EXISTS idx_tickers_asset_type ON tickers(asset_type)",
        ]
        for sql in indexes:
            try:
                conn.execute(sql)
            except Exception:
                pass
        conn.commit()

    def _init_db(self):
        with self._lock:
            conn = self._connect()
            self._migrate_p2p_v3(conn)
            self._migrate_p2p_repayments_v2(conn)
            self._migrate_equity_v2(conn)
            for table, config in TABLES.items():
                cols = ", ".join(
                    f"{c} {_col_type(c)}" for c in config["columns"]
                )
                conn.execute(
                    f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY AUTOINCREMENT, {cols})"
                )
            # Settings table: generic key-value store
            conn.execute(
                "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            self._migrate_rbac(conn)
            # Unified tickers table (replaces the old equity_tickers / mf_tickers / commodity_tickers)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS tickers (
                    name       TEXT NOT NULL,
                    asset_type TEXT NOT NULL,
                    ticker     TEXT NOT NULL,
                    price      REAL,
                    PRIMARY KEY (name, asset_type)
                )
            """)
            # Persistent portfolio snapshot for near-instant cold-start loads
            conn.execute("""
                CREATE TABLE IF NOT EXISTS portfolio_snapshot (
                    user_scope    TEXT PRIMARY KEY,
                    snapshot_json TEXT NOT NULL,
                    updated_at    TEXT NOT NULL
                )
            """)
            self._migrate_tickers_unified(conn)
            self._migrate_ticker_symbol_column(conn)
            self._migrate_drop_orphan_columns(conn)
            self._archive_exited_equity(conn)
            self._aggregate_old_capital_flows(conn)
            self._aggregate_closed_p2p_repayments(conn)
            self._migrate_updated_at(conn)
            self._create_indexes(conn)
            conn.commit()
            conn.close()

    # ── Public API (same signatures as ExcelService) ──

    def get_all(self, sheet_name, user_email=None, role=None):
        # Users see only their own rows; admins and guests see all
        if role == 'user' and user_email:
            cache_key = f"rows:{sheet_name}:user:{user_email}"
        else:
            cache_key = f"rows:{sheet_name}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        table = SHEET_TO_TABLE[sheet_name]
        config = TABLES[table]
        columns = config["columns"]
        with self._db_lock():
            conn = self._connect()
            if role == 'user' and user_email:
                cursor = conn.execute(
                    f"SELECT id, {', '.join(columns)}, created_by FROM {table} WHERE created_by = ? ORDER BY id",
                    (user_email,)
                )
            else:
                cursor = conn.execute(f"SELECT id, {', '.join(columns)}, created_by FROM {table} ORDER BY id")
            rows = []
            for row in cursor:
                entry = {"id": row["id"]}
                for col in columns:
                    val = row[col]
                    if col in NUMERIC_FIELDS and val is not None:
                        try:
                            val = float(val)
                        except (ValueError, TypeError):
                            pass
                    entry[col] = val
                try:
                    entry["created_by"] = row["created_by"]
                except Exception:
                    entry["created_by"] = None
                rows.append(entry)
            conn.close()
        self._cache.set(cache_key, rows)
        return rows

    def add_row(self, sheet_name, data, created_by=None):
        table = SHEET_TO_TABLE[sheet_name]
        config = TABLES[table]
        columns = config["columns"]

        if config.get("no_upsert"):
            name_key = None
        else:
            name_key = "name" if "name" in columns else ("bank_name" if "bank_name" in columns else None)
        lookup_name = data.get(name_key, "").strip() if name_key else ""

        with self._db_lock():
            conn = self._connect()

            # Check for existing entry (upsert logic — scoped to the same user)
            existing_id = None
            if lookup_name:
                if created_by:
                    cursor = conn.execute(
                        f"SELECT id FROM {table} WHERE LOWER(TRIM({name_key})) = LOWER(TRIM(?)) AND created_by = ?",
                        (lookup_name, created_by),
                    )
                else:
                    cursor = conn.execute(
                        f"SELECT id FROM {table} WHERE LOWER(TRIM({name_key})) = LOWER(TRIM(?)) AND (created_by IS NULL OR created_by = '')",
                        (lookup_name,),
                    )
                row = cursor.fetchone()
                if row:
                    existing_id = row["id"]

            if existing_id:
                # Upsert: add numeric values, replace date/buy_sell
                updates = []
                params = []
                for col in columns:
                    if col in UPSERT_FIELDS and col in data:
                        val = data[col]
                        if col in NUMERIC_FIELDS and val not in (None, ""):
                            try:
                                new_val = float(val)
                            except (ValueError, TypeError):
                                new_val = 0
                            updates.append(f"{col} = COALESCE({col}, 0) + ?")
                            params.append(new_val)
                        else:
                            updates.append(f"{col} = ?")
                            params.append(val)
                updates.append("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')")
                if updates:
                    params.append(existing_id)
                    conn.execute(
                        f"UPDATE {table} SET {', '.join(updates)} WHERE id = ?",
                        params,
                    )
                conn.commit()
                conn.close()
                result = {"id": existing_id, "upserted": True}
            else:
                cols_present = []
                vals = []
                for col in columns:
                    val = data.get(col, "")
                    if col in NUMERIC_FIELDS:
                        if val not in (None, ""):
                            try:
                                val = float(val)
                            except (ValueError, TypeError):
                                val = None
                        else:
                            val = None
                    cols_present.append(col)
                    vals.append(val)
                # Append created_by column
                cols_present.append("created_by")
                vals.append(created_by)
                placeholders = ", ".join("?" for _ in cols_present)
                cursor = conn.execute(
                    f"INSERT INTO {table} ({', '.join(cols_present)}) VALUES ({placeholders})",
                    vals,
                )
                new_id = cursor.lastrowid
                conn.commit()
                conn.close()
                result = {"id": new_id, "upserted": False}

        self._cache.invalidate(f"rows:{sheet_name}", "summary", "capital_flows_summary",
                               "bulk_data:__all__")
        if created_by:
            self._cache.invalidate(
                f"rows:{sheet_name}:user:{created_by}",
                f"summary:user:{created_by}",
                f"capital_flows_summary:user:{created_by}",
                f"bulk_data:{created_by}",
            )
        self.invalidate_snapshot(created_by)
        return result

    def batch_write(self, operations, user_email=None):
        """Execute multiple INSERT/UPDATE operations in a single round-trip.
        operations: list of dicts with keys:
          - action: "insert" or "update"
          - sheet_name: e.g. "P2P Repayments"
          - data: dict of column->value
          - row_id: (for update only) the id to update
        Returns list of {"id": ..., "action": ...} results.
        Invalidates cache/snapshot only once at the end.
        """
        if not operations:
            return []

        queries = []
        meta = []  # track which tables were touched

        for op in operations:
            action = op["action"]
            sheet_name = op["sheet_name"]
            table = SHEET_TO_TABLE[sheet_name]
            config = TABLES[table]
            columns = config["columns"]
            data = op.get("data", {})
            meta.append(sheet_name)

            if action == "insert":
                cols_present = []
                vals = []
                for col in columns:
                    val = data.get(col, "")
                    if col in NUMERIC_FIELDS:
                        if val not in (None, ""):
                            try:
                                val = float(val)
                            except (ValueError, TypeError):
                                val = None
                        else:
                            val = None
                    cols_present.append(col)
                    vals.append(val)
                cols_present.append("created_by")
                vals.append(user_email)
                placeholders = ", ".join("?" for _ in cols_present)
                sql = f"INSERT INTO {table} ({', '.join(cols_present)}) VALUES ({placeholders})"
                queries.append((sql, vals))

            elif action == "update":
                row_id = op["row_id"]
                updates = []
                params = []
                for col in columns:
                    if col in data:
                        val = data[col]
                        if col in NUMERIC_FIELDS and val not in (None, ""):
                            try:
                                val = float(val)
                            except (ValueError, TypeError):
                                pass
                        updates.append(f"{col} = ?")
                        params.append(val)
                if updates:
                    updates.append("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')")
                    params.append(row_id)
                    sql = f"UPDATE {table} SET {', '.join(updates)} WHERE id = ?"
                    queries.append((sql, params))

        if not queries:
            return []

        with self._db_lock():
            conn = self._connect()
            if self.turso_url and self.turso_token:
                # Single HTTP round-trip for all writes
                conn.execute_pipeline(queries)
            else:
                for sql, params in queries:
                    conn.execute(sql, params)
                conn.commit()
            conn.close()

        # Invalidate cache once for all affected tables
        touched_sheets = set(meta)
        cache_keys = ["summary", "capital_flows_summary", "bulk_data:__all__"]
        for s in touched_sheets:
            cache_keys.append(f"rows:{s}")
        self._cache.invalidate(*cache_keys)
        if user_email:
            user_keys = [f"summary:user:{user_email}", f"capital_flows_summary:user:{user_email}", f"bulk_data:{user_email}"]
            for s in touched_sheets:
                user_keys.append(f"rows:{s}:user:{user_email}")
            self._cache.invalidate(*user_keys)
        self.invalidate_snapshot(user_email)

        return [{"index": i, "action": operations[i]["action"]} for i in range(len(operations))]

    def update_row(self, sheet_name, row_id, data, user_email=None, role=None):
        table = SHEET_TO_TABLE[sheet_name]
        config = TABLES[table]
        columns = config["columns"]
        with self._db_lock():
            conn = self._connect()
            # Check row exists and ownership
            cursor = conn.execute(f"SELECT id, created_by FROM {table} WHERE id = ?", (row_id,))
            existing = cursor.fetchone()
            if not existing:
                conn.close()
                return False
            if role == 'user' and user_email:
                owner = existing["created_by"] if hasattr(existing, '__getitem__') else None
                if owner != user_email:
                    conn.close()
                    return 'forbidden'
            updates = []
            params = []
            for col in columns:
                if col in data:
                    val = data[col]
                    if col in NUMERIC_FIELDS and val not in (None, ""):
                        try:
                            val = float(val)
                        except (ValueError, TypeError):
                            pass
                    updates.append(f"{col} = ?")
                    params.append(val)
            updates.append("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')")
            if updates:
                params.append(row_id)
                conn.execute(
                    f"UPDATE {table} SET {', '.join(updates)} WHERE id = ?",
                    params,
                )
                conn.commit()
            conn.close()
        self._cache.invalidate(f"rows:{sheet_name}", "summary", "capital_flows_summary",
                               "bulk_data:__all__")
        if user_email:
            self._cache.invalidate(
                f"rows:{sheet_name}:user:{user_email}",
                f"summary:user:{user_email}",
                f"capital_flows_summary:user:{user_email}",
                f"bulk_data:{user_email}",
            )
        self.invalidate_snapshot(user_email)
        return True

    def delete_row(self, sheet_name, row_id, user_email=None, role=None):
        table = SHEET_TO_TABLE[sheet_name]
        with self._db_lock():
            conn = self._connect()
            if role == 'user' and user_email:
                cursor = conn.execute(f"SELECT created_by FROM {table} WHERE id = ?", (row_id,))
                row = cursor.fetchone()
                if row is None:
                    conn.close()
                    return False
                owner = row["created_by"] if hasattr(row, '__getitem__') else None
                if owner != user_email:
                    conn.close()
                    return 'forbidden'
            cursor = conn.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
            conn.commit()
            deleted = cursor.rowcount > 0
            conn.close()
        if deleted:
            self._cache.invalidate(f"rows:{sheet_name}", "summary", "capital_flows_summary",
                                   "bulk_data:__all__")
            if user_email:
                self._cache.invalidate(
                    f"rows:{sheet_name}:user:{user_email}",
                    f"summary:user:{user_email}",
                    f"capital_flows_summary:user:{user_email}",
                    f"bulk_data:{user_email}",
                )
            self.invalidate_snapshot(user_email)
        return deleted

    def get_setting(self, key: str):
        with self._db_lock():
            conn = self._connect()
            cursor = conn.execute("SELECT value FROM settings WHERE key = ?", (key,))
            row = cursor.fetchone()
            conn.close()
            return row["value"] if row else None

    def set_setting(self, key: str, value: str):
        with self._db_lock():
            conn = self._connect()
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value)
            )
            conn.commit()
            conn.close()

    def get_distinct_names(self, sheet_name):
        """Return distinct label values (name/bank_name) for autocomplete suggestions.
        No RBAC filter — all authenticated users get the full name list for autofill only."""
        cache_key = f"distinct_names:{sheet_name}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        table = SHEET_TO_TABLE.get(sheet_name)
        if not table:
            return []
        columns = TABLES.get(table, {}).get("columns", [])

        if "name" in columns:
            col = "name"
        elif "bank_name" in columns:
            col = "bank_name"
        else:
            return []

        with self._db_lock():
            conn = self._connect()
            try:
                cursor = conn.execute(
                    f"SELECT DISTINCT {col} FROM {table} "
                    f"WHERE {col} IS NOT NULL AND {col} != '' ORDER BY {col}"
                )
                names = [row[0] for row in cursor]
            except Exception:
                names = []
            finally:
                conn.close()

        self._cache.set(cache_key, names)
        return names

    def get_name_meta_map(self, sheet_name, name_col, meta_cols):
        """Return {name: {col: val}} mapping for autocomplete metadata (no RBAC filter).
        Used to auto-fill categorical fields (sector, market, commodity type, etc.)."""
        cache_key = f"name_meta:{sheet_name}:{','.join(meta_cols)}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached
        table = SHEET_TO_TABLE.get(sheet_name)
        if not table:
            return {}
        select_cols = ', '.join([name_col] + meta_cols)
        with self._db_lock():
            conn = self._connect()
            try:
                cursor = conn.execute(
                    f"SELECT {select_cols} FROM {table} "
                    f"WHERE {name_col} IS NOT NULL AND {name_col} != ''"
                )
                result = {}
                for row in cursor:
                    name_val = row[0]
                    if name_val and name_val not in result:
                        result[name_val] = {col: row[i + 1] for i, col in enumerate(meta_cols)}
            except Exception:
                result = {}
            finally:
                conn.close()
        self._cache.set(cache_key, result)
        return result

    def get_all_tickers(self):
        cached = self._cache.get("tickers:equity")
        if cached is not None:
            return cached
        with self._db_lock():
            conn = self._connect()
            cursor = conn.execute("SELECT name, ticker, price FROM tickers WHERE asset_type = 'equity'")
            result = {row["name"]: {"ticker": row["ticker"], "price": row["price"]} for row in cursor.fetchall()}
            conn.close()
        self._cache.set("tickers:equity", result)
        return result

    def upsert_ticker(self, name: str, ticker: str):
        with self._db_lock():
            conn = self._connect()
            conn.execute(
                "INSERT INTO tickers (name, asset_type, ticker) VALUES (?, 'equity', ?) "
                "ON CONFLICT(name, asset_type) DO UPDATE SET ticker = excluded.ticker",
                (name.strip(), ticker.strip())
            )
            conn.commit()
            conn.close()
        self._cache.invalidate("tickers:equity")
        self.invalidate_snapshot()

    def update_ticker_prices(self, prices: dict):
        """Persist latest prices keyed by ticker symbol. prices = {ticker: price}"""
        if not prices:
            print("[tickers] No equity prices to persist.")
            return
        updated = 0
        with self._db_lock():
            conn = self._connect()
            for ticker, price in prices.items():
                if price is not None:
                    cursor = conn.execute(
                        "UPDATE tickers SET price = ? WHERE ticker = ? AND asset_type = 'equity'",
                        (float(price), ticker)
                    )
                    if hasattr(cursor, 'rowcount'):
                        updated += cursor.rowcount
            conn.commit()
            conn.close()
        self._cache.invalidate("tickers:equity")
        self.invalidate_snapshot()
        print(f"[tickers] Persisted {len(prices)} equity prices ({updated} rows updated).")

    # ── MF Tickers ──

    def get_all_mf_tickers(self):
        cached = self._cache.get("tickers:mf")
        if cached is not None:
            return cached
        with self._db_lock():
            conn = self._connect()
            cursor = conn.execute("SELECT name, ticker, price FROM tickers WHERE asset_type = 'mf'")
            result = {row["name"]: {"ticker": row["ticker"], "price": row["price"]} for row in cursor.fetchall()}
            conn.close()
        self._cache.set("tickers:mf", result)
        return result

    def upsert_mf_ticker(self, name: str, ticker: str):
        with self._db_lock():
            conn = self._connect()
            conn.execute(
                "INSERT INTO tickers (name, asset_type, ticker) VALUES (?, 'mf', ?) "
                "ON CONFLICT(name, asset_type) DO UPDATE SET ticker = excluded.ticker",
                (name.strip(), ticker.strip())
            )
            conn.commit()
            conn.close()
        self._cache.invalidate("tickers:mf")
        self.invalidate_snapshot()

    def update_mf_ticker_prices(self, prices: dict):
        if not prices:
            return
        with self._db_lock():
            conn = self._connect()
            for ticker, price in prices.items():
                if price is not None:
                    conn.execute(
                        "UPDATE tickers SET price = ? WHERE ticker = ? AND asset_type = 'mf'",
                        (float(price), ticker)
                    )
            conn.commit()
            conn.close()
        self._cache.invalidate("tickers:mf")
        self.invalidate_snapshot()
        print(f"[tickers] Persisted {len(prices)} MF prices.")

    # ── Commodity Tickers ──

    def get_all_commodity_tickers(self):
        cached = self._cache.get("tickers:commodity")
        if cached is not None:
            return cached
        with self._db_lock():
            conn = self._connect()
            cursor = conn.execute("SELECT name, ticker, price FROM tickers WHERE asset_type = 'commodity'")
            result = {row["name"]: {"ticker": row["ticker"], "price": row["price"]} for row in cursor.fetchall()}
            conn.close()
        self._cache.set("tickers:commodity", result)
        return result

    def upsert_commodity_ticker(self, name: str, ticker: str):
        with self._db_lock():
            conn = self._connect()
            conn.execute(
                "INSERT INTO tickers (name, asset_type, ticker) VALUES (?, 'commodity', ?) "
                "ON CONFLICT(name, asset_type) DO UPDATE SET ticker = excluded.ticker",
                (name.strip(), ticker.strip())
            )
            conn.commit()
            conn.close()
        self._cache.invalidate("tickers:commodity")
        self.invalidate_snapshot()

    def update_commodity_ticker_prices(self, prices: dict):
        if not prices:
            return
        with self._db_lock():
            conn = self._connect()
            for ticker, price in prices.items():
                if price is not None:
                    conn.execute(
                        "UPDATE tickers SET price = ? WHERE ticker = ? AND asset_type = 'commodity'",
                        (float(price), ticker)
                    )
            conn.commit()
            conn.close()
        self._cache.invalidate("tickers:commodity")
        self.invalidate_snapshot()
        print(f"[tickers] Persisted {len(prices)} commodity prices.")

    # ── Portfolio Snapshot (persistent server-side cache for cold-start speed) ──

    _SNAPSHOT_TTL_SECONDS = 300  # 5 minutes

    def _get_snapshot(self, user_scope: str):
        """Return parsed snapshot dict if it exists and is fresh, else None."""
        try:
            import json, time as _time
            conn = self._connect()
            row = conn.execute(
                "SELECT snapshot_json, updated_at FROM portfolio_snapshot WHERE user_scope = ?",
                (user_scope,)
            ).fetchone()
            conn.close()
            if row is None:
                return None
            updated_at_str = row["updated_at"]
            # Parse ISO timestamp
            from datetime import datetime, timezone
            ts = datetime.fromisoformat(updated_at_str.replace("Z", "+00:00")).timestamp()
            if _time.time() - ts > self._SNAPSHOT_TTL_SECONDS:
                return None
            return json.loads(row["snapshot_json"])
        except Exception:
            return None

    def _save_snapshot(self, user_scope: str, data: dict):
        """Persist the full bulk-load result as a snapshot in the DB."""
        try:
            import json
            snapshot_json = json.dumps(data, default=str)
            conn = self._connect()
            conn.execute(
                "INSERT INTO portfolio_snapshot (user_scope, snapshot_json, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now')) "
                "ON CONFLICT(user_scope) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at",
                (user_scope, snapshot_json)
            )
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[snapshot] Failed to save: {e}")

    def invalidate_snapshot(self, user_scope: str = None):
        """Remove snapshot(s). Call after any write or price update."""
        try:
            conn = self._connect()
            if user_scope:
                conn.execute("DELETE FROM portfolio_snapshot WHERE user_scope = ? OR user_scope = '__all__'", (user_scope,))
            else:
                conn.execute("DELETE FROM portfolio_snapshot")
            conn.commit()
            conn.close()
        except Exception:
            pass

    # ── Summary computation helpers (derived from fetched rows — no extra DB call) ──

    @staticmethod
    def _eval_row_where(row: dict, where_clause: str) -> bool:
        """Evaluate simple col = 'val' predicates used in TABLES buy_where/sell_where."""
        if not where_clause:
            return True
        if "= '" in where_clause:
            col, val = where_clause.split("= '", 1)
            return str(row.get(col.strip(), "")) == val.rstrip("'")
        return True

    def _compute_summary_from_rows(self, data: dict) -> dict:
        """Compute the same summary dict as get_summary() but from already-fetched rows."""
        skip = {"Forex", "P2P Repayments", "P2P Escrow"}
        summary = {}

        for sheet_name, table in SHEET_TO_TABLE.items():
            if sheet_name in skip:
                continue
            config = TABLES[table]
            rows = data.get(table, [])
            buy_col = config.get("buy_col")
            sell_col = config.get("sell_col")
            buy_where = config.get("buy_where", "")
            sell_where = config.get("sell_where", "")

            if sheet_name == "P2P":
                # P2P is handled specially below
                continue

            s = {
                "count": len(rows),
                "total_buy": round(sum(float(r.get(buy_col) or 0) for r in rows if buy_col and self._eval_row_where(r, buy_where)), 2),
                "total_sell": round(sum(float(r.get(sell_col) or 0) for r in rows if sell_col and self._eval_row_where(r, sell_where)), 2),
            }
            s["net"] = round(s["total_sell"] - s["total_buy"], 2)
            summary[sheet_name] = s

        # P2P: buy from p2p.amount, sell from p2p_repayments.amount, with extra stats
        p2p_rows = data.get("p2p", [])
        p2p_rep_rows = data.get("p2p_repayments", [])
        p2p_escrow_rows = data.get("p2p_escrow", [])

        p2p_total_buy = round(sum(float(r.get("amount") or 0) for r in p2p_rows), 2)
        p2p_received = round(sum(float(r.get("amount") or 0) for r in p2p_rep_rows), 2)

        # Pending principal per lending_id
        repaid_by_lid = {}
        for r in p2p_rep_rows:
            lid = r.get("lending_id", "")
            repaid_by_lid[lid] = repaid_by_lid.get(lid, 0) + float(r.get("amount") or 0)
        pending = round(sum(
            float(r.get("amount") or 0) - repaid_by_lid.get(r.get("lending_id"), 0)
            for r in p2p_rows
            if float(r.get("amount") or 0) > repaid_by_lid.get(r.get("lending_id"), 0)
        ), 2)

        escrow_balance = round(sum(
            float(r.get("amount") or 0) if r.get("type") == "Deposit" else -float(r.get("amount") or 0)
            for r in p2p_escrow_rows
        ), 2)

        summary["P2P"] = {
            "count": len(p2p_rows),
            "total_buy": p2p_total_buy,
            "total_sell": p2p_received,
            "net": round(p2p_received - p2p_total_buy, 2),
            "current_invested": pending,
            "escrow_balance": escrow_balance,
        }
        return summary

    @staticmethod
    def _compute_capital_flows_summary_from_rows(cf_rows: list) -> dict:
        """Compute capital flows summary from already-fetched rows."""
        total_deposits = round(sum(float(r.get("amount") or 0) for r in cf_rows if r.get("type") == "Deposit"), 2)
        total_withdrawals = round(sum(float(r.get("amount") or 0) for r in cf_rows if r.get("type") == "Withdrawal"), 2)
        return {
            "total_deposits": total_deposits,
            "total_withdrawals": total_withdrawals,
            "actual_investment": round(total_deposits - total_withdrawals, 2),
        }

    # ── Bulk data loader (single execute_pipeline call to Turso) ──

    def get_bulk_data(self, user_email=None, role=None) -> dict:
        """Fetch ALL dashboard data in one HTTP round-trip via execute_pipeline.

        Returns a dict with keys matching the legacy bulk-load task names.
        Summary and capital_flows_summary are computed in Python from the rows — no extra DB call.
        """
        user_filter = role == 'user' and user_email
        user_scope = user_email if user_filter else '__all__'

        # 1. Check persistent snapshot (survives Render cold-starts)
        snapshot = self._get_snapshot(user_scope)
        if snapshot is not None:
            return snapshot

        # 2. Check in-memory TTL cache
        cache_key = f"bulk_data:{user_scope}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        # 3. Build all SELECT queries ─────────────────────────────────────────
        # Data tables to fetch (with RBAC filter where applicable)
        data_sheets = [
            "Equity", "Commodity", "Mutual Funds", "P2P", "P2P Repayments",
            "P2P Escrow",   # needed for P2P summary (escrow balance) — not sent to frontend
            "Fixed Deposits", "Forex", "Capital Flows", "Equity Dividends",
        ]
        # P2P Escrow is never user-filtered (shared across all users)
        no_user_filter_sheets = {"P2P Escrow"}

        queries = []
        for sheet_name in data_sheets:
            table = SHEET_TO_TABLE[sheet_name]
            columns = TABLES[table]["columns"]
            col_list = f"id, {', '.join(columns)}, created_by"
            if user_filter and sheet_name not in no_user_filter_sheets:
                queries.append((
                    f"SELECT {col_list} FROM {table} WHERE created_by = ? ORDER BY id",
                    (user_email,)
                ))
            else:
                queries.append((
                    f"SELECT {col_list} FROM {table} ORDER BY id",
                    None
                ))

        # Three ticker queries (one per asset_type) ─ batched in the same pipeline
        ticker_offset = len(queries)
        queries.append(("SELECT name, ticker, price FROM tickers WHERE asset_type = 'equity'", None))
        queries.append(("SELECT name, ticker, price FROM tickers WHERE asset_type = 'mf'", None))
        queries.append(("SELECT name, ticker, price FROM tickers WHERE asset_type = 'commodity'", None))

        # 4. Execute — 1 HTTP round-trip for Turso, sequential fallback for SQLite
        conn = self._connect()
        if hasattr(conn, "execute_pipeline"):
            cursors = conn.execute_pipeline(queries)
        else:
            cursors = [conn.execute(sql, params or []) for sql, params in queries]
        conn.close()

        # 5. Parse row data ────────────────────────────────────────────────────
        result = {}
        for i, sheet_name in enumerate(data_sheets):
            table = SHEET_TO_TABLE[sheet_name]
            columns = TABLES[table]["columns"]
            rows = []
            for row in cursors[i]:
                entry = {"id": row["id"]}
                for col in columns:
                    val = row[col]
                    if col in NUMERIC_FIELDS and val is not None:
                        try:
                            val = float(val)
                        except (ValueError, TypeError):
                            pass
                    entry[col] = val
                try:
                    entry["created_by"] = row["created_by"]
                except Exception:
                    entry["created_by"] = None
                rows.append(entry)
            result[table] = rows  # key = table name, e.g. "mutual_funds"

        # 6. Parse tickers ────────────────────────────────────────────────────
        def _parse_tickers(cursor):
            return {row["name"]: {"ticker": row["ticker"], "price": row["price"]} for row in cursor.fetchall()}

        result["equity_tickers"] = _parse_tickers(cursors[ticker_offset])
        result["mf_tickers"] = _parse_tickers(cursors[ticker_offset + 1])
        result["commodity_tickers"] = _parse_tickers(cursors[ticker_offset + 2])

        # 7. Compute derived summaries in Python (no extra DB call) ───────────
        result["summary"] = self._compute_summary_from_rows(result)
        result["capital_flows_summary"] = self._compute_capital_flows_summary_from_rows(result.get("capital_flows", []))

        # 8. Cache result
        self._cache.set(cache_key, result)
        # Note: snapshot saved by app.py after unrealized_pnl is appended

        return result

    # ── P2P Escrow compaction ──────────────────────────────────────────────────

    def compact_p2p_escrow(self, threshold: int = 20):
        """When escrow row count exceeds threshold, collapse compactable rows into a
        single balance row.  Rows marked 'Auto: {lending_id}' for ACTIVE loans are
        intentionally kept so the cascade-delete on P2P loan deletion still works.
        The running balance of all non-preserved rows is stored in the balance row."""
        from datetime import date as _date
        with self._db_lock():
            conn = self._connect()
            cnt_row = conn.execute("SELECT COUNT(*) as cnt FROM p2p_escrow").fetchone()
            if cnt_row["cnt"] <= threshold:
                conn.close()
                return

            # Active-loan IDs — their auto-created escrow rows must not be compacted
            active_ids = {
                r["lending_id"]
                for r in conn.execute(
                    "SELECT lending_id FROM p2p WHERE status != 'Closed'"
                ).fetchall()
            }

            all_rows = conn.execute(
                "SELECT id, type, amount, remarks FROM p2p_escrow"
            ).fetchall()

            def _linked_to_active(r):
                rem = str(r["remarks"] or "")
                return rem.startswith("Auto: ") and any(
                    rem.startswith(f"Auto: {lid}") for lid in active_ids
                )

            safe      = [r for r in all_rows if not _linked_to_active(r)]
            preserved = len(all_rows) - len(safe)
            if not safe:
                conn.close()
                return

            balance = round(sum(
                float(r["amount"] or 0) if r["type"] == "Deposit" else -float(r["amount"] or 0)
                for r in safe
            ), 4)
            safe_ids     = [r["id"] for r in safe]
            placeholders = ",".join("?" for _ in safe_ids)
            conn.execute(f"DELETE FROM p2p_escrow WHERE id IN ({placeholders})", safe_ids)
            conn.execute(
                "INSERT INTO p2p_escrow (date, type, amount, platform, remarks) "
                "VALUES (?, 'Deposit', ?, 'System', 'Balance compaction')",
                (_date.today().isoformat(), balance)
            )
            conn.commit()
            conn.close()
        self._cache.invalidate("rows:P2P Escrow", "bulk_data:__all__")
        self.invalidate_snapshot()
        print(f"[escrow] Compacted {len(safe)} rows → 1 balance row (balance={balance}), preserved {preserved} active-loan rows")

    def get_user_role(self, email):
        """Return role string ('admin'/'user'/'guest') for email, or None if not in allowlist."""
        try:
            conn = self._connect()
            cursor = conn.execute("SELECT role FROM allowlist WHERE email = ? LIMIT 1", (email,))
            row = cursor.fetchone()
            conn.close()
            if row is None:
                return None
            return row["role"] if hasattr(row, '__getitem__') else row[0]
        except Exception as e:
            print(f"[db_service] get_user_role error: {e}")
            return None

    def update_allowlist_role(self, email, role):
        """Update role for an existing allowlist entry."""
        try:
            conn = self._connect()
            conn.execute("UPDATE allowlist SET role = ? WHERE email = ?", (role, email))
            conn.commit()
            conn.close()
            return True
        except Exception as e:
            print(f"[db_service] update_allowlist_role error: {e}")
            return False

    def remove_from_allowlist(self, email):
        """Remove user from allowlist."""
        try:
            conn = self._connect()
            cursor = conn.execute("DELETE FROM allowlist WHERE email = ?", (email,))
            conn.commit()
            deleted = cursor.rowcount > 0
            conn.close()
            return deleted
        except Exception as e:
            print(f"[db_service] remove_from_allowlist error: {e}")
            return False

    def get_summary(self, user_email=None, role=None):
        if role == 'user' and user_email:
            cache_key = f"summary:user:{user_email}"
        else:
            cache_key = "summary"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        skip = {"Forex", "P2P Repayments", "P2P Escrow"}
        queries = []  # list of (sql, params)
        meta = []     # list of (sheet_name, qtype)

        user_filter = role == 'user' and user_email
        for sheet_name, table in SHEET_TO_TABLE.items():
            if sheet_name in skip:
                continue
            config = TABLES[table]
            buy_col = config["buy_col"]
            sell_col = config["sell_col"]

            if user_filter:
                queries.append((f"SELECT COUNT(*) as cnt FROM {table} WHERE created_by = ?", (user_email,)))
            else:
                queries.append((f"SELECT COUNT(*) as cnt FROM {table}", None))
            meta.append((sheet_name, "count"))

            if buy_col:
                buy_where = config.get("buy_where", "")
                if user_filter:
                    bw = f" WHERE ({buy_where}) AND created_by = ?" if buy_where else f" WHERE created_by = ?"
                    queries.append((f"SELECT COALESCE(SUM({buy_col}), 0) as total FROM {table}{bw}", (user_email,)))
                else:
                    bw = f" WHERE {buy_where}" if buy_where else ""
                    queries.append((f"SELECT COALESCE(SUM({buy_col}), 0) as total FROM {table}{bw}", None))
                meta.append((sheet_name, "buy"))

            if sell_col:
                sell_where = config.get("sell_where", "")
                if user_filter:
                    sw = f" WHERE ({sell_where}) AND created_by = ?" if sell_where else f" WHERE created_by = ?"
                    queries.append((f"SELECT COALESCE(SUM({sell_col}), 0) as total FROM {table}{sw}", (user_email,)))
                else:
                    sw = f" WHERE {sell_where}" if sell_where else ""
                    queries.append((f"SELECT COALESCE(SUM({sell_col}), 0) as total FROM {table}{sw}", None))
                meta.append((sheet_name, "sell"))

        # P2P extra queries (repayments, pending principal, escrow balance)
        if user_filter:
            queries.append(("SELECT COALESCE(SUM(amount), 0) as total FROM p2p_repayments WHERE created_by = ?", (user_email,)))
        else:
            queries.append(("SELECT COALESCE(SUM(amount), 0) as total FROM p2p_repayments", None))
        meta.append(("P2P", "repayments"))
        if user_filter:
            queries.append((
                "SELECT COALESCE(SUM(p2p.amount - COALESCE(r.repaid, 0)), 0) as pending "
                "FROM p2p "
                "LEFT JOIN (SELECT lending_id, SUM(amount) as repaid FROM p2p_repayments GROUP BY lending_id) r "
                "ON p2p.lending_id = r.lending_id "
                "WHERE p2p.amount > COALESCE(r.repaid, 0) AND p2p.created_by = ?", (user_email,)))
        else:
            queries.append((
                "SELECT COALESCE(SUM(p2p.amount - COALESCE(r.repaid, 0)), 0) as pending "
                "FROM p2p "
                "LEFT JOIN (SELECT lending_id, SUM(amount) as repaid FROM p2p_repayments GROUP BY lending_id) r "
                "ON p2p.lending_id = r.lending_id "
                "WHERE p2p.amount > COALESCE(r.repaid, 0)", None))
        meta.append(("P2P", "pending"))
        queries.append((
            "SELECT COALESCE(SUM(CASE WHEN type = 'Deposit' THEN amount ELSE -amount END), 0) as balance "
            "FROM p2p_escrow", None))
        meta.append(("P2P", "escrow"))

        conn = self._connect()
        if hasattr(conn, "execute_pipeline"):
            cursors = conn.execute_pipeline(queries)
        else:
            # Fallback for local SQLite: run queries sequentially
            cursors = [conn.execute(sql, params or []) for sql, params in queries]
        conn.close()

        summary = {}
        for (sheet_name, qtype), cursor in zip(meta, cursors):
            row = cursor.fetchone()
            if sheet_name not in summary:
                summary[sheet_name] = {"count": 0, "total_buy": 0.0, "total_sell": 0.0, "net": 0.0}
            if qtype == "count":
                summary[sheet_name]["count"] = row["cnt"]
            elif qtype == "buy":
                summary[sheet_name]["total_buy"] = round(float(row["total"] or 0), 2)
            elif qtype == "sell":
                summary[sheet_name]["total_sell"] = round(float(row["total"] or 0), 2)
            elif qtype == "repayments":
                p2p_received = float(row["total"] or 0)
                summary["P2P"]["total_sell"] = round(p2p_received, 2)
                summary["P2P"]["net"] = round(p2p_received - summary["P2P"]["total_buy"], 2)
            elif qtype == "pending":
                summary["P2P"]["current_invested"] = round(float(row["pending"] or 0), 2)
            elif qtype == "escrow":
                summary["P2P"]["escrow_balance"] = round(float(row["balance"] or 0), 2)

        # Compute net for non-P2P categories
        for sheet_name, s in summary.items():
            if sheet_name != "P2P":
                s["net"] = round(s["total_sell"] - s["total_buy"], 2)

        if role == 'user' and user_email:
            self._cache.set(f"summary:user:{user_email}", summary)
        else:
            self._cache.set("summary", summary)
        return summary

    def get_capital_flows_summary(self, user_email=None, role=None):
        """Calculate total deposits and withdrawals from capital_flows table."""
        if role == 'user' and user_email:
            cache_key = f"capital_flows_summary:user:{user_email}"
        else:
            cache_key = "capital_flows_summary"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        conn = self._connect()
        if role == 'user' and user_email:
            queries = [
                ("SELECT COALESCE(SUM(amount), 0) as total FROM capital_flows WHERE type = 'Deposit' AND created_by = ?", (user_email,)),
                ("SELECT COALESCE(SUM(amount), 0) as total FROM capital_flows WHERE type = 'Withdrawal' AND created_by = ?", (user_email,)),
            ]
        else:
            queries = [
                ("SELECT COALESCE(SUM(amount), 0) as total FROM capital_flows WHERE type = 'Deposit'", None),
                ("SELECT COALESCE(SUM(amount), 0) as total FROM capital_flows WHERE type = 'Withdrawal'", None),
            ]
        if hasattr(conn, "execute_pipeline"):
            cursors = conn.execute_pipeline(queries)
            total_deposits = float(cursors[0].fetchone()["total"] or 0)
            total_withdrawals = float(cursors[1].fetchone()["total"] or 0)
        else:
            total_deposits = float(conn.execute(queries[0][0], queries[0][1] or []).fetchone()["total"] or 0)
            total_withdrawals = float(conn.execute(queries[1][0], queries[1][1] or []).fetchone()["total"] or 0)
        conn.close()

        result = {
            "total_deposits": round(total_deposits, 2),
            "total_withdrawals": round(total_withdrawals, 2),
            "actual_investment": round(total_deposits - total_withdrawals, 2)
        }
        self._cache.set(cache_key, result)
        return result
