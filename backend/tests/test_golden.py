"""Golden numbers: the headline results of the sample book, frozen in tests/golden/demo_numbers.json.

Any change to a valuation or return calculation shows up here as a precise diff. When a change is intended,
regenerate the file and say why in the commit:

    UPDATE_GOLDEN=1 python -m pytest tests/test_golden.py
"""
import json
import os

import pytest

from tracker.analytics.history import build_history
from tracker.analytics.portfolio import compute_portfolio

from demo_book import BENCH_HIST, FX_HIST, PRICE_HIST, TODAY, USD_INR, book

GOLDEN = os.path.join(os.path.dirname(__file__), "golden", "demo_numbers.json")


def numbers() -> dict:
    insts, txns = book()
    port = compute_portfolio(insts, txns, USD_INR, today=TODAY)
    out = {
        "totals": {k: port["totals"][k] for k in ("value", "cost", "unrealized", "realized", "income", "total_gain",
                                                    "day_change", "xirr")},
        "segments": {s["segment"]: {"value": s["value"], "xirr": s["xirr"], "total_return": s["total_return"]}
                     for s in port["segments"]},
        "positions": {p["name"]: {"value": p["value"], "cost": p["cost"], "unrealized": p["unrealized"],
                                  "realized": p["realized"], "income": p["income"], "xirr": p["xirr"]}
                      for p in port["positions"]},
    }
    for rng in ("ALL", "1Y"):
        insts, txns = book()
        h = build_history(insts, txns, PRICE_HIST, FX_HIST, BENCH_HIST, today=TODAY, rng=rng, usd_inr=USD_INR)
        m = h["metrics"]
        out[f"history_{rng}"] = {
            **{k: m[k] for k in ("start_value", "end_value", "net_flows", "gain", "twr", "xirr", "max_drawdown")},
            "benchmarks": {b["key"]: b["xirr"] for b in h["benchmarks"]},
        }
    return out


def test_golden_numbers():
    got = json.loads(json.dumps(numbers()))
    if os.environ.get("UPDATE_GOLDEN") or not os.path.exists(GOLDEN):
        os.makedirs(os.path.dirname(GOLDEN), exist_ok=True)
        with open(GOLDEN, "w") as f:
            json.dump(got, f, indent=1, sort_keys=True)
        if not os.environ.get("UPDATE_GOLDEN"):
            pytest.fail("golden file was missing; written now — re-run")
        return
    with open(GOLDEN) as f:
        want = json.load(f)
    assert got == want


def test_history_and_portfolio_agree_on_today_and_on_the_return():
    """One number, one answer: the value history and the portfolio must give the same value today and the same
    return since the start (they use the same valuation helpers and the same cash-flow rule)."""
    from tracker.analytics.portfolio import compute_portfolio as cp
    insts, txns = book()
    port = cp(insts, txns, USD_INR, today=TODAY)
    insts, txns = book()
    h = build_history(insts, txns, PRICE_HIST, FX_HIST, BENCH_HIST, today=TODAY, rng="ALL", usd_inr=USD_INR)
    assert h["metrics"]["end_value"] == pytest.approx(port["totals"]["value"], abs=0.05)
    assert h["metrics"]["xirr"] == port["totals"]["xirr"]


def test_contributors_add_up_since_the_start():
    insts, txns = book()
    h = build_history(insts, txns, PRICE_HIST, FX_HIST, BENCH_HIST, today=TODAY, rng="ALL", usd_inr=USD_INR)
    # all but the USD wallet's currency move on its small balance
    assert sum(c["gain"] for c in h["contributors"]) == pytest.approx(h["metrics"]["gain"], abs=600)


def test_fd_payouts_are_not_counted_twice():
    """A payout FD: its value never includes interest already paid out, so history and portfolio agree on it."""
    from tracker.analytics.portfolio import compute_portfolio as cp
    insts, txns = book()
    port = cp(insts, txns, USD_INR, today=TODAY)
    fd = next(p for p in port["positions"] if p["name"] == "HDFC payout FD")
    insts, txns = book()
    h = build_history(insts, txns, PRICE_HIST, FX_HIST, BENCH_HIST, today=TODAY, rng="ALL", usd_inr=USD_INR)
    hist_fd = next(c for c in h["contributors"] if c["name"] == "HDFC payout FD")
    assert hist_fd["end_value"] == pytest.approx(fd["value"], abs=0.05)
