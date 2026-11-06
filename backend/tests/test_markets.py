from datetime import date, timedelta

import pytest
from conftest import ADMIN, GUEST, USER, auth

from tracker import markets as mk
from tracker import prices as px


def series(start: float, daily: list[float]) -> list[tuple[str, float]]:
    """Daily closes ending yesterday, from a start price and day-on-day % moves."""
    out, p = [], start
    first = date.today() - timedelta(days=len(daily) + 1)
    out.append((first.isoformat(), p))
    for n, r in enumerate(daily, start=1):
        p *= 1 + r / 100
        out.append(((first + timedelta(days=n)).isoformat(), round(p, 4)))
    return out


def test_metrics_and_both_signal_lenses():
    rising = mk.metrics(series(100, [0.6] * 30))
    assert rising["m1"] == pytest.approx(13.4, abs=0.2) and rising["w1"] == pytest.approx(3.0, abs=0.1)
    assert mk.signals_for(rising) == ["momentum_buy"]
    falling = mk.metrics(series(100, [-0.7] * 30))
    assert mk.signals_for(falling) == ["momentum_sell"]
    bounce = mk.metrics(series(100, [-1.2] * 24 + [0.4] * 6))  # down hard for weeks, up this week
    assert mk.signals_for(bounce) == ["dip_buy"]
    cooling = mk.metrics(series(100, [1.4] * 24 + [-0.8] * 6))
    assert mk.signals_for(cooling) == ["profit_book"]
    flat = mk.metrics(series(100, [0.05] * 30))
    assert mk.signals_for(flat) == []
    # A quote for a new day adds a point; the last close repeated (market shut) does not shift the windows
    closes = series(100, [0.0] * 30)
    live = mk.metrics(closes, {"price": 106, "prev_close": 100, "date": date.today().isoformat()})
    assert live["price"] == 106 and live["d1"] == 6
    up = series(100, [0.6] * 30)
    shut = mk.metrics(up, {"price": up[-1][1], "prev_close": up[-2][1], "date": up[-1][0]})
    assert shut["w1"] == rising["w1"] and shut["m1"] == rising["m1"]
    assert mk.describe("dip_buy", bounce)["title"] == "Bouncing after a fall"


@pytest.fixture
def market(monkeypatch):
    """Offline prices: TCS climbs steadily, INFY bounces after a fall, ONGC jumps 7% today."""
    hist = {"TCS.NS": series(3000, [0.6] * 30), "INFY.NS": series(1500, [-1.2] * 24 + [0.4] * 6),
            "ONGC.NS": series(250, [0.0] * 30), "^NSEI": series(24000, [0.1] * 30)}
    quotes = {"ONGC.NS": {"price": 267.5, "prev_close": 250.0}, "TCS.NS": {"price": hist["TCS.NS"][-1][1], "prev_close": None},
              "INFY.NS": {"price": hist["INFY.NS"][-1][1], "prev_close": None}}
    monkeypatch.setattr(px, "ensure_history", lambda db, syms, start, max_age_hours=12: {s: hist.get(s, []) for s in syms})
    monkeypatch.setattr(px, "fetch_quotes", lambda syms, timeout=15: {s: quotes.get(s) for s in syms})
    monkeypatch.setattr(mk, "universe", lambda ledger, refresh=False: [
        {"symbol": "TCS", "name": "Tata Consultancy Services", "industry": "Information Technology", "isin": None},
        {"symbol": "INFY", "name": "Infosys", "industry": "Information Technology", "isin": None},
        {"symbol": "ONGC", "name": "ONGC", "industry": "Oil Gas & Consumable Fuels", "isin": None}])
    return hist


def test_markets_overview_watchlist_and_alert_job(client, market):
    h = auth(USER, "user")
    client.post("/api/transactions", headers=h, json={"type": "BUY", "date": "2026-01-05", "quantity": 10, "amount": 2400,
                                                       "instrument": {"asset_class": "equity", "name": "ONGC", "symbol": "ONGC.NS",
                                                                      "market": "India"}})
    w = client.post("/api/watchlist", headers=h, json={"symbol": "tcs", "target_buy": 99999})
    assert w.status_code == 201 and w.json["symbol"] == "TCS.NS" and w.json["added_price"] > 0
    assert client.post("/api/watchlist", headers=h, json={"symbol": "TCS"}).status_code == 400   # already there
    assert client.post("/api/watchlist", headers=auth(GUEST, "guest"), json={"symbol": "INFY"}).status_code == 403

    ov = client.get("/api/markets", headers=h).json
    assert ov["covered"] == 3 and ov["index"]["metrics"]["price"] > 0
    assert [i["symbol"] for i in ov["ideas"]["momentum_buy"]] == ["TCS.NS"] and ov["ideas"]["momentum_buy"][0]["watching"]
    assert [i["symbol"] for i in ov["ideas"]["dip_buy"]] == ["INFY.NS"]
    (ongc,) = ov["holdings"]
    assert ongc["metrics"]["d1"] == 7 and ongc["weight"] == 100
    (tcs,) = ov["watchlist"]
    assert tcs["target_hit"] == "buy" and tcs["industry"] == "Information Technology"
    assert ov["movers"]["day"]["up"][0]["symbol"] == "ONGC.NS" and ov["sectors"] == []  # sectors need 3+ stocks

    # The scheduled scan: token required, alerts stored once, nothing pushed while push isn't configured
    assert client.post("/api/jobs/market-scan?force=1").status_code == 403
    assert client.post("/api/jobs/market-scan?force=1", headers={"X-Job-Token": "wrong"}).status_code == 403
    job = {"X-Job-Token": "test-job-token"}
    run = client.post("/api/jobs/market-scan?force=1", headers=job).json
    assert next(r for r in run["owners"] if r["owner"] == USER) == {"owner": USER, "new_alerts": 2, "pushed": 0}
    again = client.post("/api/jobs/market-scan?force=1", headers=job).json
    assert next(r for r in again["owners"] if r["owner"] == USER)["new_alerts"] == 0
    titles = sorted(a["title"] for a in client.get("/api/markets/alerts", headers=h).json)
    assert titles == ["ONGC up 7.0% today", "TCS reached your buy price"]
    assert any(n["kind"] == "market" for n in client.get("/api/notifications", headers=h).json["items"])
    # Turning alerts off stops them; thresholds are validated
    assert client.put("/api/settings/marketAlerts", headers=h, json={"value": {"enabled": False}}).status_code == 200
    off = client.post("/api/jobs/market-scan?force=1", headers=job).json
    assert next(r for r in off["owners"] if r["owner"] == USER) == {"owner": USER, "skipped": "alerts off"}
    assert client.put("/api/settings/marketAlerts", headers=h, json={"value": {"day": 50}}).status_code == 400

    assert client.delete(f"/api/watchlist/{w.json['id']}", headers=auth("other@example.com", "user")).status_code == 404
    assert client.delete(f"/api/watchlist/{w.json['id']}", headers=h).status_code == 200


def test_ipo_tracker_and_reminders(client):
    h = auth(ADMIN, "admin")
    today = date.today()
    r = client.post("/api/ipos", headers=h, json={"name": "Acme Foods", "board": "Mainboard", "price_low": 95, "price_high": 100,
                                                   "lot_size": 150, "gmp": 12, "open_date": today.isoformat(),
                                                   "close_date": (today + timedelta(days=1)).isoformat()})
    assert r.status_code == 201, r.json
    ipo = r.json
    assert ipo["status"] == "open" and ipo["min_investment"] == 15000 and ipo["gmp_pct"] == 12
    bad = client.post("/api/ipos", headers=h, json={"name": "X", "open_date": "2026-05-10", "close_date": "2026-05-01"})
    assert bad.status_code == 400
    notes = [n for n in client.get("/api/notifications", headers=h).json["items"] if n["kind"] == "ipo"]
    assert {n["title"] for n in notes} == {"Acme Foods IPO opens today", "Acme Foods IPO closes tomorrow"}
    upd = client.put(f"/api/ipos/{ipo['id']}", headers=h, json={"applied": True, "lots_applied": 2, "listing_price": 118,
                                                                  "listing_date": today.isoformat()}).json
    assert upd["applied"] and upd["status"] == "listed" and upd["listing_gain_pct"] == 18
    assert [i["name"] for i in client.get("/api/ipos", headers=h).json] == ["Acme Foods"]
    assert client.get("/api/ipos", headers=auth(USER, "user")).json == []   # each person sees their own
    assert client.delete(f"/api/ipos/{ipo['id']}", headers=h).status_code == 200


def test_push_config_without_keys(client):
    h = auth(USER, "user")
    assert client.get("/api/push/config", headers=h).json == {"available": False, "public_key": None, "devices": 0}
    assert client.post("/api/push/subscribe", headers=h, json={"subscription": {}}).status_code == 400
