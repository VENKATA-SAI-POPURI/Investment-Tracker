"""Plan engine v2 (`analytics/simulate.py`): SPEC §7.9 test_simulate row in full, plus AMENDMENTS K8's linearity,
CRN-across-horizons and speed checks. Offline and deterministic (fixed seeds)."""
import math
import time
from datetime import date

import pytest

from tracker import domain as d
from tracker.analytics import assumptions as A
from tracker.analytics import simulate as S

TODAY = date(2026, 11, 14)


def flat_book(mu=0.10, sigma=0.0, **over):
    """A §6.1-shaped Book with every key at (μ, σ), plus overrides {key: (μ, σ)}."""
    segs = {k: {"return_pct": mu * 100, "vol_pct": sigma * 100, "source": "test"} for k in A.KEYS}
    for k, (m, s) in over.items():
        segs[k] = {"return_pct": m * 100, "vol_pct": s * 100, "source": "test"}
    return {"segments": segs, "inflation_pct": 6.0}


def eq(iid, value, seg=d.SEG_EQ_IN, cost=None, **kw):
    ac = {d.SEG_EQ_IN: d.EQUITY, d.SEG_EQ_US: d.EQUITY, d.SEG_MF: d.MUTUAL_FUND, d.SEG_COMMODITY: d.COMMODITY,
          d.SEG_NPS: d.NPS}[seg]
    return {"id": iid, "asset_class": ac, "segment": seg, "name": f"H{iid}", "value": value,
            "cost": value if cost is None else cost, "is_open": True, **kw}


def fd(iid, value, rate, maturity=None, maturity_value=None):
    return {"id": iid, "asset_class": d.FIXED_DEPOSIT, "segment": d.SEG_FD, "name": f"FD{iid}", "value": value, "rate": rate,
            "maturity_date": maturity, "maturity_value": maturity_value, "is_open": True}


def full_fixture():
    """The K8 budget fixture: all six stochastic keys, 2 FDs, 1 P2P loan, EPF with payroll rows, 3 SIP plans."""
    pos = [eq(1, 300000, cost=200000), eq(2, 150000, d.SEG_EQ_US, 120000, market="USA"),
           eq(3, 250000, d.SEG_MF, 180000, category="Equity: Flexi Cap"),
           eq(4, 100000, d.SEG_MF, 90000, category="Debt: Short Duration", tax_class=d.TAX_DEBT),
           eq(5, 60000, d.SEG_COMMODITY, 50000), eq(6, 200000, d.SEG_NPS, 150000),
           fd(7, 100000, 7.0, "2027-05-10", 104000), fd(8, 50000, 7.5, "2028-02-10"),
           {"id": 9, "asset_class": d.P2P, "segment": d.SEG_P2P, "name": "Loan", "value": 40000, "outstanding": 40000,
            "rate": 12.0, "maturity_date": "2027-11-01", "is_open": True},
           {"id": 10, "asset_class": d.EPF, "segment": d.SEG_EPF, "name": "EPF", "value": 500000, "rate": 8.25, "is_open": True}]
    txns = [{"instrument_id": 10, "date": "2026-10-31", "type": d.BUY, "amount": 12000},
            {"instrument_id": 10, "date": "2026-09-30", "type": d.BUY, "amount": 12000}]
    inst = [{"id": 10, "asset_class": d.EPF}]
    sips = [{"id": 1, "instrument_id": 3, "amount": 10000, "frequency": "monthly", "day_of_month": 5, "active": 1,
             "start_date": "2026-01-05", "step_up_pct": 10},
            {"id": 2, "instrument_id": 1, "amount": 15000, "frequency": "quarterly", "day_of_month": 10, "active": 1,
             "start_date": "2026-02-10"},
            {"id": 3, "instrument_id": 2, "amount": 1000, "frequency": "weekly", "day_of_month": 1, "active": 1,
             "start_date": "2026-06-01"}]
    book = A.rated_book(pos)
    state = S.build_state(pos, book=book, today=TODAY, txns=txns, instruments=inst)
    return state, sips, book


def one_key_state(value=100000.0, key=d.SEG_EQ_IN):
    return S.build_state([eq(1, value, key)], book=flat_book(), today=TODAY)


def bands(r):
    return [(y["p10"], y["p25"], y["p50"], y["p75"], y["p90"]) for y in r["years"]]


# ── §7.9 ──

def test_sigma_zero_gives_the_closed_form_fv():
    """σ = 0 → p10 = p50 = p90 = pv(1+μ)^T + Σ sip (1+μ)^((T − m + ½)/12) within 0.5% (mid-month flows)."""
    book = flat_book(0.10, 0.0)
    state = one_key_state()
    flows = S.lump_flow(5000, state=state, today=TODAY, horizon_months=120)
    r = S.run(state, flows, book, horizon_months=120, sims=50)
    end = r["years"][-1]
    fv = 100000 * 1.10 ** 10 + sum(5000 * 1.10 ** ((120 - m + 0.5) / 12) for m in range(1, 121))
    assert end["p10"] == end["p50"] == end["p90"]
    assert end["p50"] == pytest.approx(fv, rel=0.005)
    assert r["expected"][-1] == pytest.approx(end["p50"], rel=1e-9)   # σ = 0: the mean is the median
    assert end["contributed"] == pytest.approx(100000 + 120 * 5000)


def test_percentiles_are_monotone_every_year():
    state, sips, book = full_fixture()
    flows = S.flows_from_sips(sips, state=state, today=TODAY, horizon_months=240)
    r = S.run(state, flows, book, horizon_months=240, sims=400)
    for row in bands(r):
        assert list(row) == sorted(row)
    assert r["years"][0]["p10"] == r["years"][0]["p90"]            # today is known
    assert r["years"][-1]["p90"] > r["years"][-1]["p10"]


def test_the_same_seed_gives_identical_output():
    state, sips, book = full_fixture()
    flows = S.flows_from_sips(sips, state=state, today=TODAY, horizon_months=120)
    a = S.run(state, flows, book, horizon_months=120, sims=300, seed=42, milestones=[2e6, 5e6])
    b = S.run(state, flows, book, horizon_months=120, sims=300, seed=42, milestones=[2e6, 5e6])
    assert a == b
    c = S.run(state, flows, book, horizon_months=120, sims=300, seed=43, milestones=[2e6, 5e6])
    assert c["years"][-1]["p50"] != a["years"][-1]["p50"]


def test_a_higher_sip_raises_every_percentile():
    """CRN: the same draws, so more money in lifts every band in every year."""
    state, sips, book = full_fixture()
    low = S.lump_flow(10000, state=state, today=TODAY, horizon_months=180)
    high = S.lump_flow(15000, state=state, today=TODAY, horizon_months=180)
    a = S.run(state, low, book, horizon_months=180, sims=400)
    b = S.run(state, high, book, horizon_months=180, sims=400)
    for ra, rb in list(zip(bands(a), bands(b)))[1:]:
        assert all(y > x for x, y in zip(ra, rb))
    assert a["no_flow_p50"] == b["no_flow_p50"]                     # the state part is untouched


def test_an_fd_releases_in_its_maturity_month():
    """The FD is a deterministic ladder: it accrues at its rate and its maturity value moves, in the step that
    contains the maturity date, to the segment furthest under target (else to debt funds)."""
    pos = [eq(1, 200000), fd(2, 100000, 7.0, "2027-05-10", 104000)]   # 10 May 2027 is in month 6 from 14 Nov
    book = flat_book(0.10, 0.0)
    state = S.build_state(pos, book=book, today=TODAY)
    assert state["fds"][0]["month"] == S.month_index(TODAY, date(2027, 5, 10)) == 6
    r = S.run(state, [], book, horizon_months=12, sims=10)
    assert r["routes"] == [{"month": 6, "from": d.SEG_FD, "to": A.MF_DEBT, "amount": 104000.0}]
    y1 = r["years"][1]["by_key_p50"]
    assert d.SEG_FD not in y1 and y1[A.MF_DEBT] == pytest.approx(104000 * 1.10 ** (6.5 / 12), rel=1e-3)
    # with targets, to the segment furthest under its target (Commodity at 0% of a 20% target)
    state_t = S.build_state(pos, book=book, today=TODAY, targets={d.SEG_EQ_IN: 60, d.SEG_COMMODITY: 20, d.SEG_FD: 20})
    rt = S.run(state_t, [], book, horizon_months=12, sims=10)
    assert rt["routes"][0]["to"] == d.SEG_COMMODITY and d.SEG_COMMODITY in rt["years"][1]["by_key_p50"]
    # a matured FD that was never recorded (A28) moves at step 0
    late = S.build_state([eq(1, 200000), fd(3, 50000, 7.0, "2026-10-01")], book=book, today=TODAY)
    assert late["release0"] == 50000 and late["fds"] == []
    r0 = S.run(late, [], book, horizon_months=12, sims=10)
    assert r0["years"][0]["by_key_p50"][A.MF_DEBT] == 50000


def test_epf_stays_locked_until_withdrawals_start():
    """EPF grows by its payroll average and interest (credited each March) and is never routed or withdrawn; it joins
    debt funds only when withdrawals start."""
    pos = [eq(1, 100000), {"id": 9, "asset_class": d.EPF, "segment": d.SEG_EPF, "name": "EPF", "value": 200000, "rate": 8.25,
                           "is_open": True}]
    txns = [{"instrument_id": 9, "date": "2026-10-31", "type": d.BUY, "amount": 5000},
            {"instrument_id": 9, "date": "2026-10-31", "type": d.BUY, "amount": 5000}]   # employee + employer
    book = flat_book(0.10, 0.0, **{d.SEG_EPF: (0.0825, 0.0)})
    state = S.build_state(pos, book=book, today=TODAY, txns=txns, instruments=[{"id": 9, "asset_class": d.EPF}])
    assert state["epf"]["monthly"] == 10000
    targets = {d.SEG_EQ_IN: 10, d.SEG_EPF: 90}          # EPF far under target still takes no routed money
    state["targets"] = targets
    r = S.run(state, [], book, horizon_months=60, sims=10)
    epf = [y["by_key_p50"][d.SEG_EPF] for y in r["years"]]
    assert all(b > a for a, b in zip(epf, epf[1:])) and r["routes"] == []
    assert epf[1] == pytest.approx(200000 * 1.0825 + 12 * 10000, rel=0.02)
    assert A.MF_DEBT not in r["years"][-1]["by_key_p50"]
    assert r["years"][-1]["contributed"] == pytest.approx(300000 + 60 * 10000)
    # released at the start of withdrawals, never before
    w = S.run(state, [], book, horizon_months=60, sims=10,
              withdrawals={"start_month": 36, "annual": 1000, "growth": 0.0, "until_month": 60})
    assert d.SEG_EPF in w["years"][2]["by_key_p50"] and d.SEG_EPF not in w["years"][4]["by_key_p50"]
    assert w["years"][4]["by_key_p50"][A.MF_DEBT] > epf[3]
    # an EPF SIP plan is not counted again when EPF is averaged from the ledger
    plan = {"id": 1, "segment": d.SEG_EPF, "instrument_id": 9, "amount": 5000, "frequency": "monthly", "day_of_month": 1,
            "active": 1, "start_date": "2026-01-01"}
    assert S.flows_from_sips([plan], state=state, today=TODAY, horizon_months=24) == []


def test_after_tax_is_never_above_pre_tax():
    state, sips, book = full_fixture()
    flows = S.flows_from_sips(sips, state=state, today=TODAY, horizon_months=120)
    pre = S.run(state, flows, book, horizon_months=120, sims=300)
    post = S.run(state, flows, book, horizon_months=120, sims=300, after_tax=True, slab_rate=0.30)
    at, end = post["after_tax"], pre["years"][-1]
    assert at["p10"] <= end["p10"] and at["p50"] <= end["p50"] and at["p90"] <= end["p90"]
    assert at["p50"] < end["p50"] and at["note"] == "at today's rules; surcharge not modelled"
    assert post["years"][-1]["p50"] < end["p50"]          # FD and P2P accrue net of slab tax
    assert pre["after_tax"] is None
    # nothing to tax: an all-NPS state pays no capital-gains tax
    nps = S.build_state([eq(1, 100000, d.SEG_NPS, 50000)], book=book, today=TODAY)
    rn = S.run(nps, [], book, horizon_months=60, sims=100, after_tax=True)
    assert rn["after_tax"]["p50"] == pytest.approx(rn["years"][-1]["p50"], abs=0.01)


def test_speed_budget(capsys):
    """K8/D18: one run of the budget fixture (30 years, 1,000 sims, all six stochastic keys, ladders, EPF, three SIP
    plans) within the 2.5 s hard limit (target ≤ 1.0 s); the after-tax timing is reported alongside."""
    state, sips, book = full_fixture()
    flows = S.flows_from_sips(sips, state=state, today=TODAY, horizon_months=360)
    t0 = time.perf_counter()
    r = S.run(state, flows, book, horizon_months=360, sims=1000, after_tax=False)
    plain = time.perf_counter() - t0
    t0 = time.perf_counter()
    S.run(state, flows, book, horizon_months=360, sims=1000, after_tax=True)
    taxed = time.perf_counter() - t0
    with capsys.disabled():
        print(f"\n[simulate budget] {r['steps']} steps × 1,000 sims: {plain:.3f}s; with after_tax: {taxed:.3f}s")
    assert r["steps"] == 24 + (360 - 24) // 3 == 136
    assert len([k for k, v in state["values"].items() if v > 0]) == 6
    assert plain <= 2.5
    assert taxed <= 2.5


# ── K8 additions ──

def test_every_path_is_linear_in_its_flows():
    """run(2F) − run(F) = run(F) − run(0) on every path within ₹1, with ladders, routing and the glide on."""
    state, sips, book = full_fixture()
    flows = S.flows_from_sips(sips, state=state, today=TODAY, horizon_months=180)
    double = [dict(f, months={m: 2 * a for m, a in f["months"].items()}) for f in flows]
    kw = dict(horizon_months=180, sims=200, glide={"current_age": 40}, sample_months=[60, 180], keep_paths=True)
    r0, r1, r2 = (S.run(state, fl, book, **kw) for fl in ([], flows, double))
    for m in (60, 180):
        t0, t1, t2 = (r["paths"][m]["total"] for r in (r0, r1, r2))
        assert all(abs((c - b) - (b - a)) < 1 for a, b, c in zip(t0, t1, t2))
        assert r1["paths"][m]["state"] == pytest.approx(t0, abs=1e-6)     # the state part ignores the flows
    assert r1["no_flow_p50"] == r0["no_flow_p50"]
    # the probe layer is exactly the flows' part of each path, on the same draws, and never in the totals
    rp = S.run(state, [], book, probe=flows, **kw)
    for m in (60, 180):
        assert rp["paths"][m]["total"] == r0["paths"][m]["total"]
        got = rp["paths"][m]["probe"]
        want = [b - a for a, b in zip(r0["paths"][m]["total"], r1["paths"][m]["total"])]
        assert all(abs(x - y) < 0.01 for x, y in zip(got, want))


def test_crn_holds_across_horizons():
    """The first 120 months of a 360-month run equal a 120-month run: the grid and the draws share their prefix."""
    state, sips, book = full_fixture()
    short = S.run(state, S.flows_from_sips(sips, state=state, today=TODAY, horizon_months=120), book, horizon_months=120, sims=200)
    long = S.run(state, S.flows_from_sips(sips, state=state, today=TODAY, horizon_months=360), book, horizon_months=360, sims=200)
    assert long["grid"][:len(short["grid"])] == short["grid"]
    for a, b in zip(short["years"], long["years"][:11]):
        assert a == b
    # and across key sets: adding a commodity holding leaves the Indian-equity path untouched
    book = flat_book(0.10, 0.15)
    one = S.build_state([eq(1, 100000)], book=book, today=TODAY)
    two = S.build_state([eq(1, 100000), eq(2, 50000, d.SEG_COMMODITY)], book=book, today=TODAY)
    ra, rb = S.run(one, [], book, horizon_months=60, sims=200), S.run(two, [], book, horizon_months=60, sims=200)
    assert [y["by_key_p50"][d.SEG_EQ_IN] for y in ra["years"]] == [y["by_key_p50"][d.SEG_EQ_IN] for y in rb["years"]]


def test_pairs_are_antithetic():
    """Simulation 2j+1 uses −z of 2j, so with no flows their log-growths average to the drift exactly."""
    book = flat_book(0.12, 0.20)
    state = one_key_state(1000.0)
    r = S.run(state, [], book, horizon_months=36, sims=6, sample_months=[36], keep_paths=True)
    paths = r["paths"][36]["total"]
    drift = (math.log(1.12) - 0.02) * 3
    for j in range(3):
        a, b = paths[2 * j], paths[2 * j + 1]
        assert math.log(a / 1000) + math.log(b / 1000) == pytest.approx(2 * drift, abs=1e-9)
        assert a != b
    assert S.run(state, [], book, horizon_months=12, sims=5)["sims"] == 6   # rounded up to even


def test_cholesky_of_the_stochastic_block_is_positive_definite():
    """N3: the 6×6 stochastic block of CORR needs no repair; its smallest pivot is > 0."""
    low, pivot = S.stochastic_cholesky()
    assert pivot > 0 and len(low) == 6
    block = [[A.CORR[a][b] for b in S.STOCH] for a in S.STOCH]
    for i in range(6):
        for j in range(6):
            assert sum(low[i][k] * low[j][k] for k in range(6)) == pytest.approx(block[i][j], abs=1e-12)
    with pytest.raises(ValueError):
        S.cholesky([[1.0, 2.0], [2.0, 1.0]])


def test_step_grid_monthly_then_quarterly_then_yearly_in_drawdown():
    assert S.grid(30) == list(range(25)) + [27, 30]
    g = S.grid(300, start_month=120)
    assert g[:25] == list(range(25)) and g[25:33] == [27, 30, 33, 36, 39, 42, 45, 48]
    assert g[g.index(120):] == [120, 132, 144, 156, 168, 180, 192, 204, 216, 228, 240, 252, 264, 276, 288, 300]
    assert S.grid(121)[-2:] == [120, 121]                    # the last step may be shorter


def test_withdrawals_deplete_and_the_annuity_offsets_them():
    book = flat_book(0.08, 0.15)
    rich = S.build_state([eq(1, 5e7, d.SEG_MF)], book=book, today=TODAY)
    w = {"start_month": 12, "annual": 500000, "growth": 0.06, "until_month": 312}
    r = S.run(rich, [], book, horizon_months=312, sims=200, withdrawals=w)
    assert r["depletion"]["lasts_pct"] == 100 and all(a is None for a in r["depletion"]["ages"])
    poor = S.build_state([eq(1, 2e6, d.SEG_MF), eq(2, 1e6, d.SEG_NPS)], book=book, today=TODAY)
    rp = S.run(poor, [], book, horizon_months=312, sims=200, withdrawals=w)
    dep = [a for a in rp["depletion"]["ages"] if a is not None]
    assert rp["depletion"]["lasts_pct"] < 50 and dep == sorted(dep) and all((a - 12) % 12 == 0 for a in dep)
    assert rp["years"][-1]["p50"] == 0
    # 40% of NPS buys an annuity: its 6% income offsets each withdrawal, so on the same draws the money lasts at
    # least as long as the same carve-out with no income (vs keeping the NPS money invested at ~8% it can be worse)
    ra = S.run(poor, [], book, horizon_months=312, sims=200, withdrawals={**w, "annuity": {"share": 0.4, "rate": 0.06}})
    r0 = S.run(poor, [], book, horizon_months=312, sims=200, withdrawals={**w, "annuity": {"share": 0.4, "rate": 0.0}})
    assert ra["annuity"]["income_p50"] > 0 and r0["annuity"]["income_p50"] == 0
    assert all((a or 10 ** 6) >= (b or 10 ** 6) for a, b in zip(sorted(ra["depletion"]["ages"], key=lambda x: x or 10 ** 6),
                                                              sorted(r0["depletion"]["ages"], key=lambda x: x or 10 ** 6)))
    assert sum(a or 999 for a in ra["depletion"]["ages"]) > sum(a or 999 for a in r0["depletion"]["ages"])


def test_glide_trims_equity_and_never_buys_it():
    book = flat_book(0.10, 0.0, **{A.MF_DEBT: (0.07, 0.0), d.SEG_FD: (0.07, 0.0)})
    state = S.build_state([eq(1, 800000), eq(2, 200000, d.SEG_MF, category="Debt: Gilt", tax_class=d.TAX_DEBT)],
                          book=book, today=TODAY)
    r = S.run(state, [], book, horizon_months=240, sims=10, glide={"current_age": 50, "start_age": 45, "floor": 0.30, "step": 0.05})

    def share(y):
        bk = r["years"][y]["by_key_p50"]
        return bk.get(d.SEG_EQ_IN, 0) / sum(bk.values())

    shares = [share(y) for y in range(21)]
    assert shares[1] == pytest.approx(0.80 * 1 - 0.05, abs=0.002)            # e₀ = 80%, one step down
    assert shares[5] == pytest.approx(0.55, abs=0.002) and shares[-1] == pytest.approx(0.30, abs=0.002)   # the floor
    assert all(b <= a + 1e-6 for a, b in zip(shares[1:], shares[2:]))   # by_key values are rounded to paise
    assert r["years"][-1]["by_key_p50"][d.SEG_FD] > 0                         # half of each trim goes to an FD pool
    # a portfolio already below the floor is never pushed up
    low = S.build_state([eq(1, 100000), eq(2, 900000, d.SEG_MF, category="Debt: Gilt", tax_class=d.TAX_DEBT)],
                        book=book, today=TODAY)
    rl = S.run(low, [], book, horizon_months=60, sims=10, glide={"current_age": 50})
    assert d.SEG_FD not in rl["years"][-1]["by_key_p50"]


def test_goals_come_from_the_same_draws():
    book = flat_book(0.11, 0.18)
    state = one_key_state(500000.0)
    flows = S.lump_flow(10000, state=state, today=TODAY, horizon_months=120)
    goal = {"id": 7, "alloc": {d.SEG_EQ_IN: 1.0}, "target": 2e6, "month": 120, "flows": [0]}
    r = S.run(state, flows, book, horizon_months=120, sims=400, goals=[goal], sample_months=[120])
    g = r["goals"][0]
    # the goal owns everything here, so it is exactly the portfolio
    assert g["p50"] == pytest.approx(r["years"][-1]["p50"], abs=0.01)
    assert g["probability"] == round(sum(1 for v in r["at"][120] if v >= 2e6) / 400 * 100, 1)
    half = S.run(state, flows, book, horizon_months=120, sims=400, goals=[{**goal, "alloc": {d.SEG_EQ_IN: 0.5}, "flows": []}])
    assert half["goals"][0]["p50"] == pytest.approx(r["no_flow_p50"][-1] / 2, abs=0.01)   # both rounded to paise
    # a goal-only flow counts for the goal, not for the totals
    only = [dict(flows[0], goal_only=True)]
    ro = S.run(state, only, book, horizon_months=120, sims=400, goals=[goal])
    assert ro["years"][-1]["p50"] == r["no_flow_p50"][-1] and ro["goals"][0]["p50"] == pytest.approx(g["p50"], abs=0.01)


def test_shock_hits_values_at_time_zero():
    book = flat_book(0.10, 0.15)
    state = S.build_state([eq(1, 100000), eq(2, 100000, d.SEG_COMMODITY)], book=book, today=TODAY)
    r = S.run(state, [], book, horizon_months=24, sims=100, shock={d.SEG_EQ_IN: -0.4})
    assert r["years"][0]["p50"] == 160000 and r["years"][0]["by_key_p50"][d.SEG_EQ_IN] == 60000
    base = S.run(state, [], book, horizon_months=24, sims=100)
    assert all(a <= b for a, b in zip(bands(r)[-1], bands(base)[-1]))


def test_p2p_ladder_pays_emis_and_a_defaulted_loan_releases_nothing():
    book = flat_book(0.10, 0.0, **{d.SEG_P2P: (0.09, 0.0)})
    loan = {"id": 1, "asset_class": d.P2P, "segment": d.SEG_P2P, "name": "L", "value": 12000, "outstanding": 12000, "rate": 12.0,
            "maturity_date": "2027-11-14", "is_open": True}
    big = eq(2, 1e6)
    state = S.build_state([loan, big], book=book, today=TODAY)
    assert state["loans"][0]["months"] == 12
    r = S.run(state, [], book, horizon_months=24, sims=10)
    # 12 EMIs of a 1%-a-month loan with the expected loss each month; P2P (1.2% of the total) is re-lent under the 10% cap
    assert r["routes"] == [] and r["years"][1]["by_key_p50"][d.SEG_P2P] > 12000
    # P2P is over 10% of the total: receipts go to debt funds, until the loan has amortised under the cap and the
    # rest is re-lent; what was routed plus what was re-lent is the loan's principal and interest less the loss
    capped = S.build_state([loan, eq(2, 10000)], book=book, today=TODAY)
    rc = S.run(capped, [], book, horizon_months=24, sims=10)
    got = sum(x["amount"] for x in rc["routes"])
    relent = rc["years"][1]["by_key_p50"].get(d.SEG_P2P, 0)
    assert rc["routes"] and all(x["from"] == d.SEG_P2P and x["to"] == A.MF_DEBT for x in rc["routes"])
    assert got > 0.75 * 12000 and 12000 < got + relent < 12000 * 1.07
    bad = S.build_state([dict(loan, status="defaulted"), big], book=book, today=TODAY)
    rb = S.run(bad, [], book, horizon_months=24, sims=10)
    assert rb["routes"] == [] and rb["years"][-1]["by_key_p50"][d.SEG_P2P] == 12000


def test_flows_from_sips_land_on_their_due_dates():
    state = S.build_state([eq(1, 100000), eq(2, 50000, d.SEG_MF, category="Equity")], book=flat_book(), today=TODAY)
    q = {"id": 1, "instrument_id": 2, "amount": 9000, "frequency": "quarterly", "day_of_month": 20, "active": 1,
         "start_date": "2026-02-20"}
    w = {"id": 2, "segment": d.SEG_EQ_IN, "amount": 1000, "frequency": "weekly", "day_of_month": 1, "active": 1,
         "start_date": "2026-11-16", "goal_id": 4}
    fq, fw = S.flows_from_sips([q, w], state=state, today=TODAY, horizon_months=12)
    assert fq["key"] == d.SEG_MF and sorted(fq["months"]) == [1, 4, 7, 10]             # Nov, Feb, May, Aug
    assert fw["key"] == d.SEG_EQ_IN and fw["goal_id"] == 4 and sum(fw["months"].values()) == 1000 * 52
    stop = S.flows_from_sips([q], state=state, today=TODAY, horizon_months=12, stop_month=5)
    assert sorted(stop[0]["months"]) == [1, 4]
    lump = S.lump_flow(10000, state=state, step_up_pct=10, today=TODAY, horizon_months=24)
    shares = {f["key"]: f["months"][1] for f in lump}
    assert shares == pytest.approx({d.SEG_EQ_IN: 10000 * 2 / 3, d.SEG_MF: 10000 / 3})
    assert sum(f["months"][13] for f in lump) == pytest.approx(11000)
    assert S.lump_flow(5000, state=S.build_state([], book=flat_book(), today=TODAY), today=TODAY, horizon_months=3)[0]["key"] == d.SEG_MF


def test_milestones_real_and_the_result_shape():
    state, sips, book = full_fixture()
    flows = S.flows_from_sips(sips, state=state, today=TODAY, horizon_months=120)
    r = S.run(state, flows, book, horizon_months=120, sims=200, milestones=[1e6, 5e6, 1e9])
    ms = {m["amount"]: m for m in r["milestones"]}
    assert ms[1e6]["probability"] == 100 and ms[1e6]["median_months"] == 0       # already there today
    assert ms[1e9]["probability"] == 0 and ms[1e9]["median_months"] is None
    assert ms[5e6]["median_months"] in r["grid"]                                  # step resolution (D18)
    assert {"years", "expected", "no_flow_p50", "milestones", "prob_below_contributed_3y", "max_drawdown_p50", "at",
            "depletion", "goals", "after_tax", "sims", "seed", "steps", "notes"} <= set(r)
    real = S.run(state, flows, book, horizon_months=120, sims=200, real=True, inflation=0.06)
    assert real["years"][-1]["p50"] == pytest.approx(r["years"][-1]["p50"] / 1.06 ** 10, rel=1e-9)
    assert real["years"][0]["p50"] == r["years"][0]["p50"]


def test_epf_monthly_average_is_per_calendar_month():
    rows = [{"date": "2026-06-30", "type": d.BUY, "amount": 9000},                  # outside 120 days
            {"date": "2026-08-31", "type": d.BUY, "amount": 3000}, {"date": "2026-08-31", "type": d.BUY, "amount": 1500},
            {"date": "2026-09-30", "type": d.BUY, "amount": 4500}, {"date": "2026-10-31", "type": d.BUY, "amount": 6000},
            {"date": "2026-12-01", "type": d.BUY, "amount": 99999},                 # future-dated
            {"date": "2026-10-31", "type": d.CREDIT, "amount": 7777}]
    assert S.epf_monthly_average(rows, TODAY) == pytest.approx((4500 + 4500 + 6000) / 3)
    assert S.epf_monthly_average([], TODAY) is None
