"""Phase-5 calculation fixes: defaulted P2P loans, unpriced holdings in history, EPF accrual in history."""
import pytest

from tracker.analytics.history import build_history
from tracker.analytics.portfolio import compute_portfolio

from conftest import USER, auth
from demo_book import BENCH_HIST, FX_HIST, PRICE_HIST, TODAY, USD_INR, book


def defaulted_book():
    insts, txns = book()
    for i in insts:
        if i["name"] == "Borrower A":
            i["status"] = "defaulted"
    return insts, txns


@pytest.mark.parametrize("recovery,share", [(None, 1.0), (0.0, 0.0), (40.0, 0.4)])
def test_defaulted_loan_counts_at_the_share_expected_back(recovery, share):
    insts, txns = defaulted_book()
    port = compute_portfolio(insts, txns, USD_INR, today=TODAY, p2p_recovery=recovery)
    loan = next(p for p in port["positions"] if p["name"] == "Borrower A")
    assert loan["value"] == pytest.approx(loan["outstanding"] * share, abs=0.01)
    assert loan["unrealized"] == pytest.approx(-loan["outstanding"] * (1 - share), abs=0.01)
    insts, txns = defaulted_book()
    h = build_history(insts, txns, PRICE_HIST, FX_HIST, BENCH_HIST, today=TODAY, usd_inr=USD_INR, p2p_recovery=recovery)
    assert h["metrics"]["end_value"] == pytest.approx(port["totals"]["value"], abs=0.05)


def test_unpriced_holding_moves_gradually_in_history():
    """NPS has only today's price: history goes from cost to today's value in a line, not in one jump."""
    insts, txns = book()
    nps = [i for i in insts if i["asset_class"] == "nps"]
    nps_txns = [t for t in txns if t["instrument_id"] == nps[0]["id"]]
    h = build_history(nps, nps_txns, {}, FX_HIST, {}, today=TODAY, usd_inr=USD_INR)
    vals = [p["value"] for p in h["series"]]
    assert vals[0] == pytest.approx(40000, abs=50) and vals[-1] == pytest.approx(52000, abs=1)
    jumps = [b - a for a, b in zip(vals, vals[1:])]
    assert max(jumps) < 1000   # no single-day leap of the whole 12,000 gain


def test_epf_history_includes_interest_not_yet_credited():
    insts, txns = book()
    epf = [i for i in insts if i["asset_class"] == "epf"]
    port = compute_portfolio(epf, [t for t in txns if t["instrument_id"] == epf[0]["id"]], USD_INR, today=TODAY)
    h = build_history(epf, [t for t in txns if t["instrument_id"] == epf[0]["id"]], {}, FX_HIST, {}, today=TODAY)
    assert h["metrics"]["end_value"] == pytest.approx(port["totals"]["value"], abs=0.05)


def test_recovery_setting_is_validated_and_applied(client):
    h = auth(USER, "user")
    assert client.put("/api/settings/p2pDefaultRecovery", headers=h, json={"value": 140}).status_code == 400
    assert client.put("/api/settings/p2pDefaultRecovery", headers=h, json={"value": 25}).status_code == 200
    assert float(client.get("/api/settings", headers=h).json["p2pDefaultRecovery"]) == 25


def test_p2p_emi_schedule_is_monthly_and_measured_on_the_statement_date():
    from datetime import date
    from demo_book import _inst, _t
    insts = [_inst(1, "p2p", "Loan up to date", rate=24.0, tenure_months=6, maturity_date="2026-06-05"),
             _inst(2, "p2p", "Loan behind", rate=24.0, tenure_months=6, maturity_date="2026-06-05")]
    sched = __import__("tracker.analytics.portfolio", fromlist=["emi_principal_paid"]).emi_principal_paid(6000, 24.0, 6)
    txns = [_t(1, 1, "2025-12-10", "BUY", 6000), _t(2, 2, "2025-12-10", "BUY", 6000),
            # loan 1 repaid three EMIs (Jan, Feb, Mar), loan 2 only one
            _t(3, 1, "2026-03-05", "REPAYMENT", 3300, principal=round(sched[2], 2)),
            _t(4, 2, "2026-01-05", "REPAYMENT", 1100, principal=round(sched[0], 2))]
    port = compute_portfolio(insts, txns, None, today=date(2026, 11, 1))
    a, b = (next(p for p in port["positions"] if p["id"] == i) for i in (1, 2))
    # measured on 5 March 2026 (the latest repayment recorded), not on 1 November
    assert a["data_as_of"] == "2026-03-05"
    assert (a["emis_paid"], a["emis_behind"], a["next_due"], a["overdue_days"]) == (3, 0, "2026-04-05", 0)
    assert (b["emis_paid"], b["emis_behind"], b["next_due"]) == (1, 2, "2026-02-05")
    assert b["overdue_days"] == 28


def test_xirr_picks_the_root_nearest_ten_percent():
    from datetime import date
    from tracker.analytics.xirr import xirr
    # -100 now, +230 in a year, -132 in two years: NPV is zero at 10% and at 20%
    flows = [(date(2024, 1, 1), -100.0), (date(2024, 12, 31), 230.0), (date(2025, 12, 31), -132.0)]
    assert xirr(flows) == pytest.approx(0.10, abs=0.002)
    assert xirr([(date(2025, 1, 1), -100.0), (date(2026, 1, 1), 112.0)]) == pytest.approx(0.12, abs=1e-4)


def test_group_explain_adds_up():
    from tracker.analytics import overview as ov
    insts, txns = book()
    port = compute_portfolio(insts, txns, USD_INR, today=TODAY)
    for key in ("equity_india", "p2p", "epf", "mutual_funds"):
        e = ov.group_explain(port, txns, key, BENCH_HIST, FX_HIST, TODAY)
        assert e["gain"] == pytest.approx(e["value"] + e["taken_out"] - e["put_in"], abs=0.02)
        assert sum(h["put_in"] for h in e["holdings"]) == pytest.approx(e["put_in"], abs=0.05)
        assert sum(y["put_in"] for y in e["by_year"]) == pytest.approx(e["put_in"], abs=0.05)
        g = next(x for x in ov.group_view(port, txns, {}, BENCH_HIST, FX_HIST, TODAY)["groups"] if x["key"] == key)
        assert e["xirr"] == g["xirr"]


def us_dividend_book(with_usd=True):
    from demo_book import _t
    insts, txns = book()
    txns.append(_t(50, 3, "2025-08-15", "DIVIDEND", 885.0, amount_fc=10.0 if with_usd else None))
    return insts, txns


@pytest.mark.parametrize("with_usd", [True, False])
def test_us_dividend_stays_in_the_usd_wallet(with_usd):
    insts, txns = book()
    before = compute_portfolio(insts, txns, USD_INR, today=TODAY)
    insts, txns = us_dividend_book(with_usd)
    port = compute_portfolio(insts, txns, USD_INR, today=TODAY)
    w0 = next(p for p in before["positions"] if p["asset_class"] == "cash")
    w1 = next(p for p in port["positions"] if p["asset_class"] == "cash")
    usd = 10.0 if with_usd else 885.0 / 83.5   # the wallet's average deposit rate (₹83,500 for $1,000)
    assert w1["balance_usd"] == pytest.approx(w0["balance_usd"] + usd, abs=0.01)
    # the dividend is Apple's income, and not money taken out of the portfolio
    apple = next(p for p in port["positions"] if p["name"] == "Apple")
    assert apple["income"] == 885.0
    seg = {s["segment"]: s for s in port["segments"]}
    assert port["totals"]["value"] == pytest.approx(before["totals"]["value"] + usd * USD_INR, abs=0.05)
    # history agrees with the portfolio on today's value and on the return
    insts, txns = us_dividend_book(with_usd)
    h = build_history(insts, txns, PRICE_HIST, FX_HIST, BENCH_HIST, today=TODAY, usd_inr=USD_INR)
    assert h["metrics"]["end_value"] == pytest.approx(port["totals"]["value"], abs=0.05)
    assert h["metrics"]["xirr"] == port["totals"]["xirr"]
    assert seg["Equity (USA)"]["xirr"] is not None


def test_us_dividend_makes_no_money_out_entry_and_old_ones_are_removed(app, client):
    from tracker.migrations import m007_us_dividends_in_wallet
    h = auth(USER, "user")
    client.post("/api/forex", headers=h, json={"date": "2025-01-02", "amount": 85000, "amount_fc": 1000, "type": "FX_IN"})
    us = client.post("/api/transactions", headers=h, json={"type": "BUY", "date": "2025-01-05", "quantity": 2, "amount": 34000,
                                                           "amount_fc": 400, "instrument": {"asset_class": "equity", "name": "Apple", "market": "USA"}}).json
    div = client.post("/api/transactions", headers=h, json={"instrument_id": us["instrument_id"], "type": "DIVIDEND",
                                                            "date": "2025-05-15", "amount": 850, "amount_fc": 10}).json
    db = app.extensions["ledger"].db
    assert not db.query("SELECT * FROM cash_movements WHERE transaction_id = ?", (div["id"],))
    # an old automatic entry for it is removed by the migration; a hand-typed one stays
    db.execute("INSERT INTO cash_movements (owner, account, date, direction, amount, kind, transaction_id, source, created_at, updated_at) "
               "VALUES (?, 'capital', '2025-05-15', 'out', 850, 'Withdrawal', ?, 'auto', 'x', 'x')", (USER, div["id"]))
    db.execute("INSERT INTO cash_movements (owner, account, date, direction, amount, kind, source, created_at, updated_at) "
               "VALUES (?, 'capital', '2025-05-16', 'out', 100, 'Withdrawal', 'manual', 'x', 'x')", (USER,))
    db.batch(m007_us_dividends_in_wallet(db))
    left = db.query("SELECT source FROM cash_movements WHERE owner = ? AND date >= '2025-05-15'", (USER,))
    assert [r["source"] for r in left] == ["manual"]
    checks = {c["id"] for c in client.get("/api/checks", headers=h).json}
    assert "wallet-negative" not in checks


def test_rupee_only_us_entries_convert_at_the_average_deposit_rate():
    """Two deposits at ₹82 and ₹86: a rupee-only US buy converts at their weighted average, not at today's rate."""
    from tracker.analytics.portfolio import deposit_rates
    from demo_book import _inst, _t
    insts = [_inst(1, "cash", "USD wallet", currency="USD"), _inst(2, "equity", "Microsoft", market="USA", currency="USD")]
    txns = [_t(1, 1, "2025-01-02", "FX_IN", 82000, amount_fc=1000), _t(2, 1, "2025-06-02", "FX_IN", 258000, amount_fc=3000)]
    assert deposit_rates(insts, txns, 88.4)[insts[0]["owner"]] == pytest.approx(85.0)
    txns.append(_t(3, 2, "2025-07-01", "BUY", 170000, qty=5))   # no dollar amount
    port = compute_portfolio(insts, txns, 88.4, today=TODAY)
    wallet = next(p for p in port["positions"] if p["asset_class"] == "cash")
    assert wallet["balance_usd"] == pytest.approx(4000 - 170000 / 85.0, abs=0.01)
