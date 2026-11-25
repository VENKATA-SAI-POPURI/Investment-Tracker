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
