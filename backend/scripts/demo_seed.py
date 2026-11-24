"""Build a local SQLite file with a fictional sample portfolio for checking screens offline.

    cd backend && python scripts/demo_seed.py /tmp/demo.db
    JWT_SECRET=dev-secret-long-enough-for-hs256-demo DATABASE_PATH=/tmp/demo.db ADMIN_EMAIL=demo@example.com python app.py

The script prints a session token for demo@example.com (admin): put it in the browser's localStorage as
`auth_token` (and `auth_user` = {"email":"demo@example.com","name":"Demo User","role":"admin"}).
Every name and number here is made up. Prices and benchmark histories are synthetic, so no network is needed.
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("JWT_SECRET", "dev-secret-long-enough-for-hs256-demo")
for var in ("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"):
    os.environ.pop(var, None)

from tracker import create_app  # noqa: E402
from tracker.db import SqliteDatabase  # noqa: E402
from tracker.security import issue_token  # noqa: E402

EMAIL = "demo@example.com"
TODAY = date.today()


def months_ago(n: int, day: int = 5) -> str:
    y, m = TODAY.year, TODAY.month - n
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, min(day, 28)).isoformat()


def path(sym: str, start: date, end_price: float, drift: float, vol: float, seed: int) -> list[tuple[str, float]]:
    """A daily random walk ending exactly at `end_price` (weekdays only)."""
    rnd = random.Random(seed)
    days, d = [], start
    while d <= TODAY:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    logp, vals = 0.0, []
    for _ in days:
        logp += drift / 252 + rnd.gauss(0, vol / math.sqrt(252))
        vals.append(logp)
    shift = math.log(end_price) - vals[-1]
    return [(day.isoformat(), round(math.exp(v + shift), 4)) for day, v in zip(days, vals)]


def main(db_path: str):
    if os.path.exists(db_path):
        os.remove(db_path)
    db = SqliteDatabase(db_path)
    app = create_app(db)
    db.execute("INSERT INTO allowlist (email, added_date, role) VALUES (?, ?, 'admin')", (EMAIL, TODAY.isoformat()))
    c = app.test_client()
    h = {"Authorization": f"Bearer {issue_token(EMAIL, 'admin')}"}

    def post(url, body):
        r = c.post("/api/" + url, headers=h, json=body)
        if r.status_code >= 300:
            raise SystemExit(f"{url} {r.status_code} {r.json}")
        return r.json

    def buy(name, ac, day, qty, amount, amount_fc=None, **inst):
        return post("transactions", {"type": "BUY", "date": day, "quantity": qty, "amount": amount, "amount_fc": amount_fc,
                                     "instrument": {"asset_class": ac, "name": name, **inst}})

    ids = {}
    india = dict(market="India")
    t = buy("HDFC Bank", "equity", months_ago(33, 10), 40, 60400, symbol="HDFCBANK.NS", sector="Banking", **india)
    ids["HDFC Bank"] = t["instrument_id"]
    t = buy("Larsen & Toubro", "equity", months_ago(29), 12, 38160, symbol="LT.NS", sector="Infra", **india)
    ids["Larsen & Toubro"] = t["instrument_id"]
    t = buy("Infosys", "equity", months_ago(32, 12), 20, 29800, symbol="INFY.NS", sector="IT", **india)
    ids["Infosys"] = t["instrument_id"]
    post("transactions", {"instrument_id": ids["Infosys"], "type": "BUY", "date": months_ago(22, 8), "quantity": 10, "amount": 18900})
    post("transactions", {"instrument_id": ids["Infosys"], "type": "SELL", "date": months_ago(15, 20), "quantity": 5, "amount": 7600})
    post("transactions", {"instrument_id": ids["Infosys"], "type": "DIVIDEND", "date": months_ago(16, 15), "amount": 450})
    t = buy("Tata Motors", "equity", months_ago(14, 15), 50, 52000, symbol="TATAMOTORS.NS", sector="Auto", **india)
    ids["Tata Motors"] = t["instrument_id"]
    t = buy("Reliance Industries", "equity", months_ago(12, 20), 25, 36250, symbol="RELIANCE.NS", sector="Energy", **india)
    ids["Reliance Industries"] = t["instrument_id"]

    post("forex", {"date": months_ago(30, 2), "amount": 167000, "amount_fc": 2000, "type": "FX_IN"})
    us = dict(market="USA")
    t = buy("Apple", "equity", months_ago(30, 10), 5, 76000, symbol="AAPL", amount_fc=910, **us)
    ids["Apple"] = t["instrument_id"]
    t = buy("Microsoft", "equity", months_ago(18, 10), 2, 67000, symbol="MSFT", amount_fc=804, **us)
    ids["Microsoft"] = t["instrument_id"]

    t = buy("Parag Parikh Flexi Cap", "mutual_fund", months_ago(40, 1), 1200, 70000, symbol="AMFI:122639", category="Equity")
    ids["Parag Parikh Flexi Cap"] = t["instrument_id"]
    for k in range(24, 0, -3):
        post("transactions", {"instrument_id": ids["Parag Parikh Flexi Cap"], "type": "BUY", "date": months_ago(k, 5),
                              "quantity": round(10000 / (60 + (24 - k)), 3), "amount": 10000})
    t = buy("Axis ELSS Tax Saver", "mutual_fund", months_ago(33, 15), 600, 50000, symbol="AMFI:120503", category="ELSS")
    ids["Axis ELSS Tax Saver"] = t["instrument_id"]
    t = buy("HDFC Index Nifty 50", "mutual_fund", months_ago(27, 1), 300, 60000, symbol="AMFI:119063", category="Equity")
    ids["HDFC Index Nifty 50"] = t["instrument_id"]
    t = buy("ICICI Liquid Fund", "mutual_fund", months_ago(21, 1), 1700, 50000, symbol="AMFI:120197", category="Debt")
    ids["ICICI Liquid Fund"] = t["instrument_id"]

    t = buy("Gold BeES", "commodity", months_ago(34, 10), 900, 48000, symbol="GOLDBEES.NS")
    ids["Gold BeES"] = t["instrument_id"]
    t = buy("Silver BeES", "commodity", months_ago(20, 1), 220, 20000, symbol="SILVERBEES.NS")
    ids["Silver BeES"] = t["instrument_id"]

    for n, (amt, months, rate, start) in enumerate([(25000, 12, 34, 10), (20000, 9, 30, 6), (15000, 6, 36, 9)]):
        loan = post("p2p/loans", {"name": f"Borrower {chr(65 + n)}", "ref2": f"LDC-{1001 + n}", "date": months_ago(start, 3),
                                  "amount": amt, "tenure_months": months, "rate": rate, "platform": "LenDenClub"})
        paid = min(start - 1, months) - (3 if n == 2 else 0)
        for k in range(paid):
            emi = amt / months * (1 + rate / 100 / 12 * (months - k) / 2)
            post("transactions", {"instrument_id": loan["id"], "type": "REPAYMENT", "date": months_ago(start - 1 - k, 5),
                                  "amount": round(emi, 2), "principal": round(amt / months, 2)})

    post("fixed-deposits", {"name": "SBI FD", "date": months_ago(11, 6), "amount": 100000, "rate": 7.1,
                            "maturity_date": (TODAY + timedelta(days=12)).isoformat(), "platform": "SBI"})
    post("fixed-deposits", {"name": "HDFC Bank FD", "date": months_ago(8, 15), "amount": 60000, "rate": 7.25,
                            "maturity_date": (TODAY + timedelta(days=400)).isoformat(), "platform": "HDFC Bank"})

    epf = post("instruments", {"asset_class": "epf", "name": "EPF", "rate": 8.25})
    for k in range(42, 0, -1):
        post("transactions", {"instrument_id": epf["id"], "type": "BUY", "date": months_ago(k, 28), "amount": 9600})
        if months_ago(k, 28)[5:7] == "03":
            post("transactions", {"instrument_id": epf["id"], "type": "CREDIT", "date": months_ago(k, 31),
                                  "amount": round(9600 * (42 - k) * 0.08 + 4000, 2)})
    nps = post("instruments", {"asset_class": "nps", "name": "NPS Tier I", "last_price": 52.0})
    post("transactions", {"instrument_id": nps["id"], "type": "BUY", "date": months_ago(29, 1), "quantity": 1000, "amount": 40000})

    # ── prices: last price, previous close and a daily history ──
    last = {"HDFCBANK.NS": 1695, "LT.NS": 3680, "INFY.NS": 1712, "TATAMOTORS.NS": 712, "RELIANCE.NS": 1398, "AAPL": 232,
            "MSFT": 420, "AMFI:122639": 82, "AMFI:120503": 96, "AMFI:119063": 230, "AMFI:120197": 31, "GOLDBEES.NS": 71.5,
            "SILVERBEES.NS": 102}
    drift = {"TATAMOTORS.NS": -0.25, "RELIANCE.NS": -0.02, "AAPL": 0.2, "GOLDBEES.NS": 0.18, "SILVERBEES.NS": 0.2,
             "AMFI:120197": 0.065}
    start = date.fromisoformat(months_ago(42, 1)) - timedelta(days=10)
    hist = {}
    for i, (sym, px) in enumerate(last.items()):
        hist[sym] = path(sym, start, px, drift.get(sym, 0.12), 0.02 if sym == "AMFI:120197" else 0.2, i + 1)
    hist["^CRSLDX"] = path("^CRSLDX", start, 22500, 0.12, 0.15, 101)
    hist["^NSEI"] = path("^NSEI", start, 24800, 0.11, 0.14, 102)
    hist["^GSPC"] = path("^GSPC", start, 6000, 0.14, 0.16, 103)
    hist["USDINR=X"] = path("USDINR=X", start, 88.4, 0.025, 0.03, 104)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    stmts = []
    for sym, rows in hist.items():
        for i in range(0, len(rows), 200):
            part = rows[i:i + 200]
            stmts.append(("INSERT OR REPLACE INTO price_history (symbol, date, close) VALUES " + ",".join(["(?,?,?)"] * len(part)),
                          [v for dt, cl in part for v in (sym, dt, cl)]))
        stmts.append(("INSERT OR REPLACE INTO price_meta (symbol, fetched_at, first_date, last_date) VALUES (?,?,?,?)",
                      (sym, "2999-01-01T00:00:00+00:00", rows[0][0], rows[-1][0])))
    for sym, px in last.items():
        prev = hist[sym][-2][1]
        stmts.append(("UPDATE instruments SET last_price = ?, prev_close = ?, last_price_at = ? WHERE symbol = ?", (px, prev, stamp, sym)))
    db.batch(stmts)
    db.execute("INSERT OR REPLACE INTO user_settings (owner, key, value, updated_at) VALUES ('__system__', 'fx:USDINR', ?, ?)",
               (json.dumps({"price": 88.4, "at": stamp}), stamp))
    db.execute("INSERT OR REPLACE INTO user_settings (owner, key, value, updated_at) VALUES ('__system__', 'prices:last_refresh', ?, ?)",
               (stamp, stamp))
    c.put("/api/settings/groupTargets", headers=h, json={"value": {"equity_india": 20, "equity_global": 12, "mutual_funds": 30,
                                                                    "p2p": 3, "commodities": 8, "epf": 20, "others": 7}})
    c.put("/api/settings/riskProfile", headers=h, json={"value": "balanced"})
    print(issue_token(EMAIL, "admin"))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo.db")
