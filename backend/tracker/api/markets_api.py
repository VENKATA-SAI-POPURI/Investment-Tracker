"""Markets: overview with price signals, watchlist, IPO tracker, push subscriptions and the scheduled scan."""
from __future__ import annotations

import hmac
import os
from datetime import date, datetime, timedelta, timezone

from flask import Blueprint, current_app, g, jsonify, request

from .. import markets as mk
from .. import prices as px
from .. import push
from ..ledger import NotFound, ValidationError
from ..migrations import now_iso
from ..security import write_required

bp = Blueprint("markets_api", __name__)
IST = timezone(timedelta(hours=5, minutes=30))


def L():
    return current_app.extensions["ledger"]


def S():
    return current_app.extensions["services"]


def body() -> dict:
    return request.get_json(silent=True) or {}


def _where() -> tuple[str, list]:
    return ("owner = ?", [g.scope]) if g.scope else ("1=1", [])


def _num(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        raise ValidationError(f"{v!r} is not a number")


# ── overview ──

def _watchlist(scope):
    w, p = ("owner = ?", [scope]) if scope else ("1=1", [])
    return L().db.query(f"SELECT * FROM watchlist WHERE {w} ORDER BY name", p)


@bp.get("/markets")
def overview():
    settings = S().settings()
    def build():
        port, _ = S().portfolio(g.scope, settings)
        return mk.build_overview(L(), port, _watchlist(g.scope), settings, settings.get("targetAllocation"))
    return jsonify(L()._cached(("markets", g.scope, repr(sorted((settings.get("marketAlerts") or {}).items()))), build))


# ── watchlist ──

def _watch_fields(data: dict) -> dict:
    out = {}
    for k in ("target_buy", "target_sell"):
        if k in data:
            out[k] = _num(data[k])
            if out[k] is not None and out[k] <= 0:
                raise ValidationError(f"{k.replace('_', ' ')} must be above zero")
    if "notes" in data:
        out["notes"] = (data.get("notes") or "").strip()[:500] or None
    if "name" in data and (data.get("name") or "").strip():
        out["name"] = data["name"].strip()[:120]
    return out


@bp.post("/watchlist")
@write_required
def add_watch():
    data = body()
    sym = (data.get("symbol") or "").strip().upper()
    if not sym:
        raise ValidationError("symbol is required")
    if "." not in sym and not sym.startswith("^"):
        sym = mk.yahoo_symbol(sym)  # NSE symbols as typed, e.g. TCS
    if L().db.one("SELECT 1 AS x FROM watchlist WHERE owner = ? AND symbol = ?", (g.owner, sym)):
        raise ValidationError(f"{sym} is already on your watchlist")
    quote = px.fetch_quotes([sym]).get(sym)
    if not quote:
        raise ValidationError(f"No price found for {sym}; check the symbol (NSE symbols end in .NS, BSE in .BO)")
    f = _watch_fields(data)
    ts = now_iso()
    L().db.execute("INSERT INTO watchlist (owner, symbol, name, target_buy, target_sell, added_price, notes, created_at, updated_at) "
                   "VALUES (?,?,?,?,?,?,?,?,?)", (g.owner, sym, f.get("name") or sym.split(".")[0], f.get("target_buy"),
                                                    f.get("target_sell"), quote["price"], f.get("notes"), ts, ts))
    L()._bump()
    return jsonify(L().db.one("SELECT * FROM watchlist WHERE owner = ? AND symbol = ?", (g.owner, sym))), 201


def _own_watch(wid: int) -> dict:
    w, p = _where()
    row = L().db.one(f"SELECT * FROM watchlist WHERE id = ? AND {w}", [wid, *p])
    if not row:
        raise NotFound("Watchlist entry not found")
    return row


@bp.put("/watchlist/<int:wid>")
@write_required
def update_watch(wid):
    _own_watch(wid)
    f = _watch_fields(body())
    if f:
        L().db.execute(f"UPDATE watchlist SET {', '.join(f'{k} = ?' for k in f)}, updated_at = ? WHERE id = ?",
                       [*f.values(), now_iso(), wid])
        L()._bump()
    return jsonify(_own_watch(wid))


@bp.delete("/watchlist/<int:wid>")
@write_required
def delete_watch(wid):
    _own_watch(wid)
    L().db.execute("DELETE FROM watchlist WHERE id = ?", (wid,))
    L()._bump()
    return jsonify({"message": "Removed"})


# ── IPO tracker ──

IPO_TEXT = ("name", "symbol", "board", "subscription", "notes")
IPO_DATES = ("open_date", "close_date", "allotment_date", "listing_date")
IPO_NUMS = ("price_low", "price_high", "issue_size_cr", "gmp", "listing_price")
IPO_INTS = ("lot_size", "lots_applied", "lots_allotted")


def ipo_status(r: dict, today: str | None = None) -> str:
    today = today or date.today().isoformat()
    if r.get("listing_date") and r["listing_date"] <= today:
        return "listed"
    if r.get("close_date") and r["close_date"] < today:
        return "closed"
    if r.get("open_date") and r["open_date"] <= today:
        return "open"
    return "upcoming"


def _ipo_fields(data: dict) -> dict:
    out = {}
    for k in IPO_TEXT:
        if k in data:
            out[k] = (str(data[k]).strip()[:500] if data[k] not in (None, "") else None)
    for k in IPO_DATES:
        if k in data:
            v = data[k] or None
            if v:
                try:
                    v = date.fromisoformat(str(v)[:10]).isoformat()
                except ValueError:
                    raise ValidationError(f"{k.replace('_', ' ')} must be a date")
            out[k] = v
    for k in IPO_NUMS:
        if k in data:
            out[k] = _num(data[k])
    for k in IPO_INTS:
        if k in data:
            n = _num(data[k])
            out[k] = int(n) if n is not None else None
    if "applied" in data:
        out["applied"] = 1 if data["applied"] else 0
    if out.get("open_date") and out.get("close_date") and out["close_date"] < out["open_date"]:
        raise ValidationError("close date is before the open date")
    return out


def _ipo_out(r: dict) -> dict:
    hi = r.get("price_high") or r.get("price_low")
    out = {**r, "applied": bool(r["applied"]), "status": ipo_status(r),
           "min_investment": round(hi * r["lot_size"], 2) if hi and r.get("lot_size") else None}
    if r.get("gmp") and hi:
        out["gmp_pct"] = round(r["gmp"] / hi * 100, 1)
    if r.get("listing_price") and hi:
        out["listing_gain_pct"] = round((r["listing_price"] / hi - 1) * 100, 1)
    return out


@bp.get("/ipos")
def list_ipos():
    w, p = _where()
    rows = L().db.query(f"SELECT * FROM ipos WHERE {w} ORDER BY COALESCE(open_date, '9999') DESC", p)
    return jsonify([_ipo_out(r) for r in rows])


@bp.post("/ipos")
@write_required
def add_ipo():
    f = _ipo_fields(body())
    if not f.get("name"):
        raise ValidationError("name is required")
    ts = now_iso()
    cols = ["owner", *f.keys(), "created_at", "updated_at"]
    res = L().db.execute(f"INSERT INTO ipos ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", [g.owner, *f.values(), ts, ts])
    return jsonify(_ipo_out(L().db.one("SELECT * FROM ipos WHERE id = ?", (res.lastrowid,)))), 201


def _own_ipo(iid: int) -> dict:
    w, p = _where()
    row = L().db.one(f"SELECT * FROM ipos WHERE id = ? AND {w}", [iid, *p])
    if not row:
        raise NotFound("IPO not found")
    return row


@bp.put("/ipos/<int:iid>")
@write_required
def update_ipo(iid):
    _own_ipo(iid)
    f = _ipo_fields(body())
    if "name" in f and not f["name"]:
        raise ValidationError("name cannot be empty")
    if f:
        L().db.execute(f"UPDATE ipos SET {', '.join(f'{k} = ?' for k in f)}, updated_at = ? WHERE id = ?", [*f.values(), now_iso(), iid])
    return jsonify(_ipo_out(_own_ipo(iid)))


@bp.delete("/ipos/<int:iid>")
@write_required
def delete_ipo(iid):
    _own_ipo(iid)
    L().db.execute("DELETE FROM ipos WHERE id = ?", (iid,))
    return jsonify({"message": "Deleted"})


# ── alerts and push ──

@bp.get("/markets/alerts")
def recent_alerts():
    w, p = _where()
    since = (datetime.now(timezone.utc) - timedelta(days=14)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return jsonify(L().db.query(f"SELECT * FROM market_alerts WHERE {w} AND created_at >= ? ORDER BY created_at DESC LIMIT 50",
                                [*p, since]))


@bp.get("/push/config")
def push_config():
    return jsonify({"available": push.enabled(), "public_key": push.public_key(), "devices": push.devices(L().db, g.email)})


@bp.post("/push/subscribe")
def push_subscribe():
    if not push.enabled():
        raise ValidationError("Push notifications aren't set up on the server yet")
    try:
        push.subscribe(L().db, g.email, body().get("subscription") or {}, request.headers.get("User-Agent"))
    except ValueError as e:
        raise ValidationError(str(e))
    return jsonify({"devices": push.devices(L().db, g.email)})


@bp.post("/push/unsubscribe")
def push_unsubscribe():
    push.unsubscribe(L().db, g.email, body().get("endpoint"), everywhere=bool(body().get("all")))
    return jsonify({"devices": push.devices(L().db, g.email)})


@bp.post("/push/test")
def push_test():
    n = push.send(L().db, g.email, {"title": "Alerts are on", "body": "You'll hear about big moves in your holdings here.",
                                    "url": "/markets", "tag": "test"})
    if not n:
        raise ValidationError("No device received it; turn alerts on again on this device")
    return jsonify({"sent": n})


# ── scheduled scan (called by the GitHub Actions workflow, not by people) ──

def market_open(now: datetime | None = None) -> bool:
    t = (now or datetime.now(IST)).astimezone(IST)
    return t.weekday() < 5 and (9, 0) <= (t.hour, t.minute) <= (16, 0)


def scan_owner(owner: str, role: str) -> dict:
    """Alerts for one person's holdings and watchlist; stores new ones and pushes them if enabled."""
    settings = L().get_settings(owner, role)
    cfg = {**mk.DEFAULT_ALERTS, **(settings.get("marketAlerts") or {})}
    if not cfg["enabled"]:
        return {"owner": owner, "skipped": "alerts off"}
    port, _ = S().portfolio(owner, settings)
    holds = mk.tracked_holdings(port)
    watch = _watchlist(owner)
    syms = sorted({p["symbol"] for p in holds} | {w["symbol"] for w in watch})
    data = mk.load_market(L(), syms, syms) if syms else {}
    holdings = [{"id": p["id"], "name": p["name"], "symbol": p["symbol"], "metrics": data.get(p["symbol"])} for p in holds]
    watched = []
    for w in watch:
        m = data.get(w["symbol"])
        hit = None
        if m and w.get("target_buy") and m["price"] <= w["target_buy"]:
            hit = "buy"
        elif m and w.get("target_sell") and m["price"] >= w["target_sell"]:
            hit = "sell"
        watched.append({**w, "metrics": m, "target_hit": hit})
    fresh = []
    for a in mk.holding_alerts(holdings, watched, cfg, datetime.now(IST).date().isoformat()):
        res = L().db.execute("INSERT OR IGNORE INTO market_alerts (owner, key, kind, symbol, title, body, severity, link, created_at) "
                             "VALUES (?,?,?,?,?,?,?,?,?)", (owner, a["key"], a["kind"], a["symbol"], a["title"], a["body"],
                                                            a["severity"], a["link"], now_iso()))
        if res.rowcount:
            fresh.append(a)
    pushed = 0
    if fresh and cfg["push"]:
        if len(fresh) == 1:
            payload = {"title": fresh[0]["title"], "body": fresh[0]["body"], "url": fresh[0]["link"], "tag": fresh[0]["key"]}
        else:
            payload = {"title": f"{len(fresh)} price alerts", "body": " · ".join(a["title"] for a in fresh[:3]),
                       "url": "/markets", "tag": "alerts"}
        pushed = push.send(L().db, owner, payload)
        if pushed:
            L().db.execute(f"UPDATE market_alerts SET pushed = 1 WHERE owner = ? AND key IN ({','.join('?' * len(fresh))})",
                           [owner, *[a["key"] for a in fresh]])
    return {"owner": owner, "new_alerts": len(fresh), "pushed": pushed}


@bp.post("/jobs/market-scan")
def market_scan():
    token = os.environ.get("JOB_TOKEN") or ""
    given = request.headers.get("X-Job-Token") or ""
    if not token or not hmac.compare_digest(token, given):
        return jsonify({"error": "Not allowed"}), 403
    if not market_open() and not request.args.get("force"):
        return jsonify({"skipped": "market closed"})
    S().refresh_prices(None, force=True)  # keeps every holding's price current as well
    uni = mk.universe(L())
    mk.load_market(L(), [mk.yahoo_symbol(u["symbol"]) for u in uni])  # warms the Ideas page
    directory = current_app.extensions["directory"]
    owners = {r["owner"] for r in L().db.query("SELECT DISTINCT owner FROM instruments UNION SELECT DISTINCT owner FROM watchlist")}
    results = [scan_owner(o, directory.role(o) or "user") for o in sorted(owners)]
    return jsonify({"at": now_iso(), "owners": results})
