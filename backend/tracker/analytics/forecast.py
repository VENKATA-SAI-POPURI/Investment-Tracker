"""Forward-looking analysis: portfolio projection with SIPs, stress tests, a retirement planner and
the expected cash flows of the next twelve months.

Projections are Monte Carlo over monthly log-normal returns. The drift and volatility blend the
long-run assumptions per segment (goals.ASSUMPTIONS) with the portfolio's own record once there is
enough of it. Every number here is an estimate under stated assumptions, never a promise.
"""
from __future__ import annotations

import math
import random
from collections import defaultdict
from datetime import date, timedelta

from .. import domain as d
from .goals import ASSUMPTIONS
from .portfolio import _f, to_date

INFLATION = 0.06
MAX_YEARS = 40
MILESTONES = [1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2e7, 3e7, 5e7, 1e8, 2e8, 5e8]

# Segment shocks (fraction of value) for stress scenarios, loosely modelled on past episodes
STRESS_SCENARIOS = [
    {"key": "correction", "label": "Market correction", "note": "A routine 10% fall in Indian equity; the kind that happens most years.",
     "shocks": {d.SEG_EQ_IN: -0.10, d.SEG_EQ_US: -0.08, d.SEG_MF: -0.08, d.SEG_NPS: -0.05, d.SEG_COMMODITY: 0.02}},
    {"key": "covid", "label": "2020 Covid crash", "note": "Feb–Mar 2020: Nifty −38%, S&P −34%, gold flat, then a sharp recovery.",
     "shocks": {d.SEG_EQ_IN: -0.38, d.SEG_EQ_US: -0.30, d.SEG_MF: -0.33, d.SEG_NPS: -0.20, d.SEG_COMMODITY: 0.0, d.SEG_P2P: -0.05}},
    {"key": "gfc", "label": "2008 financial crisis", "note": "2008: Nifty −52%, S&P −38% (rupee fell too), gold +25%.",
     "shocks": {d.SEG_EQ_IN: -0.52, d.SEG_EQ_US: -0.30, d.SEG_MF: -0.48, d.SEG_NPS: -0.28, d.SEG_COMMODITY: 0.25, d.SEG_P2P: -0.10}},
    {"key": "rates", "label": "Rate shock", "note": "2022-style: equity −15%, US tech harder hit, gold −5%; FDs and EPF unaffected.",
     "shocks": {d.SEG_EQ_IN: -0.15, d.SEG_EQ_US: -0.25, d.SEG_MF: -0.14, d.SEG_NPS: -0.08, d.SEG_COMMODITY: -0.05}},
    {"key": "rupee", "label": "Rupee falls 10%", "note": "Only the dollar assets move: US stocks and the USD wallet gain in rupee terms.",
     "shocks": {d.SEG_EQ_US: 0.10, d.SEG_COMMODITY: 0.08}},
    {"key": "gold", "label": "Gold slides 20%", "note": "A commodity-only shock, as in 2013.",
     "shocks": {d.SEG_COMMODITY: -0.20}},
    {"key": "p2p", "label": "P2P defaults double", "note": "One in five rupees lent is not repaid.",
     "shocks": {d.SEG_P2P: -0.20}},
]

RECOVERY_RATE = {d.SEG_EQ_IN: 0.12, d.SEG_EQ_US: 0.11, d.SEG_MF: 0.11, d.SEG_NPS: 0.10, d.SEG_COMMODITY: 0.08}


def _pct(v, n=1):
    return None if v is None else round(v * 100, n)


def _fmt_inr(v: float) -> str:
    a = abs(v)
    if a >= 1e7:
        return f"₹{v / 1e7:g} crore" if (v / 1e7) == round(v / 1e7, 2) else f"₹{v / 1e7:.2f} crore"
    if a >= 1e5:
        return f"₹{round(v / 1e5, 1):g} lakh"
    return f"₹{v:,.0f}"


def blended_assumptions(segments: list[dict], perf_metrics: dict | None = None) -> dict:
    """Expected annual return and volatility for the whole portfolio.

    Starts from the segment assumptions weighted by current value. Once the portfolio has two or
    more years of history, its own annualised time-weighted return and volatility pull the numbers
    30% of the way towards what actually happened (clamped so one great year is not extrapolated).
    """
    seg_val = {s["segment"]: float(s.get("value") or 0) for s in segments}
    total = sum(v for v in seg_val.values() if v > 0)
    if total <= 0:
        mu, sigma = 0.10, 0.12
        mix = {}
    else:
        mix = {k: v / total for k, v in seg_val.items() if v > 0}
        mu = sum(ASSUMPTIONS.get(k, (0.10, 0.12))[0] * w for k, w in mix.items())
        # assume mild positive correlation across risky segments: volatility adds at 70% of the simple sum
        sigma = 0.7 * sum(ASSUMPTIONS.get(k, (0.10, 0.12))[1] * w for k, w in mix.items()) \
            + 0.3 * math.sqrt(sum((ASSUMPTIONS.get(k, (0.10, 0.12))[1] * w) ** 2 for k, w in mix.items()))
    basis = "segment mix"
    own_mu = own_sigma = None
    m = perf_metrics or {}
    if m.get("days") and m["days"] >= 730 and m.get("twr_annualised") is not None and m.get("volatility") is not None:
        own_mu = max(min(m["twr_annualised"] / 100, 0.25), -0.05)
        own_sigma = max(min(m["volatility"] / 100, 0.35), 0.02)
        mu = 0.7 * mu + 0.3 * own_mu
        sigma = 0.7 * sigma + 0.3 * own_sigma
        basis = "segment mix blended with your record"
    return {"mu": mu, "sigma": max(sigma, 0.02), "basis": basis, "mix": mix,
            "own": {"return_pct": _pct(own_mu), "volatility_pct": _pct(own_sigma)} if own_mu is not None else None}


def _fv(pv: float, sip: float, mu: float, months: int, step_up: float = 0.0) -> float:
    rm = (1 + mu) ** (1 / 12) - 1
    v, s = pv, sip
    for k in range(months):
        if k and k % 12 == 0:
            s *= 1 + step_up
        v = v * (1 + rm) + s
    return v


def project_portfolio(port: dict, perf_metrics: dict | None, years: int = 10, monthly_sip: float = 0.0,
                      step_up_pct: float = 0.0, sims: int = 2000, today: date | None = None,
                      return_override: float | None = None) -> dict:
    """Monte Carlo fan chart of the portfolio's value with monthly contributions.

    Returns yearly percentile bands (p10/p25/p50/p75/p90), the deterministic expected path, the
    money contributed, milestone probabilities, bull/base/bear end values and the real (inflation-
    adjusted) value of the median outcome.
    """
    today = today or date.today()
    years = max(1, min(int(years), MAX_YEARS))
    sims = max(200, min(int(sims), 5000))
    current = float(port["totals"]["value"] or 0)
    a = blended_assumptions(port["segments"], perf_metrics)
    mu, sigma = a["mu"], a["sigma"]
    if return_override is not None:
        mu = max(min(float(return_override) / 100, 0.30), -0.10)
    step = max(min(float(step_up_pct or 0) / 100, 0.5), 0.0)
    sip = max(float(monthly_sip or 0), 0.0)
    months = years * 12
    m_mu = math.log(1 + mu) / 12 - sigma * sigma / 24
    m_sd = sigma / math.sqrt(12)

    rng = random.Random(42)
    yearly: list[list[float]] = [[] for _ in range(years + 1)]
    first_cross: dict[float, list[int]] = defaultdict(list)
    targets = [m for m in MILESTONES if m > current * 1.05]
    for _ in range(sims):
        v, s = current, sip
        crossed = set()
        yearly[0].append(v)
        for k in range(1, months + 1):
            if k > 1 and (k - 1) % 12 == 0:
                s *= 1 + step
            v = v * math.exp(rng.gauss(m_mu, m_sd)) + s
            for t in targets:
                if t not in crossed and v >= t:
                    crossed.add(t)
                    first_cross[t].append(k)
            if k % 12 == 0:
                yearly[k // 12].append(v)

    def q(xs: list[float], p: float) -> float:
        xs = sorted(xs)
        k = (len(xs) - 1) * p
        f, c = math.floor(k), math.ceil(k)
        return xs[f] if f == c else xs[f] * (c - k) + xs[c] * (k - f)

    path = []
    contributed = current
    for y in range(years + 1):
        if y:
            contributed += 12 * sip * (1 + step) ** (y - 1)
        xs = yearly[y]
        path.append({"year": today.year + y, "date": date(today.year + y, today.month, 1).isoformat(),
                     "p10": round(q(xs, 0.10), 2), "p25": round(q(xs, 0.25), 2), "p50": round(q(xs, 0.50), 2),
                     "p75": round(q(xs, 0.75), 2), "p90": round(q(xs, 0.90), 2),
                     "expected": round(_fv(current, sip, mu, y * 12, step), 2), "contributed": round(contributed, 2)})

    end = path[-1]
    milestones = []
    for t in targets:
        hits = first_cross.get(t, [])
        prob = len(hits) / sims
        if prob < 0.02:
            continue
        med = sorted(hits)[len(hits) // 2]
        if prob > 0.995 and med <= 18 and len(targets) > 3:
            continue  # all but certain within a year and a half: not worth a line
        milestones.append({"amount": t, "label": _fmt_inr(t), "probability": round(prob * 100, 1),
                           "median_months": med, "median_year": today.year + (today.month - 1 + med) // 12})
        if len(milestones) >= 5:
            break

    scen = {k: round(_fv(current, sip, max(mu + dm, -0.5), months, step), 2)
            for k, dm in (("bear", -0.04), ("base", 0.0), ("bull", 0.04))}
    scen["no_more_investing"] = round(_fv(current, 0.0, mu, months, 0.0), 2)
    return {
        "years": years, "sims": sims, "current": round(current, 2), "monthly_sip": sip, "step_up_pct": round(step * 100, 1),
        "assumptions": {"return_pct": round(mu * 100, 2), "volatility_pct": round(sigma * 100, 2), "basis": a["basis"],
                        "inflation_pct": round(INFLATION * 100, 1), "own": a["own"],
                        "mix": [{"segment": k, "weight_pct": round(w * 100, 1), "return_pct": round(ASSUMPTIONS.get(k, (0.10, 0.12))[0] * 100, 1),
                                 "volatility_pct": round(ASSUMPTIONS.get(k, (0.10, 0.12))[1] * 100, 1)} for k, w in sorted(a["mix"].items(), key=lambda kv: -kv[1])]},
        "path": path,
        "end": {"p10": end["p10"], "p50": end["p50"], "p90": end["p90"], "expected": end["expected"], "contributed": end["contributed"],
                "real_p50": round(end["p50"] / (1 + INFLATION) ** years, 2),
                "gain_p50": round(end["p50"] - end["contributed"], 2),
                "probability_of_loss": round(sum(1 for v in yearly[years] if v < end["contributed"]) / sims * 100, 1)},
        "scenarios": scen, "milestones": milestones,
    }


def stress_test(port: dict, monthly_sip: float = 0.0) -> dict:
    """What each scenario would do to today's value, segment by segment, and how long a recovery
    at long-run returns (plus the current SIP) would take."""
    segs = {s["segment"]: float(s.get("value") or 0) for s in port["segments"]}
    total = sum(v for v in segs.values() if v > 0)
    out = []
    for sc in STRESS_SCENARIOS:
        rows, impact = [], 0.0
        for seg, val in segs.items():
            if val <= 0:
                continue
            shock = sc["shocks"].get(seg, 0.0)
            amt = val * shock
            impact += amt
            if shock:
                rows.append({"segment": seg, "value": round(val, 2), "shock_pct": round(shock * 100, 1), "impact": round(amt, 2)})
        rows.sort(key=lambda r: r["impact"])
        after = total + impact
        months = None
        if impact < 0 and total > 0:
            # recover with the hit segments growing at their long-run rate and SIPs continuing
            rate = sum((RECOVERY_RATE.get(seg, 0.07)) * max(segs[seg] + segs[seg] * sc["shocks"].get(seg, 0), 0)
                       for seg in segs if segs[seg] > 0) / max(after, 1)
            rm = (1 + rate) ** (1 / 12) - 1
            v, months = after, 0
            while v < total and months < 240:
                v = v * (1 + rm) + monthly_sip
                months += 1
            if v < total:
                months = None
        out.append({**{k: sc[k] for k in ("key", "label", "note")}, "impact": round(impact, 2),
                    "impact_pct": round(impact / total * 100, 2) if total else 0.0, "after": round(after, 2),
                    "recovery_months": months, "rows": rows})
    worst = min(out, key=lambda s: s["impact"]) if out else None
    exposed = sum(v for k, v in segs.items() if k in RECOVERY_RATE and v > 0)
    return {"total": round(total, 2), "market_exposed_pct": round(exposed / total * 100, 1) if total else 0.0,
            "scenarios": out, "worst": worst["key"] if worst else None,
            "note": "Shocks are applied to today's values by asset class. Recovery assumes long-run returns on what is left plus your current SIP; "
                    "real recoveries are faster or slower than that."}


def retirement_plan(port: dict, perf_metrics: dict | None, params: dict, today: date | None = None, sims: int = 1000) -> dict:
    """Corpus needed, projected corpus, required SIP, FIRE number and a year-by-year path through retirement."""
    today = today or date.today()
    p = {"current_age": 30, "retire_age": 60, "life_expectancy": 85, "monthly_expenses": 50000.0, "inflation_pct": INFLATION * 100,
         "post_return_pct": 7.0, "monthly_sip": 0.0, "step_up_pct": 0.0, "return_pct": None, "other_income_monthly": 0.0}
    for k, v in (params or {}).items():
        if k in p and v not in (None, ""):
            p[k] = float(v)
    cur_age, ret_age, life = int(p["current_age"]), int(p["retire_age"]), int(p["life_expectancy"])
    ret_age = max(ret_age, cur_age)
    life = max(life, ret_age + 1)
    yrs = ret_age - cur_age
    ret_years = life - ret_age
    infl = p["inflation_pct"] / 100
    post = p["post_return_pct"] / 100
    a = blended_assumptions(port["segments"], perf_metrics)
    mu = p["return_pct"] / 100 if p["return_pct"] is not None else a["mu"]
    sigma = a["sigma"]
    current = float(port["totals"]["value"] or 0)
    sip, step = p["monthly_sip"], p["step_up_pct"] / 100
    annual_exp_today = p["monthly_expenses"] * 12
    other = p["other_income_monthly"] * 12
    net_annual_today = max(annual_exp_today - other, 0.0)
    annual_at_ret = net_annual_today * (1 + infl) ** yrs

    # corpus at retirement that funds inflation-growing expenses for ret_years at the post-retirement return
    real = (1 + post) / (1 + infl) - 1
    corpus_needed = annual_at_ret * ((1 - (1 + real) ** -ret_years) / real if abs(real) > 1e-9 else ret_years)
    projected = _fv(current, sip, mu, yrs * 12, step)
    gap = corpus_needed - projected

    # required SIP (with the same step-up) by bisection
    required = 0.0
    if yrs > 0 and _fv(current, 0.0, mu, yrs * 12, step) < corpus_needed:
        lo, hi = 0.0, max(sip, 1000.0)
        while _fv(current, hi, mu, yrs * 12, step) < corpus_needed and hi < 1e9:
            hi *= 2
        for _ in range(60):
            mid = (lo + hi) / 2
            if _fv(current, mid, mu, yrs * 12, step) < corpus_needed:
                lo = mid
            else:
                hi = mid
        required = hi

    # Monte Carlo on the accumulation phase (yearly steps)
    prob = None
    if yrs > 0 and sims:
        rng = random.Random(7)
        y_mu = math.log(1 + mu) - sigma * sigma / 2
        hits = 0
        for _ in range(sims):
            v, s = current, sip
            for y in range(yrs):
                v = v * math.exp(rng.gauss(y_mu, sigma)) + s * 12
                s *= 1 + step
            hits += v >= corpus_needed
        prob = hits / sims * 100
    elif yrs == 0:
        prob = 100.0 if current >= corpus_needed else 0.0

    # FIRE: the corpus that could fund today's expenses indefinitely at a 3.5% real withdrawal rate
    fire_number = net_annual_today / 0.035
    fire_year = None
    v, s = current, sip
    for y in range(0, MAX_YEARS + 1):
        if v >= fire_number * (1 + infl) ** y:
            fire_year = y
            break
        v = v * (1 + mu) + s * 12
        s *= 1 + step
    coast_now = corpus_needed / (1 + mu) ** yrs if yrs > 0 else corpus_needed

    # year-by-year path: accumulation then drawdown
    path, v, s = [], current, sip
    exp_year = net_annual_today
    ran_out = None
    for age in range(cur_age, life + 1):
        phase = "saving" if age < ret_age else "retired"
        path.append({"age": age, "year": today.year + (age - cur_age), "phase": phase, "corpus": round(max(v, 0.0), 2),
                     "expenses": round(exp_year if phase == "retired" else 0.0, 2)})
        if phase == "saving":
            v = v * (1 + mu) + s * 12
            s *= 1 + step
        else:
            v = (v - exp_year) * (1 + post)
            if v <= 0 and ran_out is None:
                ran_out = age + 1
        exp_year *= 1 + infl
    status = "on_track" if gap <= 0 else "at_risk" if projected >= corpus_needed * 0.75 else "off_track"
    return {
        "inputs": {**p, "current_age": cur_age, "retire_age": ret_age, "life_expectancy": life, "return_pct": round(mu * 100, 2),
                   "volatility_pct": round(sigma * 100, 2), "return_basis": "your input" if p["return_pct"] is not None else a["basis"]},
        "years_to_retire": yrs, "retirement_years": ret_years, "current": round(current, 2),
        "monthly_expenses_at_retirement": round(annual_at_ret / 12, 2), "corpus_needed": round(corpus_needed, 2),
        "projected": round(projected, 2), "gap": round(gap, 2), "required_sip": round(required, 2),
        "probability": round(prob, 1) if prob is not None else None, "status": status,
        "fire": {"number": round(fire_number, 2), "progress_pct": round(min(current / fire_number * 100, 100), 1) if fire_number else None,
                 "years_to_fi": fire_year, "fi_age": cur_age + fire_year if fire_year is not None else None,
                 "coast_amount_now": round(coast_now, 2), "coasting": current >= coast_now},
        "runs_out_at": ran_out, "path": path,
        "note": "Expenses grow with inflation; the corpus earns the post-retirement return once you stop working. "
                "The FIRE number assumes a 3.5% real withdrawal rate, the conservative end for Indian inflation.",
    }


def _month_add(y: int, m: int, k: int) -> tuple[int, int]:
    t = y * 12 + (m - 1) + k
    return t // 12, t % 12 + 1


def cash_flow_forecast(positions: list[dict], instruments: list[dict], txns: list[dict], sips: list[dict],
                       months: int = 12, today: date | None = None) -> dict:
    """Expected money in and out over the coming months, from what the ledger already knows.

    Dividends and FD interest payouts repeat the pattern of the last twelve months; P2P loans amortise
    to maturity; FDs pay out their maturity value; EPF interest lands for the financial year end;
    SIP plans go out on their day. Only open holdings count.
    """
    today = today or date.today()
    months = max(1, min(int(months), 36))
    pos_by_id = {p["id"]: p for p in positions}
    by_inst: dict[int, list[dict]] = defaultdict(list)
    for t in txns:
        by_inst[t["instrument_id"]].append(t)
    keys = [_month_add(today.year, today.month, k) for k in range(months)]
    rows = {f"{y}-{m:02d}": {"month": f"{y}-{m:02d}", "dividends": 0.0, "interest": 0.0, "principal_back": 0.0,
                             "epf_interest": 0.0, "sip_out": 0.0, "contributions": 0.0} for y, m in keys}
    events = []
    since = (today - timedelta(days=365)).isoformat()
    horizon_end = date(*_month_add(today.year, today.month, months), 1)

    for inst in instruments:
        p = pos_by_id.get(inst["id"])
        if not p or not p.get("is_open"):
            continue
        ts = by_inst.get(inst["id"], [])
        ac = inst["asset_class"]
        if ac in (d.EQUITY, d.MUTUAL_FUND, d.FIXED_DEPOSIT):
            # payouts repeat the calendar pattern of the past year
            kind = d.DIVIDEND if ac != d.FIXED_DEPOSIT else d.INTEREST
            by_month = defaultdict(float)
            for t in ts:
                if t["type"] == kind and since <= str(t["date"])[:10] <= today.isoformat():
                    by_month[int(str(t["date"])[5:7])] += _f(t["amount"])
            for y, m in keys:
                if by_month.get(m):
                    rows[f"{y}-{m:02d}"]["dividends" if kind == d.DIVIDEND else "interest"] += by_month[m]
        if ac == d.FIXED_DEPOSIT and inst.get("maturity_date") and today.isoformat() <= inst["maturity_date"] < horizon_end.isoformat():
            mv = _f(p.get("maturity_value")) or _f(p.get("value"))
            principal = _f(p.get("invested"))
            key = inst["maturity_date"][:7]
            if key in rows:
                rows[key]["principal_back"] += principal
                rows[key]["interest"] += max(mv - principal - _f(p.get("income")), 0.0)
            events.append({"date": inst["maturity_date"], "kind": "fd_maturity", "name": inst["name"], "amount": round(mv, 2),
                           "note": f"FD matures: {_fmt_inr(mv)} back", "instrument_id": inst["id"]})
        elif ac == d.P2P:
            out = _f(p.get("outstanding"))
            mat = inst.get("maturity_date")
            if out <= 0 or (inst.get("status") or "") in ("closed", "defaulted"):
                continue
            if mat and mat < today.isoformat():
                events.append({"date": mat, "kind": "p2p_overdue", "name": inst["name"], "amount": round(out, 2),
                               "note": f"Loan past maturity with {_fmt_inr(out)} outstanding", "instrument_id": inst["id"]})
                continue
            end = to_date(mat) if mat else today + timedelta(days=30 * int(_f(inst.get("tenure_months")) or 12))
            remaining = max((end.year - today.year) * 12 + (end.month - today.month), 1)
            rate = _f(inst.get("rate")) / 100 / 12
            emi = out * rate / (1 - (1 + rate) ** -remaining) if rate else out / remaining
            bal = out
            for k, (y, m) in enumerate(keys):
                if k >= remaining or bal <= 0:
                    break
                interest = bal * rate
                principal = min(emi - interest, bal)
                bal -= principal
                rows[f"{y}-{m:02d}"]["principal_back"] += principal
                rows[f"{y}-{m:02d}"]["interest"] += interest
            if remaining <= months:
                events.append({"date": end.isoformat(), "kind": "p2p_close", "name": inst["name"], "amount": round(out, 2),
                               "note": "Loan fully repaid", "instrument_id": inst["id"]})
        elif ac == d.EPF:
            bal = _f(p.get("value"))
            rate = _f(p.get("rate")) or 8.25
            fy_end_year = today.year if today.month <= 3 else today.year + 1
            key = f"{fy_end_year}-03"
            if key in rows:
                rows[key]["epf_interest"] += bal * rate / 100
            # monthly contribution: the average of the last three months with a contribution
            recent = [_f(t["amount"]) for t in ts if t["type"] == d.BUY and str(t["date"])[:10] >= (today - timedelta(days=120)).isoformat()]
            if recent:
                monthly = sum(recent[-3:]) / min(len(recent), 3)
                for y, m in keys:
                    rows[f"{y}-{m:02d}"]["contributions"] += monthly

    for s in sips:
        if not s.get("active", 1):
            continue
        amt = _f(s.get("amount"))
        freq = (s.get("frequency") or "monthly").lower()
        per_month = {"monthly": 1, "quarterly": 1 / 3, "weekly": 52 / 12, "yearly": 1 / 12}.get(freq, 1)
        start, end = s.get("start_date"), s.get("end_date")
        step = _f(s.get("step_up_pct")) / 100
        for y, m in keys:
            key = f"{y}-{m:02d}"
            if (start and key < start[:7]) or (end and key > end[:7]):
                continue
            years_in = max((y - int(start[:4])) if start else 0, 0)
            rows[key]["sip_out"] += amt * per_month * (1 + step) ** years_in

    # many small P2P loans would swamp the list: fold loan events into one line per month
    folded: dict[tuple[str, str], dict] = {}
    singles = []
    for e in events:
        if e["kind"] in ("p2p_close", "p2p_overdue"):
            k = (e["kind"], e["date"][:7])
            f = folded.setdefault(k, {"date": e["date"][:7] + "-01", "kind": e["kind"], "name": "", "amount": 0.0, "count": 0,
                                      "note": "", "instrument_id": None})
            f["amount"] += e["amount"]
            f["count"] += 1
            f["date"] = max(f["date"], e["date"]) if e["kind"] == "p2p_close" else min(f["date"], e["date"])
        else:
            singles.append(e)
    for f in folded.values():
        n = f["count"]
        f["name"] = f"{n} P2P loan{'s' if n > 1 else ''}"
        f["amount"] = round(f["amount"], 2)
        f["note"] = (f"finish repaying this month, {_fmt_inr(f['amount'])} of principal in all" if f["kind"] == "p2p_close"
                     else f"past maturity with {_fmt_inr(f['amount'])} still outstanding")
    events = singles + list(folded.values())

    out_rows = []
    for key in sorted(rows):
        r = {k: round(v, 2) if isinstance(v, float) else v for k, v in rows[key].items()}
        r["inflow"] = round(r["dividends"] + r["interest"] + r["principal_back"], 2)
        r["outflow"] = round(r["sip_out"] + r["contributions"], 2)
        r["net"] = round(r["inflow"] - r["outflow"], 2)
        out_rows.append(r)
    tot = {k: round(sum(r[k] for r in out_rows), 2) for k in ("dividends", "interest", "principal_back", "epf_interest", "sip_out", "contributions", "inflow", "outflow", "net")}
    events.sort(key=lambda e: e["date"])
    income = tot["dividends"] + tot["interest"]
    notes = []
    if income:
        notes.append(f"About {_fmt_inr(income)} of passive income is due over the next {months} months, roughly {_fmt_inr(income / months)} a month.")
    if tot["principal_back"]:
        notes.append(f"{_fmt_inr(tot['principal_back'])} of principal comes back (FD maturities and loan repayments): decide where it goes next.")
    if tot["sip_out"]:
        notes.append(f"Your SIP plans send out {_fmt_inr(tot['sip_out'])} in the same period.")
    return {"months": out_rows, "totals": tot, "events": events, "notes": notes,
            "note": "Dividends and interest repeat last year's pattern; loans amortise to maturity; EPF interest is for the financial year "
                    "and stays in the account. Treat these as expectations, not commitments."}
