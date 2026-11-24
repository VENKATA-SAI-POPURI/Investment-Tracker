"""A small but complete sample book (every asset class, every transaction type) used by the golden-number and
overview tests. Pure data: no database, no network. Dates are fixed so results never drift with the calendar."""
from __future__ import annotations

from datetime import date, timedelta

TODAY = date(2026, 11, 1)
OWNER = "demo@example.com"


def _inst(iid, ac, name, **kw):
    base = {"id": iid, "owner": OWNER, "asset_class": ac, "name": name, "market": None, "currency": "INR",
            "symbol": None, "last_price": None, "prev_close": None, "last_price_at": None, "category": None,
            "sub_category": None, "tax_class": None, "sector": None, "market_cap": None, "platform": None,
            "status": "active", "ref": None, "ref2": None, "rate": None, "tenure_months": None,
            "maturity_date": None, "notes": None, "price_source": None}
    base.update(kw)
    return base


INSTRUMENTS = [
    _inst(1, "equity", "Infosys", market="India", symbol="INFY.NS", last_price=1712.0, prev_close=1700.0,
          tax_class="equity", sector="IT"),
    _inst(2, "equity", "Tata Motors", market="India", symbol="TATAMOTORS.NS", last_price=712.0, prev_close=720.0,
          tax_class="equity", sector="Auto"),
    _inst(3, "equity", "Apple", market="USA", currency="USD", symbol="AAPL", last_price=232.0, prev_close=230.0,
          tax_class="foreign_equity"),
    _inst(4, "cash", "USD wallet", currency="USD"),
    _inst(5, "mutual_fund", "Parag Parikh Flexi Cap", symbol="AMFI:122639", last_price=82.0, prev_close=81.5,
          category="Equity", tax_class="equity"),
    _inst(6, "mutual_fund", "Liquid Fund", symbol="AMFI:100000", last_price=31.0, prev_close=31.0,
          category="Debt", tax_class="debt"),
    _inst(7, "commodity", "Gold BeES", symbol="GOLDBEES.NS", last_price=71.5, prev_close=71.0,
          tax_class="listed_other"),
    _inst(8, "p2p", "Borrower A", platform="LenDenClub", rate=36.0, tenure_months=6, maturity_date="2026-06-05",
          ref="P2P-001"),
    _inst(9, "p2p", "Borrower B (legacy)", platform="LenDenClub", rate=30.0, tenure_months=4,
          maturity_date="2026-09-01", ref="P2P-002"),
    _inst(10, "fixed_deposit", "SBI FD", rate=7.1, maturity_date="2027-04-01", tax_class="income"),
    _inst(11, "fixed_deposit", "HDFC payout FD", rate=7.0, maturity_date="2027-01-15", tax_class="income"),
    _inst(12, "epf", "EPF", rate=8.25, tax_class="exempt"),
    _inst(13, "nps", "NPS Tier I", last_price=52.0, tax_class="exempt"),
]


def _t(tid, iid, day, typ, amount, qty=None, amount_fc=None, principal=None, fees=None):
    return {"id": tid, "owner": OWNER, "instrument_id": iid, "date": day, "type": typ, "quantity": qty,
            "amount": amount, "amount_fc": amount_fc, "principal": principal, "fees": fees, "notes": None,
            "source": "manual"}


TRANSACTIONS = [
    _t(1, 1, "2024-03-12", "BUY", 29800, qty=20),
    _t(2, 1, "2025-01-08", "BUY", 18900, qty=10),
    _t(3, 1, "2025-08-20", "SELL", 7600, qty=5),
    _t(4, 1, "2025-07-15", "DIVIDEND", 450),
    _t(5, 2, "2025-09-15", "BUY", 52000, qty=50),
    _t(6, 4, "2024-05-02", "FX_IN", 83500, amount_fc=1000),
    _t(7, 3, "2024-05-10", "BUY", 76000, qty=5, amount_fc=910),
    _t(8, 5, "2023-07-01", "BUY", 70000, qty=1200),
    _t(9, 5, "2024-07-01", "BUY", 30000, qty=430),
    _t(10, 6, "2025-02-01", "BUY", 50000, qty=1700),
    _t(11, 7, "2024-01-10", "BUY", 48000, qty=900),
    _t(12, 8, "2025-12-05", "BUY", 5000),
    _t(13, 8, "2026-01-05", "REPAYMENT", 950, principal=800),
    _t(14, 8, "2026-02-05", "REPAYMENT", 950, principal=820),
    _t(15, 9, "2026-05-01", "BUY", 4000),
    _t(16, 9, "2026-06-01", "REPAYMENT", 1100),      # legacy: no principal split
    _t(17, 10, "2025-04-01", "BUY", 100000),
    _t(18, 11, "2025-01-15", "BUY", 50000),
    _t(19, 11, "2025-04-15", "INTEREST", 875),
    _t(20, 11, "2025-07-15", "INTEREST", 875),
    _t(21, 11, "2025-10-15", "INTEREST", 875),
    _t(22, 11, "2026-01-15", "INTEREST", 875),
    _t(23, 12, "2024-04-30", "BUY", 12000),
    _t(24, 12, "2024-05-31", "BUY", 12000),
    _t(25, 12, "2025-03-31", "CREDIT", 1100),
    _t(26, 12, "2025-04-30", "BUY", 12000),
    _t(27, 13, "2024-06-01", "BUY", 40000, qty=1000),
]


def _monthly(start: date, end: date, p0: float, p1: float) -> list[tuple[str, float]]:
    """A straight-line monthly price path with a small wobble, as (iso date, close) points."""
    pts, d, i = [], start, 0
    n = max((end - start).days // 30, 1)
    while d <= end:
        f = min(i / n, 1.0)
        wobble = 1 + (0.03 if i % 3 == 1 else -0.02 if i % 3 == 2 else 0)
        pts.append((d.isoformat(), round((p0 + (p1 - p0) * f) * wobble, 4)))
        d += timedelta(days=30)
        i += 1
    pts.append((end.isoformat(), p1))
    return pts


START = date(2023, 7, 1)
PRICE_HIST = {
    "INFY.NS": _monthly(START, TODAY, 1350, 1712),
    "TATAMOTORS.NS": _monthly(START, TODAY, 900, 712),
    "AAPL": _monthly(START, TODAY, 170, 232),
    "AMFI:122639": _monthly(START, TODAY, 55, 82),
    "AMFI:100000": _monthly(START, TODAY, 27, 31),
    "GOLDBEES.NS": _monthly(START, TODAY, 50, 71.5),
}
FX_HIST = _monthly(START, TODAY, 82.0, 88.4)
BENCH_HIST = {
    "NIFTY500": {"symbol": "^CRSLDX", "label": "Nifty 500", "currency": "INR", "points": _monthly(START, TODAY, 16000, 22500)},
    "SP500": {"symbol": "^GSPC", "label": "S&P 500 (in ₹)", "currency": "USD", "points": _monthly(START, TODAY, 4400, 6000)},
    "GOLD": {"symbol": "GOLDBEES.NS", "label": "Gold (GOLDBEES)", "currency": "INR", "points": PRICE_HIST["GOLDBEES.NS"]},
}
USD_INR = 88.4


def book():
    """Fresh copies, so a test may mutate them."""
    return [dict(i) for i in INSTRUMENTS], [dict(t) for t in TRANSACTIONS]
