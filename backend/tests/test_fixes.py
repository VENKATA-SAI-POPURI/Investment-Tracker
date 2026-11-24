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
