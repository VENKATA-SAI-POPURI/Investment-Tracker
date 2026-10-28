"""Ledger repository: scoped reads, validated writes and automatic cash-movement bookkeeping."""
from __future__ import annotations

import json
import threading
import time
from datetime import date, timedelta

from . import domain as d
from .analytics.portfolio import run_fifo
from .db import Database
from .migrations import now_iso


class ValidationError(ValueError):
    pass


class NotFound(LookupError):
    pass


class Forbidden(PermissionError):
    pass


INSTRUMENT_FIELDS = ("name", "symbol", "price_source", "market", "currency", "sector", "market_cap", "category",
                     "sub_category", "tax_class", "platform", "status", "ref", "ref2", "rate", "tenure_months",
                     "maturity_date", "notes", "last_price")
TXN_FIELDS = ("date", "type", "quantity", "amount", "amount_fc", "principal", "fees", "notes")
CASH_FIELDS = ("account", "date", "direction", "amount", "category", "kind", "notes")
GOAL_FIELDS = ("name", "target_amount", "target_date", "monthly_contribution", "expected_return", "allocation",
               "priority", "notes")
NUMERIC = {"quantity", "amount", "amount_fc", "principal", "fees", "rate", "tenure_months", "last_price",
           "target_amount", "monthly_contribution", "expected_return"}


def _num(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        raise ValidationError(f"'{v}' is not a number")


def _date(v, field="date") -> str:
    try:
        return date.fromisoformat(str(v)[:10]).isoformat()
    except (TypeError, ValueError):
        raise ValidationError(f"{field} must be a date (YYYY-MM-DD)")


def _clean(data: dict, fields) -> dict:
    out = {}
    for k in fields:
        if k in data:
            v = data[k]
            if k in NUMERIC:
                v = _num(v)
            elif isinstance(v, str):
                v = v.strip() or None
            out[k] = v
    return out


class Ledger:
    def __init__(self, db: Database, cache_ttl: float = 30.0):
        self.db = db
        self._cache: dict = {}
        self._version = 0
        self._ttl = cache_ttl
        self._lock = threading.Lock()

    # ── cache ──
    def _bump(self):
        with self._lock:
            self._version += 1
            self._cache.clear()

    def _cached(self, key, fn):
        with self._lock:
            hit = self._cache.get(key)
            if hit and hit[0] == self._version and time.time() - hit[1] < self._ttl:
                return hit[2]
        val = fn()
        with self._lock:
            self._cache[key] = (self._version, time.time(), val)
        return val

    # ── scoped reads ──
    @staticmethod
    def _where(scope: str | None, alias: str = "") -> tuple[str, list]:
        col = f"{alias}owner" if alias else "owner"
        return (f"{col} = ?", [scope]) if scope else ("1=1", [])

    def load(self, scope: str | None) -> dict:
        def fetch():
            w, p = self._where(scope)
            res = self.db.batch([
                (f"SELECT * FROM instruments WHERE {w} ORDER BY id", p),
                (f"SELECT * FROM transactions WHERE {w} ORDER BY date, id", p),
                (f"SELECT * FROM cash_movements WHERE {w} ORDER BY date, id", p),
            ], atomic=False)
            return {"instruments": res[0].rows, "transactions": res[1].rows, "cash_movements": res[2].rows}
        return self._cached(("load", scope), fetch)

    def instrument(self, iid: int, scope: str | None) -> dict:
        w, p = self._where(scope)
        row = self.db.one(f"SELECT * FROM instruments WHERE id = ? AND {w}", [iid] + p)
        if not row:
            raise NotFound("Instrument not found")
        return row

    def transaction(self, tid: int, scope: str | None) -> dict:
        w, p = self._where(scope, "t.")
        row = self.db.one(f"SELECT t.*, i.asset_class, i.name AS instrument_name, i.currency, i.ref, i.platform "
                          f"FROM transactions t JOIN instruments i ON i.id = t.instrument_id WHERE t.id = ? AND {w}",
                          [tid] + p)
        if not row:
            raise NotFound("Transaction not found")
        return row

    # ── instruments ──
    def create_instrument(self, owner: str, data: dict) -> dict:
        ac = data.get("asset_class")
        if ac not in d.ASSET_CLASSES:
            raise ValidationError("asset_class must be one of " + ", ".join(d.ASSET_CLASSES))
        fields = _clean(data, INSTRUMENT_FIELDS)
        if not fields.get("name"):
            raise ValidationError("name is required")
        if fields.get("maturity_date"):
            fields["maturity_date"] = _date(fields["maturity_date"], "maturity_date")
        if ac in d.TRADABLE or ac == d.CASH:
            dup = self.db.one("SELECT id FROM instruments WHERE owner = ? AND asset_class = ? AND LOWER(name) = LOWER(?)",
                              (owner, ac, fields["name"]))
            if dup:
                raise ValidationError(f"'{fields['name']}' already exists")
        fields.setdefault("currency", d.currency_for(ac, fields.get("market")))
        fields.setdefault("tax_class", d.default_tax_class(ac, fields.get("market"), fields.get("category"), fields["name"]))
        if fields.get("symbol") and not fields.get("price_source"):
            fields["price_source"] = "amfi" if fields["symbol"].upper().startswith("AMFI:") else "yahoo"
        fields["status"] = (fields.get("status") or "active").lower()
        ts = now_iso()
        cols = ["owner", "asset_class", *fields.keys(), "created_at", "updated_at"]
        vals = [owner, ac, *fields.values(), ts, ts]
        res = self.db.execute(f"INSERT INTO instruments ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)
        self._bump()
        return self.db.one("SELECT * FROM instruments WHERE id = ?", (res.lastrowid,))

    def find_or_create_instrument(self, owner: str, asset_class: str, name: str, defaults: dict) -> dict:
        row = self.db.one("SELECT * FROM instruments WHERE owner = ? AND asset_class = ? AND LOWER(name) = LOWER(?)",
                          (owner, asset_class, name.strip()))
        return row or self.create_instrument(owner, {**defaults, "asset_class": asset_class, "name": name.strip()})

    def update_instrument(self, iid: int, scope: str | None, data: dict) -> dict:
        inst = self.instrument(iid, scope)
        fields = _clean(data, INSTRUMENT_FIELDS)
        if "name" in fields and not fields["name"]:
            raise ValidationError("name cannot be empty")
        if fields.get("maturity_date"):
            fields["maturity_date"] = _date(fields["maturity_date"], "maturity_date")
        if "status" in fields and fields["status"]:
            fields["status"] = fields["status"].lower()
        if "symbol" in fields:
            sym = fields["symbol"]
            fields["price_source"] = ("amfi" if sym and sym.upper().startswith("AMFI:") else "yahoo") if sym else None
            if sym != inst.get("symbol"):
                fields["last_price"] = None
                fields["prev_close"] = None
                fields["last_price_at"] = None
        if "market" in fields and inst["asset_class"] == d.EQUITY:
            fields["currency"] = d.currency_for(d.EQUITY, fields["market"])
        if not fields:
            return inst
        fields["updated_at"] = now_iso()
        self.db.execute(f"UPDATE instruments SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                        [*fields.values(), iid])
        self._bump()
        return self.db.one("SELECT * FROM instruments WHERE id = ?", (iid,))

    def delete_instrument(self, iid: int, scope: str | None):
        self.instrument(iid, scope)
        self.db.batch([
            ("DELETE FROM cash_movements WHERE transaction_id IN (SELECT id FROM transactions WHERE instrument_id = ?)", (iid,)),
            ("DELETE FROM transactions WHERE instrument_id = ?", (iid,)),
            ("DELETE FROM instruments WHERE id = ?", (iid,)),
        ])
        self._bump()

    # ── transactions ──
    def _validate_txn(self, inst: dict, t: dict, exclude_id: int | None = None):
        ac = inst["asset_class"]
        if t.get("type") not in d.TXN_TYPES_BY_CLASS[ac]:
            raise ValidationError(f"{t.get('type')} is not valid for {ac.replace('_', ' ')}; use one of "
                                  + ", ".join(d.TXN_TYPES_BY_CLASS[ac]))
        t["date"] = _date(t.get("date"))
        if t["date"] > (date.today() + timedelta(days=1)).isoformat():
            raise ValidationError("date cannot be in the future")
        if t.get("amount") is None or t["amount"] < 0:
            raise ValidationError("amount must be zero or more")
        for k in ("quantity", "amount_fc", "principal", "fees"):
            if t.get(k) is not None and t[k] < 0:
                raise ValidationError(f"{k} cannot be negative")
        if ac in d.TRADABLE and t["type"] in (d.BUY, d.SELL):
            if not t.get("quantity"):
                raise ValidationError("quantity is required for buys and sells")
        if t["type"] == d.REPAYMENT and t.get("principal") is not None and t["principal"] > t["amount"] + 0.005:
            raise ValidationError("principal cannot exceed the amount credited")
        if t["type"] in (d.FX_IN, d.FX_OUT) and not t.get("amount_fc"):
            raise ValidationError("USD amount is required")
        if ac in d.TRADABLE and t["type"] == d.SELL:
            rows = self.db.query("SELECT * FROM transactions WHERE instrument_id = ? AND date <= ? AND id != ?",
                                 (inst["id"], t["date"], exclude_id or -1))
            lots, _, _ = run_fifo(inst["id"], rows)
            held = sum(l.qty for l in lots)
            if t["quantity"] > held + 1e-6:
                raise ValidationError(f"You held {held:g} units of {inst['name']} on {t['date']}; cannot sell {t['quantity']:g}")

    def _auto_cash(self, inst: dict, t: dict, tid, owner: str, tid_sql: str = "?") -> list:
        """Capital-flow / escrow rows implied by a transaction (same rules as the original app).
        tid_sql lets bulk writes link to a transaction inserted earlier in the same batch."""
        ac, typ, amt, ts = inst["asset_class"], t["type"], float(t.get("amount") or 0), now_iso()
        rows = []
        tid_params = list(tid) if isinstance(tid, (list, tuple)) else [tid]

        def cash(account, direction, category, kind, notes, amount=amt):
            if amount > 0:
                rows.append(("INSERT INTO cash_movements (owner, account, date, direction, amount, category, kind, notes,"
                             f" transaction_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,{tid_sql},'auto',?,?)",
                             [owner, account, t["date"], direction, round(amount, 4), category, kind, notes, *tid_params, ts, ts]))

        name = inst["name"]
        if ac == d.MUTUAL_FUND and typ == d.BUY:
            cash("capital", "in", "Mutual Funds", "Deposit", f"{name} purchase")
        elif ac == d.MUTUAL_FUND and typ == d.SELL:
            cash("capital", "out", "Mutual Funds", "Withdrawal", f"{name} sale")
        elif ac == d.FIXED_DEPOSIT and typ == d.BUY:
            cash("capital", "in", "Fixed Deposits", "Deposit", f"FD at {name}")
        elif ac == d.FIXED_DEPOSIT and typ == d.MATURITY:
            cash("capital", "out", "Fixed Deposits", "Withdrawal", f"FD maturity at {name}")
        elif ac == d.P2P and typ == d.BUY:
            cash("capital", "in", "P2P", "Deposit", f"{name} lending on {inst.get('platform') or ''}".strip())
            cash("p2p_escrow", "in", inst.get("platform"), "Deposit", f"Auto: {inst.get('ref') or ''} - {name} lending")
        elif ac == d.P2P and typ == d.REPAYMENT:
            cash("capital", "out", "P2P", "Withdrawal", f"P2P repayment – {inst.get('ref2') or name}")
            if (t.get("source") or "").startswith("import"):
                cash("p2p_escrow", "out", inst.get("platform"), "Repayment", f"LenDen repayment – {inst.get('ref2') or name}")
        elif ac == d.CASH and typ in (d.FX_IN, d.FX_OUT):
            rate = amt / float(t["amount_fc"]) if t.get("amount_fc") else 0
            label = "deposit" if typ == d.FX_IN else "withdrawal"
            cash("capital", "in" if typ == d.FX_IN else "out", "Equity USA", "Deposit" if typ == d.FX_IN else "Withdrawal",
                 f"Forex {label}: ${float(t['amount_fc']):,.2f} at ₹{rate:.2f}/USD")
        elif typ == d.DIVIDEND:
            cash("capital", "out", "Equity/Commodity", "Withdrawal", f"{name} dividend")
        return rows

    def _auto_enabled(self, owner: str) -> bool:
        s = self.get_settings(owner, "user")
        return str(s.get("autoCapitalFlows", "true")).lower() != "false"

    def add_transaction(self, owner: str, scope: str | None, instrument_id: int, data: dict, source: str = "manual") -> dict:
        inst = self.instrument(instrument_id, scope)
        t = _clean(data, TXN_FIELDS)
        t["type"] = (t.get("type") or "").upper()
        if t["type"] == d.REPAYMENT and t.get("principal") is None and data.get("interest") not in (None, ""):
            t["principal"] = (t.get("amount") or 0) - _num(data["interest"])
        self._validate_txn(inst, t)
        t["source"] = source
        ts = now_iso()
        cols = ["owner", "instrument_id", *t.keys(), "created_at", "updated_at"]
        res = self.db.execute(f"INSERT INTO transactions ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                              [inst["owner"], inst["id"], *t.values(), ts, ts])
        if self._auto_enabled(inst["owner"]):
            auto = self._auto_cash(inst, t, res.lastrowid, inst["owner"])
            if auto:
                self.db.batch(auto)
        self._touch_status(inst)
        self._bump()
        return self.db.one("SELECT * FROM transactions WHERE id = ?", (res.lastrowid,))

    def bulk_add(self, owner: str, entries: list[dict], status_updates: list[tuple[int, str]] = ()) -> int:
        """Insert many transactions (optionally with new instruments) in ONE atomic batch.
        entry: {"instrument": dict (existing row) | None, "new_instrument": dict | None, "txn": dict, "source": str}
        New instruments must carry a unique `ref` so later statements can find their id."""
        ts = now_iso()
        stmts = []
        auto = self._auto_enabled(owner)
        for e in entries:
            t = _clean(e["txn"], TXN_FIELDS)
            t["type"] = (t.get("type") or "").upper()
            t["source"] = e.get("source") or "manual"
            if e.get("new_instrument"):
                spec = {**e["new_instrument"]}
                ac = spec.pop("asset_class")
                f = _clean(spec, INSTRUMENT_FIELDS)
                f.setdefault("currency", d.currency_for(ac, f.get("market")))
                f.setdefault("tax_class", d.default_tax_class(ac, f.get("market"), f.get("category"), f.get("name")))
                f["status"] = (f.get("status") or "active").lower()
                cols = ["owner", "asset_class", *f.keys(), "created_at", "updated_at"]
                stmts.append((f"INSERT INTO instruments ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                              [owner, ac, *f.values(), ts, ts]))
                inst = {"asset_class": ac, "name": f["name"], "owner": owner, **f}
                inst_sql = "(SELECT id FROM instruments WHERE owner = ? AND asset_class = ? AND ref = ? ORDER BY id DESC LIMIT 1)"
                inst_params = [owner, ac, f["ref"]]
            else:
                inst = e["instrument"]
                inst_sql, inst_params = "?", [inst["id"]]
            self._validate_txn({**inst, "id": inst.get("id") or -1}, t)
            cols = list(t.keys())
            stmts.append((f"INSERT INTO transactions (owner, instrument_id, {','.join(cols)}, created_at, updated_at) "
                          f"VALUES (?, {inst_sql}, {','.join('?' * len(cols))}, ?, ?)",
                          [inst.get("owner") or owner, *inst_params, *t.values(), ts, ts]))
            if auto:
                stmts += self._auto_cash(inst, t, inst_params, inst.get("owner") or owner,
                                         tid_sql=f"(SELECT MAX(id) FROM transactions WHERE instrument_id = {inst_sql})")
        for iid, status in status_updates:
            stmts.append(("UPDATE instruments SET status = ?, updated_at = ? WHERE id = ?", (status.lower(), ts, iid)))
        if stmts:
            self.db.batch(stmts)
            self._bump()
        return len(entries)

    def update_transaction(self, tid: int, scope: str | None, data: dict) -> dict:
        cur = self.transaction(tid, scope)
        inst = self.instrument(cur["instrument_id"], scope)
        t = {k: cur[k] for k in TXN_FIELDS}
        t.update(_clean(data, TXN_FIELDS))
        t["type"] = (t.get("type") or "").upper()
        self._validate_txn(inst, t, exclude_id=tid)
        stmts = [(f"UPDATE transactions SET {', '.join(f'{k} = ?' for k in TXN_FIELDS)}, updated_at = ? WHERE id = ?",
                  [*(t[k] for k in TXN_FIELDS), now_iso(), tid])]
        # Regenerate linked automatic cash movements so they always match the transaction. Migrated
        # transactions without linked rows are left alone: legacy capital flows already count them.
        linked = self.db.one("SELECT 1 AS x FROM cash_movements WHERE transaction_id = ? AND source IN ('auto','migration')", (tid,))
        if linked or (not cur.get("legacy_ref") and self._auto_enabled(inst["owner"])):
            stmts.append(("DELETE FROM cash_movements WHERE transaction_id = ? AND source IN ('auto','migration')", (tid,)))
            stmts += self._auto_cash(inst, {**t, "source": cur["source"]}, tid, inst["owner"])
        self.db.batch(stmts)
        self._touch_status(inst)
        self._bump()
        return self.db.one("SELECT * FROM transactions WHERE id = ?", (tid,))

    def delete_transaction(self, tid: int, scope: str | None):
        cur = self.transaction(tid, scope)
        inst = self.instrument(cur["instrument_id"], scope)
        if inst["asset_class"] in d.TRADABLE and cur["type"] == d.BUY:
            rows = self.db.query("SELECT * FROM transactions WHERE instrument_id = ? AND id != ?", (inst["id"], tid))
            sold = sum(float(r["quantity"] or 0) for r in rows if r["type"] == d.SELL)
            bought = sum(float(r["quantity"] or 0) for r in rows if r["type"] == d.BUY)
            if sold > bought + 1e-6:
                raise ValidationError("Deleting this purchase would leave more units sold than bought; delete the sale first")
        self.db.batch([("DELETE FROM cash_movements WHERE transaction_id = ?", (tid,)),
                       ("DELETE FROM transactions WHERE id = ?", (tid,))])
        self._touch_status(inst)
        self._bump()

    def _touch_status(self, inst: dict):
        """Keep FD status in sync with maturity transactions."""
        if inst["asset_class"] == d.FIXED_DEPOSIT:
            matured = self.db.one("SELECT 1 AS x FROM transactions WHERE instrument_id = ? AND type = 'MATURITY'", (inst["id"],))
            self.db.execute("UPDATE instruments SET status = ? WHERE id = ?", ("closed" if matured else "active", inst["id"]))

    # ── cash movements ──
    def add_cash(self, owner: str, data: dict) -> dict:
        c = _clean(data, CASH_FIELDS)
        self._validate_cash(c)
        ts = now_iso()
        cols = ["owner", *c.keys(), "source", "created_at", "updated_at"]
        res = self.db.execute(f"INSERT INTO cash_movements ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                              [owner, *c.values(), "manual", ts, ts])
        self._bump()
        return self.db.one("SELECT * FROM cash_movements WHERE id = ?", (res.lastrowid,))

    @staticmethod
    def _validate_cash(c: dict):
        if c.get("account") not in ("capital", "p2p_escrow"):
            raise ValidationError("account must be capital or p2p_escrow")
        if c.get("direction") not in ("in", "out"):
            raise ValidationError("direction must be in or out")
        c["date"] = _date(c.get("date"))
        if c.get("amount") is None:
            raise ValidationError("amount is required")

    def update_cash(self, cid: int, scope: str | None, data: dict) -> dict:
        w, p = self._where(scope)
        cur = self.db.one(f"SELECT * FROM cash_movements WHERE id = ? AND {w}", [cid] + p)
        if not cur:
            raise NotFound("Entry not found")
        if cur["transaction_id"] and cur["source"] == "auto":
            raise ValidationError("This entry is generated from a transaction; edit the transaction instead")
        c = {k: cur[k] for k in CASH_FIELDS}
        c.update(_clean(data, CASH_FIELDS))
        self._validate_cash(c)
        self.db.execute(f"UPDATE cash_movements SET {', '.join(f'{k} = ?' for k in CASH_FIELDS)}, updated_at = ? WHERE id = ?",
                        [*(c[k] for k in CASH_FIELDS), now_iso(), cid])
        self._bump()
        return self.db.one("SELECT * FROM cash_movements WHERE id = ?", (cid,))

    def delete_cash(self, cid: int, scope: str | None):
        w, p = self._where(scope)
        cur = self.db.one(f"SELECT * FROM cash_movements WHERE id = ? AND {w}", [cid] + p)
        if not cur:
            raise NotFound("Entry not found")
        self.db.execute("DELETE FROM cash_movements WHERE id = ?", (cid,))
        self._bump()

    # ── settings ──
    @staticmethod
    def settings_owner(email: str, role: str) -> str:
        return email if role == "user" else "__global__"

    def get_settings(self, email: str, role: str) -> dict:
        def fetch():
            owner = self.settings_owner(email, role)
            rows = self.db.query("SELECT owner, key, value FROM user_settings WHERE owner IN (?, '__global__')", (owner,))
            out = {}
            for r in sorted(rows, key=lambda r: r["owner"] != "__global__"):  # user values override global
                try:
                    out[r["key"]] = json.loads(r["value"]) if r["value"] and r["value"][:1] in "{[" else r["value"]
                except json.JSONDecodeError:
                    out[r["key"]] = r["value"]
            return out
        return self._cached(("settings", email, role), fetch)

    def set_setting(self, email: str, role: str, key: str, value):
        owner = self.settings_owner(email, role)
        raw = json.dumps(value) if isinstance(value, (dict, list)) else (None if value is None else str(value))
        self.db.execute("INSERT INTO user_settings (owner, key, value, updated_at) VALUES (?,?,?,?) "
                        "ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                        (owner, key, raw, now_iso()))
        self._bump()

    def system_value(self, key: str):
        row = self.db.one("SELECT value FROM user_settings WHERE owner = '__system__' AND key = ?", (key,))
        return row["value"] if row else None

    def set_system_value(self, key: str, value: str):
        self.db.execute("INSERT INTO user_settings (owner, key, value, updated_at) VALUES ('__system__',?,?,?) "
                        "ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                        (key, value, now_iso()))

    # ── goals ──
    def goals(self, scope: str | None) -> list[dict]:
        w, p = self._where(scope)
        return self.db.query(f"SELECT * FROM goals WHERE {w} ORDER BY target_date", p)

    def save_goal(self, owner: str, scope: str | None, data: dict, gid: int | None = None) -> dict:
        g = _clean(data, GOAL_FIELDS)
        if isinstance(data.get("allocation"), dict):
            g["allocation"] = json.dumps({k: float(v) for k, v in data["allocation"].items() if v not in (None, "", 0)})
        if gid is None:
            for req in ("name", "target_amount", "target_date"):
                if not g.get(req):
                    raise ValidationError(f"{req.replace('_', ' ')} is required")
        if "target_date" in g:
            g["target_date"] = _date(g["target_date"], "target date")
        if g.get("target_amount") is not None and g["target_amount"] <= 0:
            raise ValidationError("target amount must be positive")
        ts = now_iso()
        if gid is None:
            cols = ["owner", *g.keys(), "created_at", "updated_at"]
            res = self.db.execute(f"INSERT INTO goals ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                                  [owner, *g.values(), ts, ts])
            gid = res.lastrowid
        else:
            w, p = self._where(scope)
            if not self.db.one(f"SELECT id FROM goals WHERE id = ? AND {w}", [gid] + p):
                raise NotFound("Goal not found")
            if g:
                self.db.execute(f"UPDATE goals SET {', '.join(f'{k} = ?' for k in g)}, updated_at = ? WHERE id = ?",
                                [*g.values(), ts, gid])
        self._bump()
        return self.db.one("SELECT * FROM goals WHERE id = ?", (gid,))

    def delete_goal(self, gid: int, scope: str | None):
        w, p = self._where(scope)
        if not self.db.one(f"SELECT id FROM goals WHERE id = ? AND {w}", [gid] + p):
            raise NotFound("Goal not found")
        self.db.execute("DELETE FROM goals WHERE id = ?", (gid,))
        self._bump()

    # ── prices ──
    def store_quotes(self, quotes: dict[str, dict | None]):
        stamp = now_iso()
        stmts = [("UPDATE instruments SET last_price = ?, prev_close = ?, last_price_at = ? WHERE symbol = ?",
                  (q["price"], q.get("prev_close"), stamp, sym)) for sym, q in quotes.items() if q]
        if stmts:
            self.db.batch(stmts)
            self._bump()
