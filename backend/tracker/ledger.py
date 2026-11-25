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
SIP_FIELDS = ("instrument_id", "name", "segment", "amount", "frequency", "day_of_month", "step_up_pct", "start_date",
              "end_date", "active", "notes", "goal_id")
# What a bulk write may set on an instrument: the user fields plus the stamp of a hand-entered price (an NPS NAV)
BULK_INSTRUMENT_FIELDS = INSTRUMENT_FIELDS + ("last_price_at",)
# The Transactions page's money columns (transactions.component.ts): money put in vs money taken out or received
TXN_OUT_TYPES = (d.BUY, d.FX_IN)
TXN_IN_TYPES = (d.SELL, d.DIVIDEND, d.INTEREST, d.REPAYMENT, d.MATURITY, d.FX_OUT)
TXN_SORTS = ("date", "-date", "amount", "-amount", "name", "-name")
TXN_FILTERS = ("asset_class", "instrument_id", "type", "from", "to")
PAGE_SIZE_MIN, PAGE_SIZE_MAX, QUERY_MAX = 10, 200, 100
SIP_FREQUENCIES = ("monthly", "quarterly", "weekly", "yearly")
GLOBAL_OWNER = "__global__"   # the settings owner shared by admins and guests (the family plan)
ACTION_STATUSES = ("open", "planned", "snoozed", "done", "dismissed", "expired")
# What a user decision may set, what the computed-on-read upsert may set, and what Undo (status 'open') clears
ACTION_STATUS_FIELDS = ("snooze_until", "planned_for", "note", "reason", "evidence", "done_at", "done_via")
ACTION_SEEN_FIELDS = ("first_seen", "tier_first", "category", "title", "impact", "impact_kind", "due", "status",
                      "done_via", "evidence", "done_at")
ACTION_TRANSITION_FIELDS = ("status", "done_via", "evidence", "done_at")  # what the computed upsert may change (A6)
ACTION_CLEARED_ON_OPEN =("done_at", "done_via", "evidence", "snooze_until", "planned_for")
ACTION_FILL_FIELDS = ("tier_first", "category", "title", "impact", "impact_kind", "due")  # filled when blank only
NUMERIC = {"quantity", "amount", "amount_fc", "principal", "fees", "rate", "tenure_months", "last_price",
           "target_amount", "monthly_contribution", "expected_return", "step_up_pct"}


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
    # One process serves the API and every write bumps the version, so cached reads only need a
    # safety-net expiry (other writers, e.g. a migration run elsewhere)
    def __init__(self, db: Database, cache_ttl: float = 600.0):
        self.db = db
        self._cache: dict = {}
        self._version = 0
        self._actions_rev = 0
        self._ttl = cache_ttl
        self._lock = threading.Lock()

    # ── cache ──
    def _bump(self):
        with self._lock:
            self._version += 1
            self._cache.clear()

    def bump_actions(self):
        """An action status changed. Only memo entries whose key carries actions_rev go stale (by key);
        the cache is NOT cleared, so the portfolio, tax and plan memos stay warm."""
        with self._lock:
            self._actions_rev += 1

    @property
    def actions_rev(self) -> int:
        return self._actions_rev

    def _cached(self, key, fn):
        with self._lock:
            hit = self._cache.get(key)
            if hit and hit[0] == self._version and time.time() - hit[1] < self._ttl:
                return hit[2]
        val = fn()
        with self._lock:
            self._cache[key] = (self._version, time.time(), val)
        return val

    def _peek(self, key):
        """The cached value for `key` without building it: None when missing, from an older version or expired."""
        with self._lock:
            hit = self._cache.get(key)
            if hit and hit[0] == self._version and time.time() - hit[1] < self._ttl:
                return hit[2]
        return None

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

    def transaction_rows(self, scope: str | None, filters: dict | None = None) -> list[dict]:
        """Today's GET /transactions items, newest first: each transaction plus instrument_name, asset_class,
        segment and currency. `filters` keys (asset_class, instrument_id, type, from, to) filter as the route's
        query parameters do; empty values are ignored. Built over the memoised load(scope)."""
        data = self.load(scope)
        inst = {i["id"]: i for i in data["instruments"]}
        f = {k: v for k, v in (filters or {}).items() if k in TXN_FILTERS and v not in (None, "")}
        out = []
        for t in data["transactions"]:
            i = inst.get(t["instrument_id"])
            if not i:
                continue
            if f.get("asset_class") and i["asset_class"] != f["asset_class"]:
                continue
            if f.get("instrument_id") and str(t["instrument_id"]) != str(f["instrument_id"]):
                continue
            if f.get("type") and t["type"] != f["type"]:
                continue
            if f.get("from") and t["date"] < f["from"]:
                continue
            if f.get("to") and t["date"] > f["to"]:
                continue
            out.append({**t, "instrument_name": i["name"], "asset_class": i["asset_class"], "segment": d.segment_of(i),
                        "currency": i.get("currency")})
        out.sort(key=lambda t: (t["date"], t["id"]), reverse=True)
        return out

    @staticmethod
    def _page_int(v, field: str, default: int) -> int:
        if v in (None, ""):
            return default
        if isinstance(v, bool):
            raise ValidationError(f"{field} must be a whole number")
        try:
            n = float(v)
        except (TypeError, ValueError):
            raise ValidationError(f"{field} must be a whole number")
        if n != n or n in (float("inf"), float("-inf")) or not n.is_integer():
            raise ValidationError(f"{field} must be a whole number")
        return int(n)

    def transactions_page(self, scope: str | None, page=1, size=50, q: str | None = None, sort: str = "-date", *,
                          filters: dict | None = None) -> dict:
        """One page of the transaction list (P2.11, K4).

        Returns {rows, total, page, size, pages, sums: {count, out, in, net}, months: [{month, count, out, in}]}.
        rows have today's GET /transactions item shape. `q` (trimmed, case-insensitive, at most 100 characters)
        matches the instrument name, its symbol, the transaction type and the notes. `sort` is date, amount or name,
        ascending or with a leading '-' descending, with id as the tie-break in the same direction. `size` is
        clamped to 10-200 and `page` to >= 1; a page past the end has no rows but the true total. sums and months
        (newest first) cover every filtered row, not just the page: out = BUY + FX_IN, in = SELL, DIVIDEND,
        INTEREST, REPAYMENT, MATURITY, FX_OUT, net = out - in. A non-numeric page or size, or an unknown sort,
        raises ValidationError."""
        sort = (sort or "-date").strip()
        if sort not in TXN_SORTS:
            raise ValidationError("sort must be one of " + ", ".join(TXN_SORTS))
        page = max(1, self._page_int(page, "page", 1))
        size = min(PAGE_SIZE_MAX, max(PAGE_SIZE_MIN, self._page_int(size, "size", 50)))
        rows = self.transaction_rows(scope, filters)
        needle = (q or "").strip().lower()[:QUERY_MAX]
        if needle:
            symbols = {i["id"]: (i.get("symbol") or "") for i in self.load(scope)["instruments"]}
            rows = [t for t in rows if needle in " ".join((t.get("instrument_name") or "", symbols.get(t["instrument_id"], ""),
                                                           t.get("type") or "", t.get("notes") or "")).lower()]
        key = sort.lstrip("-")
        if key == "amount":
            rows.sort(key=lambda t: (float(t.get("amount") or 0), t["id"]), reverse=sort.startswith("-"))
        elif key == "name":
            rows.sort(key=lambda t: ((t.get("instrument_name") or "").lower(), t["id"]), reverse=sort.startswith("-"))
        elif sort == "date":
            rows.reverse()  # transaction_rows is newest first with id as the tie-break
        sums = {"count": 0, "out": 0.0, "in": 0.0}
        months: dict[str, dict] = {}
        for t in rows:
            m = months.setdefault(str(t["date"])[:7], {"month": str(t["date"])[:7], "count": 0, "out": 0.0, "in": 0.0})
            amt = float(t.get("amount") or 0)
            side = "out" if t["type"] in TXN_OUT_TYPES else "in" if t["type"] in TXN_IN_TYPES else None
            for bucket in (sums, m):
                bucket["count"] += 1
                if side:
                    bucket[side] += amt
        total = len(rows)
        return {
            "rows": rows[(page - 1) * size: page * size],
            "total": total, "page": page, "size": size, "pages": max(1, -(-total // size)),
            "sums": {"count": sums["count"], "out": round(sums["out"], 2), "in": round(sums["in"], 2),
                     "net": round(sums["out"] - sums["in"], 2)},
            "months": [{**m, "out": round(m["out"], 2), "in": round(m["in"], 2)}
                       for m in sorted(months.values(), key=lambda m: m["month"], reverse=True)],
        }

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
        if fields.get("last_price") is not None and "symbol" not in fields and not inst.get("symbol"):
            # A price typed in by hand (e.g. an NPS NAV from the latest statement)
            fields["last_price_at"] = now_iso()
            fields["price_source"] = "manual"
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
    def _validate_txn(self, inst: dict, t: dict, exclude_id: int | None = None, check_holdings: bool = True):
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
        if ac in d.UNITISED and t["type"] in (d.BUY, d.SELL):
            if not t.get("quantity"):
                raise ValidationError("quantity is required for buys and sells")
        if t["type"] in d.CORPORATE_ACTIONS:
            if not t.get("quantity"):
                raise ValidationError("bonus shares received are required" if t["type"] == d.BONUS
                                      else "split ratio is required (new shares for each old share)")
            t["amount"] = 0.0
        if t["type"] == d.REPAYMENT and t.get("principal") is not None and t["principal"] > t["amount"] + 0.005:
            raise ValidationError("principal cannot exceed the amount credited")
        if t["type"] in (d.FX_IN, d.FX_OUT) and not t.get("amount_fc"):
            raise ValidationError("USD amount is required")
        if check_holdings and ac in d.UNITISED and t["type"] == d.SELL:
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
            # lent from the P2P wallet: the money came in when the wallet was topped up, not now
            cash("p2p_escrow", "out", inst.get("platform"), "Loan funded", f"Loan funded – {inst.get('ref2') or name}")
        elif ac == d.P2P and typ == d.REPAYMENT:
            # repayments go straight to the bank: money back to you; the wallet is untouched
            cash("capital", "out", "P2P", "Withdrawal", f"P2P repayment – {inst.get('ref2') or name}")
        elif ac == d.CASH and typ in (d.FX_IN, d.FX_OUT):
            rate = amt / float(t["amount_fc"]) if t.get("amount_fc") else 0
            label = "deposit" if typ == d.FX_IN else "withdrawal"
            cash("capital", "in" if typ == d.FX_IN else "out", "Equity USA", "Deposit" if typ == d.FX_IN else "Withdrawal",
                 f"Forex {label}: ${float(t['amount_fc']):,.2f} at ₹{rate:.2f}/USD")
        elif ac in (d.EPF, d.NPS) and typ in (d.BUY, d.SELL):
            label = "EPF" if ac == d.EPF else "NPS"
            cash("capital", "in" if typ == d.BUY else "out", label, "Deposit" if typ == d.BUY else "Withdrawal",
                 f"{name} {'contribution' if typ == d.BUY else 'withdrawal'}")
        elif typ == d.DIVIDEND and inst.get("currency") == "USD" and self._has_wallet(owner):
            pass   # paid into the USD wallet: it stays in the US account (the wallet balance rises)
        elif typ == d.DIVIDEND:
            cash("capital", "out", "Equity/Commodity", "Withdrawal", f"{name} dividend")
        return rows

    CASH_RULE_NOTES = {
        (d.EQUITY, d.BUY): "Stock buys are paid from your broker balance, which the app doesn't track, so no cash entry.",
        (d.EQUITY, d.SELL): "Sale money stays in your broker balance, so no cash entry.",
        (d.COMMODITY, d.BUY): "Like stocks: paid from the broker balance, no cash entry.",
        (d.COMMODITY, d.SELL): "Like stocks: no cash entry.",
        (d.FIXED_DEPOSIT, d.INTEREST): "Interest paid out to your bank creates no cash entry (the maturity does).",
        (d.EPF, d.CREDIT): "Interest credited stays inside EPF: not money in or out.",
        (d.EQUITY, d.DIVIDEND): "Indian dividends go to your bank (money out). US dividends are paid into the USD wallet "
                                "and stay in the US account, so they make no cash entry and raise the wallet balance.",
        (d.P2P, d.BUY): "A loan is funded from your P2P wallet, so it isn't new money: the wallet top-up was. (If no "
                        "top-up was recorded before it, the loan amount counts as added on its date.)",
        (d.P2P, d.REPAYMENT): "Repayments are paid straight to your bank: money back to you. The P2P wallet is untouched.",
    }

    def cash_rules(self) -> list[dict]:
        """What cash entries each kind of transaction creates, worked out by running `_auto_cash` itself on a
        sample of each (so this table can never disagree with the code). One row per asset class and type."""
        out = []
        n = 0
        for ac, types in d.TXN_TYPES_BY_CLASS.items():
            inst = {"asset_class": ac, "name": "<name>", "platform": "<platform>", "ref": "<ref>", "ref2": "<loan id>"}
            for typ in types:
                n += 1
                variants = []
                for source in (("manual", "import") if (ac, typ) == (d.P2P, d.REPAYMENT) else ("manual",)):
                    sql = self._auto_cash(inst, {"type": typ, "amount": 1000.0, "amount_fc": 12.0, "date": "2026-01-01",
                                                 "source": source}, 0, "owner")
                    variants.append({"source": source, "entries": [
                        {"account": p[1], "direction": p[3], "category": p[5], "kind": p[6], "note": p[7]} for _, p in sql]})
                out.append({"id": f"R{n}", "asset_class": ac, "type": typ, "entries": variants[0]["entries"],
                            "import_entries": variants[1]["entries"] if len(variants) > 1 else None,
                            "note": self.CASH_RULE_NOTES.get((ac, typ))})
        return out

    def _has_wallet(self, owner: str) -> bool:
        return bool(self.db.one("SELECT 1 AS x FROM instruments WHERE owner = ? AND asset_class = ? LIMIT 1", (owner, d.CASH)))

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

    def bulk_add(self, owner: str, entries: list[dict], status_updates: list[tuple[int, str]] = (),
                 check_holdings: bool = True, field_updates: list[tuple[int, dict]] = (),
                 remove_txns: list[int] = (), txn_updates: list[tuple[int, dict]] = ()) -> int:
        """Insert many transactions (optionally with new instruments) in ONE atomic batch.
        entry: {"instrument": dict (existing row) | None, "new_instrument": dict | None,
                "txn": dict | "txns": [dict, ...], "source": str}
        Later statements find a new instrument's id by (owner, asset_class, ref), newest first; one without a
        `ref` is found by (owner, asset_class, LOWER(name)), newest first, the identity find_or_create_instrument
        uses, so the caller must not plan two new instruments with the same class and name (or the same ref
        unless each is followed directly by its own transactions). "txns": [] adds an instrument alone.
        field_updates: (instrument id, {field: value}); remove_txns: transaction ids deleted first, with their
        linked cash movements; txn_updates: (transaction id, {field: value}). Callers validate the end state
        (e.g. FIFO holdings) before calling, since rows removed here are still in the database meanwhile."""
        ts = now_iso()
        stmts = []
        for tid in remove_txns:
            stmts += [("DELETE FROM cash_movements WHERE transaction_id = ?", (tid,)), ("DELETE FROM transactions WHERE id = ?", (tid,))]
        for tid, fields in txn_updates:
            f = _clean(fields, TXN_FIELDS)
            if f:
                stmts.append((f"UPDATE transactions SET {', '.join(f'{k} = ?' for k in f)}, updated_at = ? WHERE id = ?",
                              [*f.values(), ts, tid]))
        auto = self._auto_enabled(owner)
        for e in entries:
            if e.get("new_instrument"):
                spec = {**e["new_instrument"]}
                ac = spec.pop("asset_class")
                f = _clean(spec, BULK_INSTRUMENT_FIELDS)
                if not f.get("name"):
                    raise ValidationError("name is required")
                f.setdefault("currency", d.currency_for(ac, f.get("market")))
                f.setdefault("tax_class", d.default_tax_class(ac, f.get("market"), f.get("category"), f.get("name")))
                if f.get("symbol") and not f.get("price_source"):
                    f["price_source"] = "amfi" if f["symbol"].upper().startswith("AMFI:") else "yahoo"
                f["status"] = (f.get("status") or "active").lower()
                cols = ["owner", "asset_class", *f.keys(), "created_at", "updated_at"]
                stmts.append((f"INSERT INTO instruments ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                              [owner, ac, *f.values(), ts, ts]))
                inst = {"asset_class": ac, "name": f["name"], "owner": owner, **f}
                if f.get("ref"):
                    inst_sql = "(SELECT id FROM instruments WHERE owner = ? AND asset_class = ? AND ref = ? ORDER BY id DESC LIMIT 1)"
                    inst_params = [owner, ac, f["ref"]]
                else:
                    inst_sql = ("(SELECT id FROM instruments WHERE owner = ? AND asset_class = ? AND LOWER(name) = LOWER(?) "
                                "ORDER BY id DESC LIMIT 1)")
                    inst_params = [owner, ac, f["name"]]
            else:
                inst = e["instrument"]
                inst_sql, inst_params = "?", [inst["id"]]
            for raw in (e["txns"] if e.get("txns") is not None else [e["txn"]]):
                t = _clean(raw, TXN_FIELDS)
                t["type"] = (t.get("type") or "").upper()
                t["source"] = e.get("source") or "manual"
                self._validate_txn({**inst, "id": inst.get("id") or -1}, t, check_holdings=check_holdings)
                cols = list(t.keys())
                stmts.append((f"INSERT INTO transactions (owner, instrument_id, {','.join(cols)}, created_at, updated_at) "
                              f"VALUES (?, {inst_sql}, {','.join('?' * len(cols))}, ?, ?)",
                              [inst.get("owner") or owner, *inst_params, *t.values(), ts, ts]))
                if auto:
                    stmts += self._auto_cash(inst, t, inst_params, inst.get("owner") or owner,
                                             tid_sql=f"(SELECT MAX(id) FROM transactions WHERE instrument_id = {inst_sql})")
        for iid, status in status_updates:
            stmts.append(("UPDATE instruments SET status = ?, updated_at = ? WHERE id = ?", (status.lower(), ts, iid)))
        for iid, fields in field_updates:
            f = _clean(fields, BULK_INSTRUMENT_FIELDS)
            if f:
                stmts.append((f"UPDATE instruments SET {', '.join(f'{k} = ?' for k in f)}, updated_at = ? WHERE id = ?",
                              [*f.values(), ts, iid]))
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
        if inst["asset_class"] in d.UNITISED and cur["type"] in (d.BUY, d.BONUS, d.SPLIT):
            rows = self.db.query("SELECT * FROM transactions WHERE instrument_id = ? AND id != ?", (inst["id"], tid))
            _, _, unmatched = run_fifo(inst["id"], rows)
            if unmatched > 1e-6:
                raise ValidationError("Deleting this would leave more units sold than held; delete the sale first")
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

    def setting_keys(self, owner: str) -> set[str]:
        """The setting keys that have a row of their own under this settings owner (an email or '__global__').
        GET /settings reports the keys a member inherits from '__global__' with it (AMENDMENTS R8, R11). Uncached:
        one small indexed read."""
        return {r["key"] for r in self.db.query("SELECT key FROM user_settings WHERE owner = ?", (owner,))}

    def set_setting(self, email: str, role: str, key: str, value):
        owner = self.settings_owner(email, role)
        raw = json.dumps(value) if isinstance(value, (dict, list)) else (None if value is None else str(value))
        self.db.execute("INSERT INTO user_settings (owner, key, value, updated_at) VALUES (?,?,?,?) "
                        "ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                        (owner, key, raw, now_iso()))
        self._bump()

    def system_value(self, key: str):
        def fetch():
            row = self.db.one("SELECT value FROM user_settings WHERE owner = '__system__' AND key = ?", (key,))
            return row["value"] if row else None
        return self._cached(("system", key), fetch)

    def set_system_value(self, key: str, value: str):
        self.db.execute("INSERT INTO user_settings (owner, key, value, updated_at) VALUES ('__system__',?,?,?) "
                        "ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                        (key, value, now_iso()))
        with self._lock:
            self._cache[("system", key)] = (self._version, time.time(), value)

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
        """Delete a goal. SIP plans that funded it are kept and lose the link (goal_id NULL), in the same batch."""
        w, p = self._where(scope)
        if not self.db.one(f"SELECT id FROM goals WHERE id = ? AND {w}", [gid] + p):
            raise NotFound("Goal not found")
        self.db.batch([("UPDATE sip_plans SET goal_id = NULL WHERE goal_id = ?", (gid,)),
                       ("DELETE FROM goals WHERE id = ?", (gid,))])
        self._bump()

    def _sip_goal_id(self, value, plan_owner: str) -> int | None:
        """A SIP plan's goal link (K3): None or '' clears it; otherwise it must be the id of a goal that belongs to
        the plan's owner."""
        if value in (None, ""):
            return None
        refused = ValidationError("That goal isn't one of this portfolio's goals")
        if isinstance(value, bool):
            raise refused
        if isinstance(value, int):
            gid = value
        elif isinstance(value, float) and value.is_integer():
            gid = int(value)
        elif isinstance(value, str) and value.strip().isdigit():
            gid = int(value.strip())
        else:
            raise refused
        row = self.db.one("SELECT owner FROM goals WHERE id = ?", (gid,))
        if not row or row["owner"] != plan_owner:
            raise refused
        return gid

    # ── SIP plans ──
    def sips(self, scope: str | None) -> list[dict]:
        w, p = self._where(scope, "s.")
        return self.db.query(f"SELECT s.*, i.name AS instrument_name, i.asset_class FROM sip_plans s "
                             f"LEFT JOIN instruments i ON i.id = s.instrument_id WHERE {w} ORDER BY s.active DESC, s.day_of_month, s.name", p)

    def save_sip(self, owner: str, scope: str | None, data: dict, sid: int | None = None) -> dict:
        """Create (sid None) or update a SIP plan. `goal_id` links it to a goal of the plan's owner (the `owner`
        argument on create, the stored row's owner on update); None or '' unlinks it."""
        s = _clean(data, SIP_FIELDS)
        stored = None
        if sid is not None:
            w, p = self._where(scope)
            stored = self.db.one(f"SELECT id, owner FROM sip_plans WHERE id = ? AND {w}", [sid] + p)
            if not stored:
                raise NotFound("SIP plan not found")
        if "goal_id" in s:
            s["goal_id"] = self._sip_goal_id(s["goal_id"], stored["owner"] if stored else owner)
        if "instrument_id" in s and s["instrument_id"] not in (None, ""):
            inst = self.instrument(int(s["instrument_id"]), scope)
            s["instrument_id"] = inst["id"]
            s.setdefault("name", inst["name"])
            if not s.get("name"):
                s["name"] = inst["name"]
            s["segment"] = d.segment_of(inst)
        elif "instrument_id" in s:
            s["instrument_id"] = None
        if sid is None:
            if not s.get("name"):
                raise ValidationError("name is required")
            if s.get("amount") is None:
                raise ValidationError("amount is required")
        if s.get("amount") is not None and s["amount"] <= 0:
            raise ValidationError("amount must be positive")
        if "frequency" in s:
            s["frequency"] = (s["frequency"] or "monthly").lower()
            if s["frequency"] not in SIP_FREQUENCIES:
                raise ValidationError("frequency must be one of " + ", ".join(SIP_FREQUENCIES))
        if "day_of_month" in s:
            try:
                s["day_of_month"] = int(s["day_of_month"] or 1)
            except (TypeError, ValueError):
                raise ValidationError("day_of_month must be a number")
            if not 1 <= s["day_of_month"] <= 28:
                raise ValidationError("day_of_month must be between 1 and 28")
        if "segment" in s and s["segment"] and s["segment"] not in d.SEGMENTS:
            raise ValidationError("Unknown segment")
        for k in ("start_date", "end_date"):
            if s.get(k):
                s[k] = _date(s[k], k.replace("_", " "))
        if "active" in s:
            s["active"] = 1 if s["active"] in (1, True, "1", "true", "True") else 0
        ts = now_iso()
        if sid is None:
            s.setdefault("frequency", "monthly")
            s.setdefault("day_of_month", 1)
            s.setdefault("active", 1)
            s.setdefault("start_date", ts[:10])
            cols = ["owner", *s.keys(), "created_at", "updated_at"]
            res = self.db.execute(f"INSERT INTO sip_plans ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                                  [owner, *s.values(), ts, ts])
            sid = res.lastrowid
        else:
            if s:
                self.db.execute(f"UPDATE sip_plans SET {', '.join(f'{k} = ?' for k in s)}, updated_at = ? WHERE id = ?",
                                [*s.values(), ts, sid])
        self._bump()
        return next(r for r in self.sips(None) if r["id"] == sid)

    def delete_sip(self, sid: int, scope: str | None):
        w, p = self._where(scope)
        if not self.db.one(f"SELECT id FROM sip_plans WHERE id = ? AND {w}", [sid] + p):
            raise NotFound("SIP plan not found")
        self.db.execute("DELETE FROM sip_plans WHERE id = ?", (sid,))
        self._bump()

    # ── action log (follow-through) ──
    # None of these call _bump: a status change bumps actions_rev only, and the seen / auto-done upserts and
    # KPI snapshots change nothing a cached computation depends on.

    @staticmethod
    def _action_row(r: dict) -> dict:
        row = dict(r)
        raw = row.get("evidence")
        try:
            row["evidence"] = json.loads(raw) if raw else None
        except (TypeError, json.JSONDecodeError):
            row["evidence"] = None
        return row

    def action_log(self, owners: list[str]) -> dict[tuple[str, str], dict]:
        """Every action_log row for these owners, keyed by (owner, id). `evidence` is decoded from JSON."""
        owners = [o for o in dict.fromkeys(owners or []) if o]
        if not owners:
            return {}
        rows = self.db.query(f"SELECT * FROM action_log WHERE owner IN ({','.join('?' * len(owners))})", owners)
        return {(r["owner"], r["id"]): self._action_row(r) for r in rows}

    def log_stamps(self, keys) -> dict[tuple[str, str], dict]:
        """{(owner, id): {status, seen_at, pushed_at}} for the action_log rows among `keys` ((owner, id) pairs);
        a pair with no row is absent. The bulk read behind the bell's seen/unread and the digest's pushed_at
        check (AMENDMENTS R9, R10). Read live, outside any memo (K7)."""
        keys = [k for k in dict.fromkeys(keys or []) if k and k[0] and k[1]]
        out: dict[tuple[str, str], dict] = {}
        by_owner: dict[str, list[str]] = {}
        for owner, aid in keys:
            by_owner.setdefault(owner, []).append(aid)
        for owner, ids in by_owner.items():
            for i in range(0, len(ids), 400):   # stay well under SQLite's bound-parameter limit
                chunk = ids[i:i + 400]
                rows = self.db.query("SELECT owner, id, status, seen_at, pushed_at FROM action_log WHERE owner = ? "
                                     f"AND id IN ({','.join('?' * len(chunk))})", [owner, *chunk])
                for r in rows:
                    out[(r["owner"], r["id"])] = {"status": r["status"], "seen_at": r["seen_at"],
                                                  "pushed_at": r["pushed_at"]}
        return out

    def action_row(self, owner: str, aid: str) -> dict | None:
        r = self.db.one("SELECT * FROM action_log WHERE owner = ? AND id = ?", (owner, aid))
        return self._action_row(r) if r else None

    def set_action_status(self, owner: str, aid: str, status: str, **fields) -> dict:
        """Upsert a user's decision on an action (the row is created when it has never been seen).
        'open' clears the done, snooze and plan fields (Undo). Bumps actions_rev, never the ledger version."""
        if status not in ACTION_STATUSES:
            raise ValidationError("status must be one of " + ", ".join(ACTION_STATUSES))
        if not owner or not aid:
            raise ValidationError("owner and id are required")
        unknown = set(fields) - set(ACTION_STATUS_FIELDS)
        if unknown:
            raise ValidationError("Unknown field(s): " + ", ".join(sorted(unknown)))
        f = dict(fields)
        for k in ("snooze_until", "planned_for"):
            if f.get(k) not in (None, ""):
                f[k] = _date(f[k], k.replace("_", " "))
        if "evidence" in f:
            f["evidence"] = json.dumps(f["evidence"]) if f["evidence"] is not None else None
        if status == "open":
            f.update({k: None for k in ACTION_CLEARED_ON_OPEN})
        elif status == "done":
            f.setdefault("done_at", date.today().isoformat())
            f.setdefault("done_via", "manual")
        ts = now_iso()
        cols = ["owner", "id", "status", "first_seen", *f.keys(), "updated_at"]
        vals = [owner, aid, status, date.today().isoformat(), *f.values(), ts]
        sets = ", ".join(f"{k} = excluded.{k}" for k in ["status", *f.keys(), "updated_at"])
        self.db.execute(f"INSERT INTO action_log ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
                        f"ON CONFLICT(owner, id) DO UPDATE SET {sets}", vals)
        self.bump_actions()
        return self.action_row(owner, aid)

    def upsert_action_seen(self, owner: str, rows: list[dict]):
        """Record actions computed on read: first sighting (first_seen, tier_first, title...) and auto-done or
        expired transitions (A6).

        On conflict only the status and done fields (status, done_via, evidence, done_at) change; category, title,
        impact, impact_kind and due are written at first sight and afterwards only fill blanks (§8.4: the impact is
        the one first seen, which auto_done and follow_through rely on). first_seen and tier_first are never
        overwritten. The transition applies to computed states only: open, planned, expired, and a snooze that has
        lapsed (snooze_until < today). A live snooze, done and dismissed are the user's and are left alone.
        Idempotent, and no bump: the computed result already reflects the change."""
        today, ts = date.today().isoformat(), now_iso()
        stmts = []
        for r in rows or []:
            aid = r.get("id")
            if not aid:
                continue
            f = {k: r[k] for k in ACTION_SEEN_FIELDS if k in r}
            if "evidence" in f:
                f["evidence"] = json.dumps(f["evidence"]) if f["evidence"] is not None else None
            if f.get("status") is None:
                f.pop("status", None)
            elif f["status"] not in ACTION_STATUSES:
                raise ValidationError(f"Unknown action status '{f['status']}'")
            f.setdefault("first_seen", today)
            cols = ["owner", "id", *f.keys(), "updated_at"]
            upd = [k for k in f if k in ACTION_TRANSITION_FIELDS]
            sql = f"INSERT INTO action_log ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) ON CONFLICT(owner, id) "
            params = [owner, aid, *f.values(), ts]
            if upd:
                sets = [f"{k} = excluded.{k}" for k in [*upd, "updated_at"]]
                if "status" in upd:
                    sets.append("snooze_until = CASE WHEN excluded.status = 'snoozed' THEN snooze_until END")
                sql += ("DO UPDATE SET " + ", ".join(sets) + " WHERE action_log.status IN ('open','planned','expired')"
                        " OR (action_log.status = 'snoozed' AND COALESCE(action_log.snooze_until, '') < ?)")
                params.append(today)
            else:
                sql += "DO NOTHING"
            stmts.append((sql, params))
            # A row the user created before it was ever seen (a snooze or Skip posted from Home) has no tier_first,
            # category or title. Fill the blanks whatever its status; a value already there is never overwritten.
            fill = [k for k in ACTION_FILL_FIELDS if f.get(k) is not None]
            if fill:
                stmts.append((f"UPDATE action_log SET {', '.join(f'{k} = COALESCE({k}, ?)' for k in fill)} "
                              "WHERE owner = ? AND id = ?", [*(f[k] for k in fill), owner, aid]))
        if stmts:
            self.db.batch(stmts)

    def kpi_snapshot_write(self, owner: str, on: str, data: dict) -> bool:
        """Store the day's KPI snapshot once; a second write for the same (owner, date) is ignored."""
        res = self.db.execute("INSERT OR IGNORE INTO kpi_snapshots (owner, date, data, created_at) VALUES (?,?,?,?)",
                              (owner, _date(on), json.dumps(data, default=str), now_iso()))
        return res.rowcount > 0

    def kpi_snapshot_at(self, owner: str, on_or_before: str) -> dict | None:
        """The latest snapshot dated on or before `on_or_before`, as {date, data}, or None."""
        r = self.db.one("SELECT date, data FROM kpi_snapshots WHERE owner = ? AND date <= ? ORDER BY date DESC LIMIT 1",
                        (owner, _date(on_or_before)))
        if not r:
            return None
        try:
            return {"date": r["date"], "data": json.loads(r["data"])}
        except (TypeError, json.JSONDecodeError):
            return None

    def kpi_snapshots(self, owner: str, since: str | None = None, until: str | None = None) -> list[dict]:
        """Every KPI snapshot of `owner` dated within [since, until] (either end optional), ascending by date, as
        [{date, data}] with data decoded. Rows whose data is not a JSON object are skipped. No bump."""
        sql, params = "SELECT date, data FROM kpi_snapshots WHERE owner = ?", [owner]
        if since not in (None, ""):
            sql += " AND date >= ?"
            params.append(_date(since, "since"))
        if until not in (None, ""):
            sql += " AND date <= ?"
            params.append(_date(until, "until"))
        out = []
        for r in self.db.query(sql + " ORDER BY date", params):
            try:
                data = json.loads(r["data"])
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(data, dict):
                out.append({"date": r["date"], "data": data})
        return out

    def _mark(self, owner: str, ids, column: str, at: str | None) -> int:
        """Stamp `column` (seen_at or pushed_at) on each (owner, id) row where it is still NULL, inserting a missing
        row (K7). Returns how many rows were stamped. Bookkeeping only: no _bump, no bump_actions."""
        if not owner:
            raise ValidationError("owner is required")
        ids = [i for i in dict.fromkeys(ids or []) if isinstance(i, str) and i]
        if not ids:
            return 0
        at = at or now_iso()
        today, ts = date.today().isoformat(), now_iso()
        stmts = []
        for aid in ids:
            if column == "seen_at" and aid.startswith("notice:"):
                # A notice that is not an action: seen means done, and with no tier_first it never counts toward
                # follow-through (§8.5). A notice row a push created ('open') is closed the same way when seen.
                stmts.append(("INSERT INTO action_log (owner, id, status, first_seen, tier_first, done_via, seen_at, updated_at) "
                              "VALUES (?, ?, 'done', ?, NULL, 'seen', ?, ?) ON CONFLICT(owner, id) DO UPDATE SET "
                              "seen_at = excluded.seen_at, "
                              "done_via = CASE WHEN action_log.status = 'open' THEN 'seen' ELSE action_log.done_via END, "
                              "status = CASE WHEN action_log.status = 'open' THEN 'done' ELSE action_log.status END "
                              "WHERE action_log.seen_at IS NULL", (owner, aid, today, at, ts)))
            else:
                stmts.append((f"INSERT INTO action_log (owner, id, status, first_seen, {column}, updated_at) "
                              f"VALUES (?, ?, 'open', ?, ?, ?) ON CONFLICT(owner, id) DO UPDATE SET {column} = excluded.{column} "
                              f"WHERE action_log.{column} IS NULL", (owner, aid, today, at, ts)))
        return sum(max(r.rowcount or 0, 0) for r in self.db.batch(stmts))

    def mark_seen(self, owner: str, ids, at: str | None = None) -> int:
        """Record that `owner` has seen these action / notice rows (D15: "seen" lives only in action_log.seen_at).
        An existing row gets seen_at = at (default now) when it has none. A missing 'notice:<id>' row is inserted as
        status 'done', tier_first NULL, done_via 'seen'; any other missing id is inserted as status 'open'.
        Returns how many rows were stamped. Bumps neither the ledger version nor actions_rev."""
        return self._mark(owner, ids, "seen_at", at)

    def mark_pushed(self, owner: str, ids, at: str | None = None) -> int:
        """The same as mark_seen, on pushed_at: a missing id (notice or action) is inserted as status 'open'.
        Returns how many rows were stamped. Bumps neither the ledger version nor actions_rev."""
        return self._mark(owner, ids, "pushed_at", at)

    # ── prices ──
    def store_quotes(self, quotes: dict[str, dict | None]):
        stamp = now_iso()
        stmts = [("UPDATE instruments SET last_price = ?, prev_close = ?, last_price_at = ? WHERE symbol = ?",
                  (q["price"], q.get("prev_close"), stamp, sym)) for sym, q in quotes.items() if q]
        if stmts:
            self.db.batch(stmts)
            self._bump()
