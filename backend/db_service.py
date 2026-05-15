import os
import sqlite3
import threading
import requests


class TursoConnection:
    """Minimal sqlite3-compatible wrapper around Turso HTTP API."""

    def __init__(self, url, token):
        # Convert libsql:// to https://
        self._url = url.replace("libsql://", "https://") + "/v2/pipeline"
        self._headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

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
                    args.append({"type": "float", "value": str(v)})
                else:
                    args.append({"type": "text", "value": str(v)})
            stmt["args"] = args
        body = {"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}
        resp = requests.post(self._url, json=body, headers=self._headers, timeout=15)
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
        "columns": ["year", "market", "market_cap", "sector", "name", "date", "buy_quantity", "buy_value", "sell_quantity", "sell_value", "buy_sell", "remarks"],
        "buy_col": "buy_value",
        "sell_col": "sell_value",
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
        "columns": ["lending_id", "platform", "name", "date", "amount", "tenure", "maturity_date", "status", "remarks"],
        "buy_col": "amount",
        "sell_col": None,
    },
    "p2p_repayments": {
        "columns": ["lending_id", "date", "amount", "remarks"],
        "buy_col": None,
        "sell_col": "amount",
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
}

# Map sheet names used in app.py to table names
SHEET_TO_TABLE = {
    "Equity": "equity",
    "Commodity": "commodity",
    "Mutual Funds": "mutual_funds",
    "P2P": "p2p",
    "P2P Repayments": "p2p_repayments",
    "Fixed Deposits": "fixed_deposits",
    "Forex": "forex",
}

NUMERIC_FIELDS = {
    "buy_quantity", "buy_value", "sell_quantity", "sell_value",
    "amount", "tenure", "fd_value",
    "interest", "return_value",
    "inr_amount", "usd_amount", "rate",
}

UPSERT_FIELDS = NUMERIC_FIELDS | {"date", "maturity_date", "buy_sell"}


def _col_type(col):
    if col in NUMERIC_FIELDS:
        return "REAL"
    return "TEXT"


class DbService:
    def __init__(self, db_path, turso_url=None, turso_token=None):
        self.db_path = db_path
        self.turso_url = turso_url
        self.turso_token = turso_token
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self):
        if self.turso_url and self.turso_token:
            return TursoConnection(self.turso_url, self.turso_token)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_db(self):
        with self._lock:
            conn = self._connect()
            for table, config in TABLES.items():
                cols = ", ".join(
                    f"{c} {_col_type(c)}" for c in config["columns"]
                )
                conn.execute(
                    f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY AUTOINCREMENT, {cols})"
                )
            conn.commit()
            conn.close()

    # ── Public API (same signatures as ExcelService) ──

    def get_all(self, sheet_name):
        table = SHEET_TO_TABLE[sheet_name]
        config = TABLES[table]
        columns = config["columns"]
        with self._lock:
            conn = self._connect()
            cursor = conn.execute(f"SELECT id, {', '.join(columns)} FROM {table} ORDER BY id")
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
                rows.append(entry)
            conn.close()
        return rows

    def add_row(self, sheet_name, data):
        table = SHEET_TO_TABLE[sheet_name]
        config = TABLES[table]
        columns = config["columns"]

        name_key = "name" if "name" in columns else ("bank_name" if "bank_name" in columns else None)
        lookup_name = data.get(name_key, "").strip() if name_key else ""

        with self._lock:
            conn = self._connect()

            # Check for existing entry (upsert logic)
            existing_id = None
            if lookup_name:
                cursor = conn.execute(
                    f"SELECT id FROM {table} WHERE LOWER(TRIM({name_key})) = LOWER(TRIM(?))",
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
                if updates:
                    params.append(existing_id)
                    conn.execute(
                        f"UPDATE {table} SET {', '.join(updates)} WHERE id = ?",
                        params,
                    )
                conn.commit()
                conn.close()
                return {"id": existing_id, "upserted": True}
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
                placeholders = ", ".join("?" for _ in cols_present)
                cursor = conn.execute(
                    f"INSERT INTO {table} ({', '.join(cols_present)}) VALUES ({placeholders})",
                    vals,
                )
                new_id = cursor.lastrowid
                conn.commit()
                conn.close()
                return {"id": new_id, "upserted": False}

    def update_row(self, sheet_name, row_id, data):
        table = SHEET_TO_TABLE[sheet_name]
        config = TABLES[table]
        columns = config["columns"]
        with self._lock:
            conn = self._connect()
            # Check row exists
            cursor = conn.execute(f"SELECT id FROM {table} WHERE id = ?", (row_id,))
            if not cursor.fetchone():
                conn.close()
                return False
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
                params.append(row_id)
                conn.execute(
                    f"UPDATE {table} SET {', '.join(updates)} WHERE id = ?",
                    params,
                )
                conn.commit()
            conn.close()
        return True

    def delete_row(self, sheet_name, row_id):
        table = SHEET_TO_TABLE[sheet_name]
        with self._lock:
            conn = self._connect()
            cursor = conn.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
            conn.commit()
            deleted = cursor.rowcount > 0
            conn.close()
        return deleted

    def get_summary(self):
        summary = {}
        with self._lock:
            conn = self._connect()
            for sheet_name, table in SHEET_TO_TABLE.items():
                if sheet_name == "Forex":
                    continue
                config = TABLES[table]
                buy_col = config["buy_col"]
                sell_col = config["sell_col"]

                cursor = conn.execute(f"SELECT COUNT(*) as cnt FROM {table}")
                count = cursor.fetchone()["cnt"]

                total_buy = 0
                if buy_col:
                    cursor = conn.execute(f"SELECT COALESCE(SUM({buy_col}), 0) as total FROM {table}")
                    total_buy = cursor.fetchone()["total"]

                total_sell = 0
                if sell_col:
                    cursor = conn.execute(f"SELECT COALESCE(SUM({sell_col}), 0) as total FROM {table}")
                    total_sell = cursor.fetchone()["total"]

                summary[sheet_name] = {
                    "count": count,
                    "total_buy": round(total_buy, 2),
                    "total_sell": round(total_sell, 2),
                    "net": round(total_sell - total_buy, 2),
                }
            conn.close()
        return summary
