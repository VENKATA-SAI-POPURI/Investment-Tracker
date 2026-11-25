from datetime import date, timedelta

import pytest
from conftest import ADMIN, GUEST, USER, auth

from tracker import markets as mk
from tracker import prices as px
from tracker.analytics import quant
from tracker.analytics import signals as sg


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
    monkeypatch.setattr(px, "history_fast", lambda db, syms, start, max_age_hours=12, on_refreshed=None: {s: hist.get(s, []) for s in syms})
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
    assert ov["ideas"]["dip_buy"][0]["label"] == sg.SIGNAL_LABEL          # K16: every described signal says so
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


# ── market_state and context_line (SPEC P1.12, AMENDMENTS G12): synthetic closes and stress dicts only ──

END = date(2026, 11, 13)


def nifty(prices: list[float], end: date = END) -> list[tuple[str, float]]:
    """One close a day, the last one on `end`."""
    first = end - timedelta(days=len(prices) - 1)
    return [((first + timedelta(days=i)).isoformat(), p) for i, p in enumerate(prices)]


def state(prices, perf=None, stress=None):
    return mk.market_state(nifty(prices), perf, stress, END)


def flat(n=290, at=100.0):
    return [at] * n


STRESS = {"scenarios": [
    {"key": "correction", "label": "Market correction", "impact": -65000, "impact_pct": -6.5},
    {"key": "covid", "label": "2020 Covid crash", "impact": -250000, "impact_pct": -25.0},
    {"key": "gfc", "label": "2008 financial crisis", "impact": -350000, "impact_pct": -35.0},
    {"key": "rates", "label": "Rate shock", "impact": -90000, "impact_pct": -9.0},
    {"key": "rupee", "label": "Rupee falls 10%", "impact": 12000, "impact_pct": 1.2},
    {"key": "gold", "label": "Gold slides 20%", "impact": -4000, "impact_pct": -0.4},
    {"key": "p2p", "label": "P2P defaults double", "impact": 0, "impact_pct": 0.0},
]}


def test_market_state_needs_200_closes_and_reads_only_what_it_is_given(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("market_state must not fetch prices")
    monkeypatch.setattr(px, "ensure_history", boom)
    monkeypatch.setattr(px, "fetch_quotes", boom)
    assert mk.market_state([], None, None, END) is None
    assert mk.market_state(None, None, None, END) is None
    assert state(flat(199)) is None
    s = state(flat(200))
    assert s["mode"] == "normal" and s["nifty"] == {"price": 100.0, "d1": 0.0, "w1": 0.0, "from_high_pct": 0.0,
                                                     "high": 100.0, "high_date": END.isoformat()}
    # Closes after `today` don't count, and unusable points are dropped before the count
    future = nifty(flat(199)) + [((END + timedelta(days=1)).isoformat(), 100.0)]
    assert mk.market_state(future, None, None, END) is None
    junk = nifty(flat(199)) + [("2020-01-01", 0), ("2020-01-02", None), ("bad",)]
    assert mk.market_state(junk, None, None, END) is None
    # {date, close} dicts in any order are accepted, and `today` may be a string
    dicts = [{"date": d_, "close": c} for d_, c in reversed(nifty(flat(250) + [90.0]))]
    assert mk.market_state(dicts, None, None, END.isoformat())["nifty"]["from_high_pct"] == -10.0


def test_market_state_thresholds_and_their_order():
    tail = [95.0] * 10 + [91.0, 90.5, 90.2, 90.1, 90.05]
    # Correction at exactly −10% from the high; one basis point less is normal (d1 and w1 stay small)
    s = state(flat() + tail + [90.0])
    assert s["mode"] == "correction" and s["nifty"]["from_high_pct"] == -10.0
    assert s["nifty"]["w1"] == pytest.approx(-1.1, abs=0.01) and abs(s["nifty"]["d1"]) < 0.1
    assert state(flat() + tail + [90.01])["mode"] == "normal"
    # Crash at −20% from the high
    assert state(flat() + [82.0] * 10 + [80.5, 80.4, 80.3, 80.2, 80.1, 80.0])["mode"] == "crash"
    assert state(flat() + [82.0] * 10 + [80.5, 80.4, 80.3, 80.2, 80.1, 80.01])["mode"] == "correction"
    # Crash on a −8% week alone, while only 8% below the high
    week = [100.0, 99.0, 97.0, 95.0, 93.0]
    s = state(flat() + week + [92.0])
    assert s["mode"] == "crash" and s["nifty"]["w1"] == -8.0 and s["nifty"]["from_high_pct"] == -8.0
    assert state(flat() + week + [92.01])["mode"] == "normal"
    # Volatile at |d1| ≥ 2.5 either way
    assert state(flat() + [102.5])["mode"] == "volatile"
    assert state(flat() + [97.5])["mode"] == "volatile"
    assert state(flat() + [102.49])["mode"] == "normal"
    # Order: a crash or a correction outranks a big day
    big_day = state(flat() + [93.0] * 5 + [90.0])
    assert big_day["nifty"]["d1"] <= -2.5 and big_day["mode"] == "correction"
    assert state(flat() + [85.0] * 5 + [75.0])["mode"] == "crash"
    # The high is the highest of the last 252 closes: an older peak is forgotten
    assert state([200.0] * 48 + flat(252))["mode"] == "normal"
    assert state([200.0] * 10 + flat(251))["nifty"]["from_high_pct"] == -50.0     # 252 closes back still counts


def test_market_state_since_as_of_and_playbook():
    prices = flat(250) + [110.0] + [99.0] * 49
    high_day = (END - timedelta(days=49)).isoformat()
    s = state(prices)
    assert s["mode"] == "correction" and s["since"] == high_day == s["nifty"]["high_date"]
    assert s["as_of"] == END.isoformat() and s["playbook"] == mk.PLAYBOOK and len(s["playbook"]) >= 3
    s["playbook"].append("x")
    assert "x" not in mk.PLAYBOOK          # each state gets its own copy
    calm = state(flat(250) + [110.0] + [108.0] * 49)
    assert calm["mode"] == "normal" and calm["since"] == END.isoformat() == calm["as_of"] and calm["playbook"] == []
    assert state(flat() + [102.5])["playbook"] == []           # volatile is not a fall


def test_market_state_you_and_comparable():
    down = flat() + [90.0]                                    # a correction, so `you` matters
    s = state(down, {"current_drawdown": -12.5, "end_value": 700000})
    assert s["you"] == {"from_peak_pct": -12.5, "from_peak_inr": -100000.0}
    # The mildest falling scenario at or beyond your drawdown
    pick = lambda dd: state(down, {"current_drawdown": dd, "end_value": 1e6}, STRESS)["comparable"]  # noqa: E731
    assert pick(-8.0) == {"key": "rates", "label": "Rate shock", "impact": -90000, "impact_pct": -9.0, "smaller": True}
    assert pick(-3.0)["key"] == "correction" and pick(-3.0)["smaller"]
    assert pick(-9.0)["key"] == "rates" and pick(-9.0)["smaller"] is False    # equal is not smaller
    assert pick(-0.2)["key"] == "gold"
    assert pick(0.0)["key"] == "gold"                       # zero- and positive-impact scenarios never count
    # Nothing deep enough: the correction scenario, and your fall is not smaller
    assert pick(-40.0) == {"key": "correction", "label": "Market correction", "impact": -65000, "impact_pct": -6.5,
                           "smaller": False}
    # No stress test: a stand-in correction measured against its nominal −10%
    none = state(down, {"current_drawdown": -8.0, "end_value": 1e6}, None)["comparable"]
    assert none == {"key": "correction", "label": "Market correction", "impact": None, "impact_pct": None, "smaller": True}
    assert state(down, {"current_drawdown": -12.0, "end_value": 1e6}, None)["comparable"]["smaller"] is False
    # A stress test without a correction row falls back to the same stand-in
    only_gold = {"scenarios": [{"key": "gold", "label": "Gold slides 20%", "impact": -4000, "impact_pct": -0.4}]}
    assert state(down, {"current_drawdown": -5.0, "end_value": 1e6}, only_gold)["comparable"]["label"] == "Market correction"
    # Without metrics `you` is unknown and there is nothing to compare
    for perf in (None, {}, {"current_drawdown": None, "end_value": 1e6}):
        s = state(down, perf, STRESS)
        assert s["you"] == {"from_peak_pct": None, "from_peak_inr": None} and s["comparable"] is None
    # A drawdown without an end value still compares, but has no rupee figure
    s = state(down, {"current_drawdown": -5.0}, STRESS)
    assert s["you"]["from_peak_inr"] is None and s["comparable"]["key"] == "correction"
    assert state(down, {"current_drawdown": 0.0, "end_value": 5e5})["you"]["from_peak_inr"] == 0.0


def test_context_line_text():
    twelve = flat() + [89.0] * 5 + [88.0]                    # 12% below the high, a quiet week
    # SPEC §4.1's own sentence: ₹3.4 L down, 8% from peak, no stress test → the routine correction
    s = state(twelve, {"current_drawdown": -8.0, "end_value": 3910000})
    assert s["mode"] == "correction" and s["you"]["from_peak_inr"] == pytest.approx(-340000)
    assert mk.context_line(s) == {
        "kind": "market", "link": "/markets",
        "text": "Nifty is 12% below its high. You're down ₹3.4 L from your peak — smaller than the routine-correction "
                "scenario. Your SIPs are the plan; nothing needs selling."}
    # A named scenario, a deeper fall, about-equal, unknown you, and a portfolio still at its peak
    covid = mk.context_line(state(twelve, {"current_drawdown": -12.5, "end_value": 2380000}, STRESS))["text"]
    assert "down ₹3.4 L from your peak — smaller than the 2020 Covid crash scenario." in covid
    deeper = mk.context_line(state(twelve, {"current_drawdown": -40.0, "end_value": 1.8e7}, STRESS))["text"]
    assert "You're down ₹1.20 Cr from your peak — deeper than the routine-correction scenario." in deeper
    equal = mk.context_line(state(twelve, {"current_drawdown": -9.0, "end_value": 910000}, STRESS))["text"]
    assert "You're down ₹90,000 from your peak — about the size of the Rate shock scenario." in equal
    assert mk.context_line(state(twelve)) == {
        "kind": "market", "link": "/markets",
        "text": "Nifty is 12% below its high. Your SIPs are the plan; nothing needs selling."}
    peak = mk.context_line(state(twelve, {"current_drawdown": 0.0, "end_value": 1e6}, STRESS))["text"]
    assert peak == "Nifty is 12% below its high. Your portfolio is at its peak. Your SIPs are the plan; nothing needs selling."
    no_rupees = mk.context_line(state(twelve, {"current_drawdown": -6.0}, STRESS))["text"]
    assert "You're 6% below your peak." in no_rupees
    # A crash set off by one bad week says so
    wk = mk.context_line(state(flat() + [100.0, 99.0, 97.0, 95.0, 93.0, 91.0]))["text"]
    assert wk.startswith("Nifty is 9% below its high, after a 9% fall this week.")
    # Only in a correction or a crash
    assert mk.context_line(state(flat() + [102.5])) is None
    assert mk.context_line(state(flat(200))) is None
    assert mk.context_line(None) is None


def test_stored_history_reads_price_history_only(app, monkeypatch):
    """D6/H4: stored_history is a read of price_history: no network, no price_meta row, oldest first, from `start`."""
    db = app.extensions["ledger"].db
    monkeypatch.setattr(px, "_yahoo_history", lambda *a, **k: pytest.fail("stored_history must not fetch"))
    monkeypatch.setattr(px, "fetch_quotes", lambda *a, **k: pytest.fail("stored_history must not fetch"))
    rows = nifty([100.0 + i for i in range(10)])
    for dt, c in reversed(rows):
        db.execute("INSERT INTO price_history (symbol, date, close) VALUES (?,?,?)", ("^NSEI", dt, c))
    db.execute("INSERT INTO price_history (symbol, date, close) VALUES (?,?,?)", ("^GSPC", rows[-1][0], 5000.0))
    got = px.stored_history(db, "^NSEI", date.fromisoformat(rows[3][0]))
    assert got == rows[3:]
    assert px.stored_history(db, "^NSEI", END + timedelta(days=1)) == []
    assert px.stored_history(db, "NOPE", date(2000, 1, 1)) == [] and px.stored_history(db, "", date(2000, 1, 1)) == []
    assert db.query("SELECT * FROM price_meta") == []
    # what services feeds market_state: under 200 stored closes there is no state (D6)
    assert mk.market_state(got, None, None, END) is None


def test_markets_overview_adds_market_state_outside_its_cache(client, app, market):
    h = auth(USER, "user")
    first = client.get("/api/markets", headers=h).json
    assert "market_state" in first and first["market_state"] is None   # nothing stored for ^NSEI
    db = app.extensions["ledger"].db
    for dt, c in nifty([100.0] * 260, end=date.today() - timedelta(days=1)):
        db.execute("INSERT INTO price_history (symbol, date, close) VALUES (?,?,?)", ("^NSEI", dt, c))
    app.extensions["ledger"]._bump()
    again = client.get("/api/markets", headers=h).json
    assert again["market_state"]["mode"] == "normal" and again["market_state"]["nifty"]["price"] == 100.0
    cached = [v for k, v in app.extensions["ledger"]._cache.items() if k[0] == "markets"]
    assert cached and all("market_state" not in v[2] for v in cached)   # the overview's cache entry is not mutated


def test_inr_compact():
    assert mk._inr_compact(45000) == "₹45,000"
    assert mk._inr_compact(99999.4) == "₹99,999"
    assert mk._inr_compact(340000) == "₹3.4 L"
    assert mk._inr_compact(12345678) == "₹1.23 Cr"
    assert mk._inr_compact(-250) == "-₹250"


# ── one signal vocabulary (SPEC P2.12, AMENDMENTS K16): analytics/signals.py, Markets and the outlook ──

# StockCharts' published RSI worksheet ("Relative Strength Index (RSI)", ChartSchool): 33 closes, 14-day RSI
STOCKCHARTS_CLOSES = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826,
                      45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439,
                      46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672,
                      43.4205, 42.6628, 43.1314]
STOCKCHARTS_RSI = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99,
                   41.46, 41.87, 45.46, 37.30, 33.08, 37.77]


def plain_wilder(closes, n=14):
    """A second, deliberately plain Wilder RSI: every value of the series, None until n changes exist."""
    out = [None] * len(closes)
    up = down = 0.0
    for i in range(1, len(closes)):
        move = closes[i] - closes[i - 1]
        g, l_ = (move, 0.0) if move > 0 else (0.0, -move)
        if i <= n:
            up += g / n
            down += l_ / n
        else:
            up = (up * (n - 1) + g) / n
            down = (down * (n - 1) + l_) / n
        if i >= n:
            out[i] = 100.0 if down == 0 else 100 - 100 / (1 + up / down)
    return out


def test_wilder_rsi_matches_the_stockcharts_example_and_a_plain_implementation():
    got = [sg.rsi(STOCKCHARTS_CLOSES[:k]) for k in range(15, len(STOCKCHARTS_CLOSES) + 1)]
    assert got == pytest.approx(STOCKCHARTS_RSI, abs=0.05)
    assert round(got[0], 2) == 70.53 and round(got[1], 2) == 66.32
    plain = plain_wilder(STOCKCHARTS_CLOSES)
    assert got == pytest.approx(plain[14:], abs=1e-9)
    # A longer synthetic series: the smoothing runs over every close, not only the last 14 changes
    walk = [c for _, c in series(100, [((i * 37) % 11 - 5) * 0.4 for i in range(300)])]
    assert sg.rsi(walk) == pytest.approx(plain_wilder(walk)[-1], abs=1e-9)
    assert sg.rsi(walk, 9) == pytest.approx(plain_wilder(walk, 9)[-1], abs=1e-9)
    # Edges: n closes (n − 1 changes) is too few; no losses reads 100; quant's RSI is this one
    assert sg.rsi(STOCKCHARTS_CLOSES[:14]) is None and sg.rsi([]) is None and sg.rsi([5.0]) is None
    assert sg.rsi([float(i) for i in range(1, 30)]) == 100.0
    assert sg.rsi([10.0] * 20) == 100.0          # flat: no average loss
    assert sg.rsi([float(30 - i) for i in range(30)]) == 0.0
    assert quant.rsi is sg.rsi


def test_describe_carries_the_label_and_the_vocabulary_is_unchanged():
    m = {"w1": 2.0, "m1": -14.5}
    d_ = sg.describe("dip_buy", m)
    assert d_ == {"signal": "dip_buy", "title": "Bouncing after a fall", "note": "Down 14.5% this month, +2.0% this week",
                  "label": "price pattern, not a forecast"}
    # R12: the month figure is unsigned after Up/Down; the week figure keeps its sign
    assert sg.describe("momentum_sell", {"w1": -4.0, "m1": -9.4})["note"] == "Down 9.4% this month and -4.0% this week"
    assert sg.describe("momentum_buy", {"w1": 3.5, "m1": 8.0})["note"] == "Up 8.0% this month and +3.5% this week"
    assert sg.describe("profit_book", {"w1": -2.5, "m1": 16.0})["note"] == "Up 16.0% this month, -2.5% this week"
    assert sg.SIGNAL_LABEL == "price pattern, not a forecast"
    assert {k: v[0] for k, v in sg.SIGNAL_TEXT.items()} == {
        "momentum_buy": "Rising strongly", "momentum_sell": "Falling steadily",
        "dip_buy": "Bouncing after a fall", "profit_book": "Cooling after a run"}
    # markets re-exports the one model rather than keeping a copy
    assert mk.RULES is sg.RULES and mk.SIGNAL_TEXT is sg.SIGNAL_TEXT
    assert mk.signals_for is sg.signals_for and mk.describe is sg.describe
    assert (mk.WEEK, mk.MONTH) == (sg.WEEK, sg.MONTH) == (5, 21)


def test_windows_is_the_markets_rule():
    for daily in ([0.6] * 30, [-1.2] * 24 + [0.4] * 6, [0.3] * 4, [0.1] * 21):
        pts = series(100, daily)
        m = mk.metrics(pts)
        assert sg.windows([c for _, c in pts]) == {"w1": m["w1"], "m1": m["m1"]}
    assert sg.windows([100.0]) == {"w1": None, "m1": None} and sg.windows([]) == {"w1": None, "m1": None}


RALLY_THEN_FALL = [2.0] * 230 + [-0.7] * 21     # the averages say up; the past month is falling steadily
FALL_THEN_RALLY = [-2.0] * 230 + [0.8] * 21     # the averages say down; the past month is rising strongly


def _markets_signals(pts):
    m = mk.metrics(pts)
    return [mk.describe(s, m) for s in mk.signals_for(m)]


def test_holding_outlook_and_markets_read_the_same_signals():
    pts = series(100, RALLY_THEN_FALL)
    o = quant.holding_outlook(pts)
    assert o["signals"] == _markets_signals(pts) != []
    assert [s["signal"] for s in o["signals"]] == ["momentum_sell"]
    # and on every other pattern the two agree too (no live quote: the outlook never sees today's tick)
    for daily in (FALL_THEN_RALLY, [0.6] * 250, [-1.2] * 240 + [0.4] * 6, [1.4] * 240 + [-0.8] * 6, [0.05] * 250):
        pts = series(100, daily)
        assert quant.holding_outlook(pts)["signals"] == _markets_signals(pts)
    read = sg.read([c for _, c in pts])
    assert set(read) == {"w1", "m1", "signals", "trend", "rsi"}


def test_the_trend_is_never_up_while_momentum_sell_fires():
    vals = [c for _, c in series(100, RALLY_THEN_FALL)]
    assert sg.trend(vals, [])["key"] == "up"                       # the averages alone would say up
    t = sg.trend(vals, ["momentum_sell"])
    assert t["key"] == "mixed" and t["label"] == "No clear trend" and t["reconciled"] is True
    o = quant.holding_outlook(series(100, RALLY_THEN_FALL))
    assert o["trend"]["key"] != "up" and o["trend"]["reconciled"] is True and o["trend"]["above_50"]
    assert o["notes"][0] == "Above its long averages but falling over the past month: no clear trend."
    assert not any("the trend is up" in n for n in o["notes"])
    # The mirror: down while rising strongly
    o = quant.holding_outlook(series(100, FALL_THEN_RALLY))
    assert [s["signal"] for s in o["signals"]] == ["momentum_buy"]
    assert o["trend"] == {**o["trend"], "key": "mixed", "label": "No clear trend", "reconciled": True}
    assert o["notes"][0] == "Below its long averages but rising over the past month: no clear trend."
    # Agreeing reads are left alone and say so
    up = quant.holding_outlook(series(100, [0.6] * 250))
    assert up["trend"]["key"] == "up" and up["trend"]["reconciled"] is False
    assert up["notes"][0] == "Trading above its 50- and 200-day averages: the trend is up."
    # Described signals are accepted as well as keys; other signals never reconcile
    assert sg.trend(vals, [sg.describe("momentum_sell", {"w1": -3.5, "m1": -13.7})])["key"] == "mixed"
    assert sg.trend(vals, ["profit_book", "dip_buy"]) == {**sg.trend(vals, []), "reconciled": False}
    # Under 50 closes the rule has no average: mixed, nothing to reconcile
    assert sg.trend(vals[:40], ["momentum_sell"])["key"] == "mixed" and not sg.trend(vals[:40], ["momentum_sell"])["reconciled"]
    # Never up with momentum_sell across a sweep of month/week shapes
    for rise in (0.5, 1.0, 2.0, 3.0):
        for fall in (-0.4, -0.7, -1.0, -2.0):
            o = quant.holding_outlook(series(100, [rise] * 230 + [fall] * 21))
            if any(s["signal"] == "momentum_sell" for s in o["signals"]):
                assert o["trend"]["key"] != "up"


def test_the_outlook_keeps_its_cone_and_honest_labels():
    o = quant.holding_outlook(series(100, RALLY_THEN_FALL))
    assert o["assumptions"]["cone_label"] == quant.HONESTY["cone"]          # H16, unchanged
    assert set(o["trend"]) == {"key", "label", "reconciled", "sma50", "sma200", "above_50", "above_200"}
    assert o["rsi"] == round(sg.rsi([c for _, c in series(100, RALLY_THEN_FALL)]), 1)
    assert all(s["label"] == sg.SIGNAL_LABEL for s in o["signals"])


def test_signals_is_a_leaf_and_quant_reaches_only_it():
    import ast
    from pathlib import Path

    def package_imports(mod):
        tree = ast.parse(Path(mod.__file__).read_text(encoding="utf-8"))
        rel, absolute = set(), set()
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom) and n.level:
                rel |= {n.module} if n.module else {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom) and (n.module or "").startswith("tracker"):
                absolute |= {f"{n.module}.{a.name}" for a in n.names}
            elif isinstance(n, ast.Import):
                absolute |= {a.name for a in n.names if a.name.startswith("tracker")}
        return rel, absolute

    assert package_imports(sg) == (set(), set())                       # imports nothing from the package
    rel, absolute = package_imports(quant)
    assert rel == {"domain", "assumptions", "signals"} and absolute == set()   # G3 + K16 (L1)
