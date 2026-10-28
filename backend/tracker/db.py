"""Database access for local SQLite and remote Turso (libSQL over HTTP).

Both backends expose the same small API:
    query(sql, params)   -> list[dict]
    one(sql, params)     -> dict | None
    execute(sql, params) -> ExecResult(lastrowid, rowcount)
    batch(statements)    -> list[ExecResult]   (atomic: all or nothing)
"""
from __future__ import annotations

import os
import sqlite3
import threading
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

import requests

Params = Sequence[Any] | None


@dataclass
class ExecResult:
    lastrowid: int | None
    rowcount: int
    rows: list[dict]


class Database:
    def query(self, sql: str, params: Params = None) -> list[dict]:
        return self.batch([(sql, params)], atomic=False)[0].rows

    def one(self, sql: str, params: Params = None) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Params = None) -> ExecResult:
        return self.batch([(sql, params)], atomic=False)[0]

    def batch(self, statements: Iterable[tuple[str, Params]], atomic: bool = True) -> list[ExecResult]:
        raise NotImplementedError

    def table_exists(self, name: str) -> bool:
        return self.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)) is not None

    def columns(self, table: str) -> list[str]:
        return [r["name"] for r in self.query(f'PRAGMA table_info("{table}")')]


class SqliteDatabase(Database):
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()

    def _connect(self) -> sqlite3.Connection:
        # isolation_level=None: autocommit, transactions are opened explicitly below
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def batch(self, statements, atomic=True):
        results: list[ExecResult] = []
        with self._lock:
            conn = self._connect()
            try:
                if atomic:
                    conn.execute("BEGIN")
                for sql, params in statements:
                    cur = conn.execute(sql, tuple(params or ()))
                    rows = [dict(r) for r in cur.fetchall()] if cur.description else []
                    results.append(ExecResult(cur.lastrowid, cur.rowcount, rows))
                if atomic:
                    conn.execute("COMMIT")
            except Exception:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            finally:
                conn.close()
        return results


class TursoDatabase(Database):
    """libSQL Hrana-over-HTTP v2 pipeline client."""

    def __init__(self, url: str, token: str, timeout: int = 30):
        self.endpoint = url.replace("libsql://", "https://").rstrip("/") + "/v2/pipeline"
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {token}"})
        self.timeout = timeout

    @staticmethod
    def _arg(v):
        if v is None:
            return {"type": "null"}
        if isinstance(v, bool):
            return {"type": "integer", "value": str(int(v))}
        if isinstance(v, int):
            return {"type": "integer", "value": str(v)}
        if isinstance(v, float):
            return {"type": "float", "value": v}
        return {"type": "text", "value": str(v)}

    @staticmethod
    def _val(c):
        t = c.get("type")
        if t == "null":
            return None
        if t == "integer":
            return int(c["value"])
        if t == "float":
            return float(c["value"])
        return c.get("value")

    def _stmt(self, sql, params):
        stmt: dict = {"sql": sql}
        if params:
            stmt["args"] = [self._arg(v) for v in params]
        return stmt

    def _result(self, res) -> ExecResult:
        cols = [c["name"] for c in res.get("cols", [])]
        rows = [dict(zip(cols, (self._val(c) for c in row))) for row in res.get("rows", [])]
        lastrowid = res.get("last_insert_rowid")
        return ExecResult(int(lastrowid) if lastrowid is not None else None,
                          int(res.get("affected_row_count") or 0), rows)

    def _post(self, reqs):
        resp = self.session.post(self.endpoint, json={"requests": reqs + [{"type": "close"}]},
                                 timeout=self.timeout)
        if resp.status_code != 200:
            raise RuntimeError(f"Turso HTTP {resp.status_code}: {resp.text[:300]}")
        return resp.json().get("results", [])

    def batch(self, statements, atomic=True):
        statements = list(statements)
        if not atomic:
            results = self._post([{"type": "execute", "stmt": self._stmt(s, p)} for s, p in statements])
            out = []
            for r in results[:len(statements)]:
                if r.get("type") == "error":
                    raise RuntimeError(r["error"].get("message", "Turso error"))
                out.append(self._result(r["response"]["result"]))
            return out

        # Atomic: a Hrana batch where every step only runs if the previous one
        # succeeded, COMMIT only after the last statement, ROLLBACK otherwise.
        steps = [{"stmt": {"sql": "BEGIN"}}]
        for i, (sql, params) in enumerate(statements):
            steps.append({"stmt": self._stmt(sql, params), "condition": {"type": "ok", "step": i}})
        commit_idx = len(steps)
        steps.append({"stmt": {"sql": "COMMIT"}, "condition": {"type": "ok", "step": commit_idx - 1}})
        steps.append({"stmt": {"sql": "ROLLBACK"},
                      "condition": {"type": "not", "cond": {"type": "ok", "step": commit_idx}}})
        results = self._post([{"type": "batch", "batch": {"steps": steps}}])
        r = results[0]
        if r.get("type") == "error":
            raise RuntimeError(r["error"].get("message", "Turso error"))
        res = r["response"]["result"]
        step_results, step_errors = res["step_results"], res["step_errors"]
        for err in step_errors:
            if err:
                raise RuntimeError(err.get("message", "Turso batch step failed"))
        if step_results[commit_idx] is None:
            raise RuntimeError("Turso transaction was not committed")
        return [self._result(step_results[i + 1]) for i in range(len(statements))]


def connect_from_env(base_dir: str) -> Database:
    url = os.environ.get("TURSO_DATABASE_URL")
    token = os.environ.get("TURSO_AUTH_TOKEN")
    if url and token:
        return TursoDatabase(url, token)
    path = os.environ.get("DATABASE_PATH", os.path.join(base_dir, "investments.db"))
    return SqliteDatabase(path)
