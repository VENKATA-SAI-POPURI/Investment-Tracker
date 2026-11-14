"""`analytics/scenarios.py`: the PlanScenario contract, compare columns and sensitivities (SPEC §6.10; AMENDMENTS
R5–R7). Pure: synthetic ports, no database, no Flask."""
from datetime import date

import pytest

from tracker import domain as d
from tracker.analytics import assumptions as A
from tracker.analytics import forecast
from tracker.analytics import scenarios as sc

TODAY = date(2026, 11, 14)

# R5's shared fixtures: W7-B2's planScenarios validator must agree on every one of them
FIXTURE = {"name": "Retire at 55", "sip": 60000, "step": 10, "return": None, "retire_age": 55,
           "lump_sums": [{"date": "2030-01-01", "amount": 500000}], "inflation_pct": 7, "mix": None}
REJECT = [
    ({"name": ""}, "name"),
    ({"name": "x" * 41}, "name"),
    ({"sip": -1}, "sip"),
    ({"step": 51}, "step"),
    ({"return": 31}, "return"),
    ({"retire_age": 14.5}, "retire_age"),
    ({"lump_sums": [{"date": "2030-01-01", "amount": 1}] * 11}, "lump_sums"),
    ({"lump_sums": [{"date": "2030-01-01", "amount": -1}]}, "lump_sums[0].amount"),
    ({"inflation_pct": 16}, "inflation_pct"),
    ({"mix": {"Equity (India)": 60, "Fixed Deposits": 39}}, "mix"),
    ({"mix": {"Gold": 100}}, "mix"),
    # beyond the shared list
    ({"name": "   "}, "name"),
    ({"sip": "60000"}, "sip"),
    ({"return": -10.5}, "return"),
    ({"retire_age": 55.5}, "retire_age"),
    ({"lump_sums": [{"date": "01/01/2030", "amount": 1}]}, "lump_sums[0].date"),
    ({"lump_sums": {"date": "2030-01-01"}}, "lump_sums"),
    ({"mix": {"Equity (India)": 101}}, "mix"),
    ({"mix": [100]}, "mix"),
    ({"sip": True}, "sip"),
]


# ── the validator (R5) ──

def test_the_shared_fixture_is_accepted_and_normalised():
    got = sc.validate_scenario({**FIXTURE, "name": "  Retire at 55  ", "colour": "red"})
    assert got == {"name": "Retire at 55", "sip": 60000.0, "step": 10.0, "return": None, "retire_age": 55,
                   "lump_sums": [{"date": "2030-01-01", "amount": 500000.0}], "inflation_pct": 7.0, "mix": None}
    assert isinstance(got["retire_age"], int)
    lean = sc.validate_scenario({"name": "Lean", "sip": 0, "step": 0,
                                 "mix": {"Equity (India)": 60.2, "Fixed Deposits": 39.5}})
    assert lean["lump_sums"] == [] and lean["return"] is None and lean["mix"] == {"Equity (India)": 60.2,
                                                                                    "Fixed Deposits": 39.5}


@pytest.mark.parametrize("change, field", REJECT)
def test_the_shared_rejections(change, field):
    for partial in (False, True):
        with pytest.raises(sc.ScenarioError) as e:
            sc.validate_scenario({**FIXTURE, **change}, partial=partial)
        assert e.value.field == field and str(e.value).startswith(f"{field} "), str(e.value)


def test_saved_lists_name_the_entry_and_cap_at_five():
    assert sc.validate_saved(None) == [] and len(sc.validate_saved([FIXTURE] * 5)) == 5
    with pytest.raises(sc.ScenarioError) as e:
        sc.validate_saved([FIXTURE] * 6)
    assert "5" in str(e.value)
    with pytest.raises(sc.ScenarioError) as e:
        sc.validate_saved([FIXTURE, {**FIXTURE, "step": 51}])
    assert str(e.value).startswith("Scenario 2: step ") and e.value.index == 1
    with pytest.raises(sc.ScenarioError):
        sc.validate_saved(FIXTURE)
    for missing in ("name", "sip", "step"):          # a saved entry needs these three
        with pytest.raises(sc.ScenarioError) as e:
            sc.validate_scenario({k: v for k, v in FIXTURE.items() if k != missing})
        assert e.value.field == missing


def test_inline_scenarios_are_partial_and_resolve_from_the_baseline():
    empty = sc.validate_scenario({}, partial=True)
    assert empty == {f: None for f in sc.FIELDS}
    base = sc.baseline({"monthly_sip": 20000, "step_up_pct": 5, "retire_age": 58, "current_age": 35}, 12000)
    assert base == {"name": "Today's plan", "sip": 20000.0, "step": 5.0, "return": None, "retire_age": 58,
                    "lump_sums": [], "inflation_pct": None, "mix": None}
    r = sc.resolve(empty, base, 3)
    assert r == {**base, "name": "Scenario 3"} and sc.flows_unchanged(r, base)
    assert not sc.flows_unchanged(sc.resolve({"sip": 25000}, base, 1), base)
    # without a typed SIP the plans' total is today's plan; no retirement plan → no retire age
    assert sc.baseline(None, 12000.456)["sip"] == 12000.46 and sc.baseline({}, 0)["retire_age"] is None
    assert sc.typed_sip({"monthly_sip": 0}) and not sc.typed_sip({"monthly_sip": ""}) and not sc.typed_sip(None)
    # equal mixes key equal however they were written
    a = sc.compute_key({**base, "mix": {"Fixed Deposits": 40.0, "Equity (India)": 60.0, "EPF": 0}})
    b = sc.compute_key({**base, "mix": {"Equity (India)": 60, "Fixed Deposits": 40}})
    assert a == b and "name" not in a


def test_horizon_is_shared_and_clamped():
    goals = [{"target_date": "2041-06-01"}, {"target_date": "2020-01-01"}]
    assert sc.horizon_years([{"retire_age": None}], saved=None, goals=[], today=TODAY) == 10
    assert sc.horizon_years([{"retire_age": None}], saved=None, goals=goals, today=TODAY) == 15
    saved = {"current_age": 35, "retire_age": 55}
    assert sc.horizon_years([{"retire_age": 55}, {"retire_age": 60}], saved=saved, goals=goals, today=TODAY) == 25
    assert sc.horizon_years([{"retire_age": 100}], saved={"current_age": 20}, goals=[], today=TODAY) == 40


def test_sensitivity_scenarios_and_labels():
    base = sc.baseline({"monthly_sip": 120000, "retire_age": 55, "current_age": 35}, 0)
    items = sc.sensitivity_scenarios(base, saved={"retire_age": 55}, requested_return_pct=10.37, inflation_pct=6)
    s = {i["key"]: i for i in items}
    assert list(s) == ["sip", "retire", "returns", "inflation"]
    assert s["sip"]["change"] == 12000 and s["sip"]["label"] == "SIP +₹12,000/month"
    assert s["sip"]["scenario"]["sip"] == 132000
    assert s["retire"]["scenario"]["retire_age"] == 57 and s["retire"]["change"] == 2
    assert s["returns"]["scenario"]["return"] == 9.4 and s["returns"]["change"] == -1
    assert s["inflation"]["scenario"]["inflation_pct"] == 7 and s["inflation"]["change"] == 1
    small = sc.sensitivity_scenarios(sc.baseline(None, 3000), saved=None, requested_return_pct=9.0, inflation_pct=6)
    assert small[0]["change"] == 5000 and small[0]["label"] == "SIP +₹5,000/month"
    assert small[1]["scenario"] == sc.baseline(None, 3000)          # no retirement plan: the baseline
    for i in items + small:                                           # every scenario is valid as a saved one
        sc.validate_scenario({**i["scenario"], "name": i["label"]})
    assert sc.inr(150000) == "₹1,50,000" and sc.inr(5000) == "₹5,000" and sc.inr(-12345678) == "−₹1,23,45,678"


# ── columns on common random numbers (R6) ──

def _port():
    pos = [{"id": 1, "asset_class": d.EQUITY, "segment": d.SEG_EQ_IN, "name": "Eq", "value": 600000, "cost": 500000,
            "is_open": True},
           {"id": 2, "asset_class": d.MUTUAL_FUND, "segment": d.SEG_MF, "name": "Flexi", "category": "Equity: Flexi Cap",
            "tax_class": d.TAX_EQUITY, "value": 300000, "cost": 250000, "is_open": True},
           {"id": 3, "asset_class": d.FIXED_DEPOSIT, "segment": d.SEG_FD, "name": "FD", "value": 300000, "rate": 7.0,
            "maturity_date": "2029-03-01", "maturity_value": 360000, "is_open": True}]
    segs = [{"segment": d.SEG_EQ_IN, "value": 600000}, {"segment": d.SEG_MF, "value": 300000},
            {"segment": d.SEG_FD, "value": 300000}]
    return {"totals": {"value": 1.2e6}, "segments": segs, "positions": pos}


SIPS = [{"id": 7, "name": "Flexi SIP", "instrument_id": 2, "amount": 15000, "frequency": "monthly", "day_of_month": 5,
         "active": 1, "start_date": "2025-01-05", "step_up_pct": 0, "goal_id": None}]
GOALS = [{"id": 11, "name": "House", "target_amount": 3_000_000, "target_date": "2034-06-01", "monthly_contribution": 10000,
          "allocation": {d.SEG_EQ_IN: 50, d.SEG_MF: 50}},
         {"id": 12, "name": "Car", "target_amount": 900_000, "target_date": "2029-01-01", "monthly_contribution": 0,
          "allocation": {d.SEG_FD: 100}}]


def _inp(saved=None, goals=GOALS, sips=SIPS):
    return {"port": _port(), "perf": None, "sips": sips, "txns": [], "instruments": [], "targets": None,
            "slab_rate": 0.30, "book": A.effective_book(None), "today": TODAY, "saved": saved, "funding": None,
            "goals": goals, "inflation": None}


def _compare(inp, *inline, sims=400):
    base = sc.baseline(inp["saved"], forecast.monthly_sip_total(inp["sips"], TODAY))
    cols_sc = [base, *[sc.resolve(sc.validate_scenario(x, partial=True), base, n) for n, x in enumerate(inline, 1)]]
    years = sc.horizon_years(cols_sc, saved=inp["saved"], goals=inp["goals"], today=TODAY)
    cols = [sc.run_column(c, base, inp, years=years, sims=sims) for c in cols_sc]
    return sc.build_compare(cols_sc, cols, goals=inp["goals"], years=years, sims=sims, today=TODAY,
                            honesty=forecast._honesty(sims))


SAVED = {"current_age": 35, "retire_age": 55, "monthly_expenses": 60000, "monthly_sip": 40000}


@pytest.mark.parametrize("saved", [None, SAVED, {k: v for k, v in SAVED.items() if k != "monthly_sip"}])
def test_the_baseline_against_itself_gives_exact_zero_deltas(saved):
    inp = _inp(saved)
    base = sc.baseline(saved, forecast.monthly_sip_total(SIPS, TODAY))
    c = _compare(inp, dict(base), {}, {"name": "Copy", "sip": base["sip"], "step": base["step"]})
    keys = [r["key"] for r in c["rows"]]
    assert keys[:3] == ["p10", "p50", "p90"]
    assert ("retirement" in keys) == (saved is not None)
    assert [k for k in keys if k.startswith("goal:")] == ["goal:11", "goal:12"] or \
        [k for k in keys if k.startswith("goal:")] == ["goal:12", "goal:11"]
    for r in c["rows"]:
        assert r["deltas"] == [0, 0, 0, 0], r
    assert c["paths"][1]["p50"] == c["paths"][0]["p50"]


def test_goal_rows_are_worst_baseline_first():
    c = _compare(_inp())
    goal_rows = [r for r in c["rows"] if r["key"].startswith("goal:")]
    assert [r["values"][0] for r in goal_rows] == sorted(r["values"][0] for r in goal_rows)
    assert {r["label"] for r in goal_rows} == {"House", "Car"}


def test_a_higher_sip_never_hurts_any_row_crn():
    c = _compare(_inp(SAVED), {"sip": 60000}, {"sip": 80000, "name": "Even more"})
    for r in c["rows"]:
        if r["key"] in ("needed", "retire_age"):
            continue
        assert r["deltas"][1] >= 0 and r["deltas"][2] >= r["deltas"][1] - 1e-6, r
    assert {r["key"]: r for r in c["rows"]}["p50"]["deltas"][2] > 0
    house = next(r for r in c["rows"] if r["key"] == "goal:11")
    assert house["deltas"][2] >= house["deltas"][1] >= 0          # goal flows scale with sip / baseline sip


def test_retiring_later_and_the_other_levers():
    c = {r["key"]: r for r in _compare(_inp(SAVED), {"retire_age": 58}, {"return": 6},
                                         {"inflation_pct": 8}, {"lump_sums": [{"date": "2028-01-01", "amount": 1e6}]},
                                         sims=300)["rows"]}
    assert c["retire_age"]["values"][:2] == [55, 58]
    assert c["retirement"]["deltas"][1] >= 0
    assert c["p50"]["deltas"][2] < 0 and c["retirement"]["deltas"][2] <= 0     # lower returns
    assert c["retirement"]["deltas"][3] <= 0 and c["p50"]["deltas"][3] == 0     # inflation moves only the need
    assert c["p50"]["deltas"][4] > 1e6 and c["retirement"]["deltas"][4] >= 0    # a ₹10 L lump sum


def test_a_mix_equal_to_today_gives_zero_deltas_and_a_new_mix_moves():
    inp = _inp(SAVED)
    cur = sc.current_mix(inp["port"])
    assert cur == pytest.approx({d.SEG_EQ_IN: 50.0, d.SEG_MF: 25.0, d.SEG_FD: 25.0})
    c = _compare(inp, {"mix": cur}, {"mix": {d.SEG_FD: 50, d.SEG_EQ_IN: 25, d.SEG_MF: 25}},
                 {"mix": {d.SEG_EQ_IN: 50, d.SEG_MF: 25, d.SEG_FD: 15, d.SEG_COMMODITY: 10}, "sip": 50000})
    for r in c["rows"]:
        if r["deltas"][1] is None:
            continue
        assert abs(r["deltas"][1]) <= (1.0 if r["format"] in ("inr", "age") else 0.1), r
    rows = {r["key"]: r for r in c["rows"]}
    assert rows["p50"]["deltas"][2] < 0                            # more FD, less equity
    assert rows["p50"]["deltas"][3] != 0                           # a new class held at 0 and a changed SIP


def test_mix_port_scales_positions_and_adds_a_pseudo_position():
    port = _port()
    out = sc.mix_port(port, {d.SEG_EQ_IN: 40, d.SEG_FD: 40, d.SEG_COMMODITY: 20})
    by = {p["name"]: p for p in out["positions"]}
    assert by["Eq"]["value"] == pytest.approx(480000) and by["Eq"]["cost"] == pytest.approx(400000)
    assert by["Flexi"]["value"] == 0
    assert by["FD"]["value"] == pytest.approx(480000) and by["FD"]["maturity_value"] == pytest.approx(576000)
    gold = by[f"{d.SEG_COMMODITY} (proposed)"]
    assert gold["value"] == pytest.approx(240000) and gold["asset_class"] == d.COMMODITY
    assert sum(p["value"] for p in out["positions"]) == pytest.approx(1.2e6)
    assert port["positions"][0]["value"] == 600000                 # the input is never changed
    w = sc.mix_weights({d.SEG_EQ_IN: 50, d.SEG_MF: 50}, port["positions"])
    assert w == pytest.approx({d.SEG_EQ_IN: 0.5, d.SEG_MF: 0.5})


def test_sensitivities_read_the_retirement_and_worst_goal_deltas():
    inp = _inp(SAVED)
    base = sc.baseline(SAVED, forecast.monthly_sip_total(SIPS, TODAY))
    items = sc.sensitivity_scenarios(base, saved=SAVED, requested_return_pct=10.0, inflation_pct=6.0)
    cols_sc = [base, *[i["scenario"] for i in items]]
    years = sc.horizon_years(cols_sc, saved=SAVED, goals=GOALS, today=TODAY)
    cols = [sc.run_column(c, base, inp, years=years, sims=300) for c in cols_sc]
    cmp = sc.build_compare(cols_sc, cols, goals=GOALS, years=years, sims=300, today=TODAY, honesty={})
    out = {s["key"]: s for s in sc.sensitivities(items, cmp, retirement_saved=True)}
    assert out["sip"]["retirement_pts"] >= 0 and out["sip"]["worst_goal_pts"] >= 0
    assert out["returns"]["retirement_pts"] <= 0 and out["inflation"]["retirement_pts"] <= 0
    assert out["retire"]["retirement_pts"] >= 0
    rows = {r["key"]: r for r in cmp["rows"]}
    worst = next(r for r in cmp["rows"] if r["key"].startswith("goal:"))
    assert out["sip"]["retirement_pts"] == rows["retirement"]["deltas"][1]
    assert out["returns"]["worst_goal_pts"] == worst["deltas"][3]
    none = sc.sensitivities(items, {"rows": cmp["rows"][:3]}, retirement_saved=False)
    assert all(s["retirement_pts"] is None and s["worst_goal_pts"] is None for s in none)
    # the payload names the goal its worst_goal_pts belongs to, so the client never guesses it (W7 review fixes)
    assert all(s["worst_goal"] == {"id": int(worst["key"][5:]), "name": worst["label"]} for s in out.values())
    assert all(s["worst_goal"] is None for s in none)


# ── a changed SIP over the plans keeps their shape (W7 review fixes, amending R5) ──

# today's plan runs on the plans (no typed monthly_sip): two stepped-up plans, one linked to House and one ending,
# and one that starts next year (outside the baseline sip, which counts the plans running today)
STEP_SIPS = [
    {"id": 7, "name": "Flexi SIP", "instrument_id": 2, "amount": 15000, "frequency": "monthly", "day_of_month": 5,
     "active": 1, "start_date": "2025-01-05", "step_up_pct": 10, "goal_id": 11},
    {"id": 8, "name": "Index SIP", "instrument_id": 2, "amount": 15000, "frequency": "monthly", "day_of_month": 10,
     "active": 1, "start_date": "2024-04-10", "end_date": "2031-12-10", "step_up_pct": 10, "goal_id": None},
    {"id": 9, "name": "Later SIP", "instrument_id": 2, "amount": 5000, "frequency": "monthly", "day_of_month": 1,
     "active": 1, "start_date": "2027-06-01", "step_up_pct": 0, "goal_id": None},
]
UNTYPED = {"current_age": 35, "retire_age": 55, "monthly_expenses": 60000}


def test_a_higher_sip_over_stepped_up_plans_never_hurts():
    inp = _inp(UNTYPED, sips=STEP_SIPS)
    base = sc.baseline(UNTYPED, forecast.monthly_sip_total(STEP_SIPS, TODAY))
    assert base["sip"] == 30000 and base["step"] == 0 and not sc.typed_sip(UNTYPED)
    bump = sc.sip_bump(base["sip"])
    c = _compare(inp, {"sip": base["sip"] + bump}, {"sip": base["sip"] + 2 * bump}, {"step": 5})
    for r in c["rows"]:
        if r["key"] in ("needed", "retire_age"):
            continue
        assert r["deltas"][1] >= 0 and r["deltas"][2] >= r["deltas"][1] - 1e-6, r
        assert r["deltas"][3] >= 0, r                                  # a faster step-up on top of the plans'
    rows = {r["key"]: r for r in c["rows"]}
    assert rows["p50"]["deltas"][1] > 0 and rows["p50"]["deltas"][3] > 0
    # the sip sensitivity reads the same way (the tile that ranked a higher SIP below today's plan)
    items = sc.sensitivity_scenarios(base, saved=UNTYPED, requested_return_pct=10.0, inflation_pct=6.0)
    cols_sc = [base, *[i["scenario"] for i in items]]
    years = sc.horizon_years(cols_sc, saved=UNTYPED, goals=GOALS, today=TODAY)
    cols = [sc.run_column(x, base, inp, years=years, sims=300) for x in cols_sc]
    cmp = sc.build_compare(cols_sc, cols, goals=GOALS, years=years, sims=300, today=TODAY, honesty={})
    sip = next(s for s in sc.sensitivities(items, cmp, retirement_saved=True) if s["key"] == "sip")
    assert sip["retirement_pts"] >= 0 and sip["worst_goal_pts"] >= 0


def test_a_changed_sip_scales_the_plans_flows():
    inp = _inp(UNTYPED, sips=STEP_SIPS)
    base = sc.baseline(UNTYPED, 30000)
    up = sc.resolve(sc.validate_scenario({"sip": 45000}, partial=True), base, 1)
    assert sc.plans_adjust(up, base, inp) == {"scale": 1.5, "step_pct": 0.0}
    assert sc.plans_adjust(base, base, inp) is None                         # unchanged flows
    assert sc.plans_adjust(up, base, _inp(SAVED, sips=STEP_SIPS)) is None    # a typed SIP stays one amount (L5)
    assert sc.plans_adjust(up, sc.baseline(UNTYPED, 0), inp) is None         # nothing runs today
    step = sc.resolve(sc.validate_scenario({"step": 10}, partial=True), base, 1)
    assert sc.plans_adjust(step, base, inp)["step_pct"] == pytest.approx(10.0)
    # projection: contributions × 1.5, each plan on its own dates (the ended plan stays ended)
    plain = forecast.project_portfolio(inp["port"], None, years=10, monthly_sip=None, sims=200, today=TODAY,
                                       sips=STEP_SIPS)
    more = forecast.project_portfolio(inp["port"], None, years=10, monthly_sip=None, sims=200, today=TODAY,
                                      sips=STEP_SIPS, plans_scale=1.5)
    added = plain["end"]["contributed"] - plain["path"][0]["contributed"]
    assert more["end"]["contributed"] - more["path"][0]["contributed"] == pytest.approx(added * 1.5, rel=1e-4)
    assert more["flows_basis"] == "plans" and more["monthly_sip"] == 45000
    # the helper: scale, a step from today, and a re-split by weights
    flows = [{"key": d.SEG_MF, "months": {1: 100.0, 13: 110.0}, "id": 7, "goal_id": None, "label": "x"}]
    out = sc.S.adjust_flows(flows, scale=2.0, step_up_pct=10)
    assert out[0]["months"] == pytest.approx({1: 200.0, 13: 242.0}) and flows[0]["months"][1] == 100.0
    split = sc.S.adjust_flows(flows, weights={d.SEG_EQ_IN: 3, d.SEG_FD: 1})
    assert {f["key"]: f["months"][1] for f in split} == pytest.approx({d.SEG_EQ_IN: 75.0, d.SEG_FD: 25.0})


def test_a_sip_within_a_rupee_of_the_baseline_is_the_baseline():
    weekly = [{**SIPS[0], "amount": 1000, "frequency": "weekly"}]
    inp = _inp(UNTYPED, sips=weekly)
    base = sc.baseline(UNTYPED, forecast.monthly_sip_total(weekly, TODAY))
    assert base["sip"] == 4333.33
    c = _compare(inp, {"sip": 4333, "retire_age": 57}, {"sip": 4333})
    assert sc.flows_unchanged({"sip": 4333, "step": 0}, base)
    for r in c["rows"]:
        if r["key"] in ("retire_age", "retirement", "lasts", "needed"):
            continue
        assert r["deltas"][1] == 0 and r["deltas"][2] == 0, r


# ── the engine arguments compare relies on (R4, R6) ──

def test_extra_flows_and_the_base_book_in_the_engines():
    port = _port()
    plain = forecast.project_portfolio(port, None, years=10, monthly_sip=10000, sims=300, today=TODAY)
    same = forecast.project_portfolio(port, None, years=10, monthly_sip=10000, sims=300, today=TODAY,
                                      book=A.effective_book(None))
    assert same["end"] == plain["end"] and same["assumptions"] == plain["assumptions"]
    lump = forecast.project_portfolio(port, None, years=10, monthly_sip=10000, sims=300, today=TODAY,
                                      extra_flows=[{"date": "2027-06-01", "amount": 200000},
                                                   {"date": "2050-01-01", "amount": 9e8},     # past the horizon
                                                   {"date": "2020-01-01", "amount": 9e8}])    # in the past
    assert lump["end"]["contributed"] == pytest.approx(plain["end"]["contributed"] + 200000)
    assert lump["end"]["p10"] > plain["end"]["p10"] and lump["end"]["p50"] > plain["end"]["p50"]
    book = A.effective_book(None)
    hot = {**book, "segments": {**book["segments"],
                                d.SEG_EQ_IN: {**book["segments"][d.SEG_EQ_IN], "return_pct": 16.0}}}
    up = forecast.project_portfolio(port, None, years=10, monthly_sip=10000, sims=300, today=TODAY, book=hot)
    assert up["end"]["p50"] > plain["end"]["p50"] and up["assumptions"]["hash"] != plain["assumptions"]["hash"]
    ret = forecast.retirement_plan(port, None, SAVED, today=TODAY, sims=300)
    ret_lump = forecast.retirement_plan(port, None, SAVED, today=TODAY, sims=300,
                                        extra_flows=[{"date": "2028-01-01", "amount": 500000}])
    assert ret_lump["projected"] > ret["projected"] and ret_lump["probability"] >= ret["probability"]
    assert ret_lump["required_sip"] <= ret["required_sip"]
    cool = {**book, "inflation_pct": 8.0}
    assert forecast.retirement_plan(port, None, SAVED, today=TODAY, sims=0, book=cool)["corpus_needed"] > \
        forecast.retirement_plan(port, None, SAVED, today=TODAY, sims=0)["corpus_needed"]
