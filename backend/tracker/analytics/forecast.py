"""Forward-looking analysis: portfolio projection with SIPs, stress tests, a retirement planner and
the expected cash flows of the next twelve months.

Projections and retirement run on the plan engine v2, `simulate.run` (SPEC §6.13 P2, AMENDMENTS K8–K11):
a per-asset-class correlated Monte Carlo with common random numbers, SIPs routed to their own class and
deterministic FD, P2P and EPF ladders. The headline μ and σ still come from `blended_assumptions` (the
Assumption Book over the portfolio's Book keys, blended with the portfolio's own record once there are two
years of it, or a return override); each stochastic class is shifted and scaled so the mix matches them
(K9). Every number here is an estimate under stated assumptions, never a promise.

Every forward payload (projection, retirement, cash flow, stress) carries the §6.0 rule-2 block
(AMENDMENTS G5): `assumptions` {return_pct, typical_pct, volatility_pct, inflation_pct, basis, hash},
`honesty` and `note`. `hash` is `book_hash` of the Book the numbers came from: `rated_book(positions, book)`
when the payload had positions, else the base Book. Every engine takes keyword-only `book=` (AMENDMENTS R4), the
caller's `effective_book(settings)`; None is `effective_book(None)`, so existing calls reproduce their numbers.

Honesty (SPEC §1.9): the median (p50) is "typical", p10/p90 are the 1-in-10 bad and good cases, and the
mean (`expected`) is reported only as the average that the best cases pull up. Probabilities decide
status words (`assumptions.status_for`); a gap at the mean never does.

Imports (AMENDMENTS G3, K8): `assumptions`, `mc`, `plans` and `simulate` at module top, never `goals`.
`simulate` never imports this module.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import date, timedelta

from .. import domain as d
from . import assumptions as A
from . import mc, plans
from . import simulate as S
from .assumptions import book_hash, book_key, effective_book, mu_sigma, rated_book, status_for, typical, weights_from_positions
from .portfolio import EPS, _f, run_fifo, to_date

# Re-exports (AMENDMENTS G4): one source in assumptions / plans, read here by older callers and tests.
INFLATION = A.INFLATION
P2P_LOSS = A.P2P_LOSS
HONESTY = A.HONESTY          # the {sims} template in p50 is formatted per payload
SIP_PER_MONTH = plans.SIP_PER_MONTH
# H16/K8: the one EPF monthly-contribution helper, shared by cash_flow_forecast and simulate's EPF ladder. It lives
# in simulate (which may not import this module) and is re-exported here under the name callers know.
epf_monthly_average = S.epf_monthly_average

MAX_YEARS = 40
MILESTONES = [1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2e7, 3e7, 5e7, 1e8, 2e8, 5e8]
REQUIRED_PROB = 0.75         # retirement's required_sip reaches the corpus in 75 of 100 futures (§6.5)
RETIREMENT_SEED = 7          # §6.0 rule 4
PROJECTION_SEED = 42         # §6.0 rule 4
OWN_RECORD_DAYS = 730        # the portfolio's own record counts from two years of history
OWN_WEIGHT = 0.3             # ... pulling μ and σ 30% of the way towards it
SIGMA_FLOOR = 0.02
DEBT_LABEL = "Mutual Funds (debt)"


def _honesty(sims: int) -> dict:
    """assumptions.HONESTY with p50 formatted for the simulations used."""
    return {**HONESTY, "p50": HONESTY["p50"].format(sims=f"{int(sims or 0):,}")}


# Payloads with no simulated distribution (cash flow, stress) carry only the labels that apply to them.
HONESTY_POINT = {k: HONESTY[k] for k in ("estimate", "disclaimer")}


def monthly_sip_total(sips: list[dict], today: date | None = None) -> float:
    """Monthly equivalent of the SIP plans running today: active, already started (a plan whose
    `start_date` is after today is excluded) and not yet ended."""
    today_s = (today or date.today()).isoformat()
    total = 0.0
    for s in sips:
        if not s.get("active", 1):
            continue
        start, end = str(s.get("start_date") or "")[:10], str(s.get("end_date") or "")[:10]
        if (start and start > today_s) or (end and end < today_s):
            continue
        total += _f(s.get("amount")) * SIP_PER_MONTH.get((s.get("frequency") or "monthly").lower(), 1)
    return round(total, 2)

# Segment shocks (fraction of value) for stress scenarios, loosely modelled on past episodes
STRESS_SCENARIOS = [
    {"key": "correction", "label": "Market correction", "note": "A routine 10% fall in Indian equity; the kind that happens most years.",
     "shocks": {d.SEG_EQ_IN: -0.10, d.SEG_EQ_US: -0.08, d.SEG_MF: -0.08, d.SEG_NPS: -0.05, d.SEG_COMMODITY: 0.02}},
    {"key": "covid", "label": "2020 Covid crash", "note": "Feb–Mar 2020: Nifty −38%, S&P −34%, gold flat, then a sharp recovery.",
     "shocks": {d.SEG_EQ_IN: -0.38, d.SEG_EQ_US: -0.30, d.SEG_MF: -0.33, d.SEG_NPS: -0.20, d.SEG_COMMODITY: 0.0, d.SEG_P2P: -0.05,
                A.MF_DEBT: -0.04}},
    {"key": "gfc", "label": "2008 financial crisis", "note": "2008: Nifty −52%, S&P −38% (rupee fell too), gold +25%.",
     "shocks": {d.SEG_EQ_IN: -0.52, d.SEG_EQ_US: -0.30, d.SEG_MF: -0.48, d.SEG_NPS: -0.28, d.SEG_COMMODITY: 0.25, d.SEG_P2P: -0.10,
                A.MF_DEBT: -0.04}},
    {"key": "rates", "label": "Rate shock", "note": "2022-style: equity −15%, US tech harder hit, gold −5%, debt funds −4%; FDs and EPF unaffected.",
     "shocks": {d.SEG_EQ_IN: -0.15, d.SEG_EQ_US: -0.25, d.SEG_MF: -0.14, d.SEG_NPS: -0.08, d.SEG_COMMODITY: -0.05,
                A.MF_DEBT: -0.04}},
    {"key": "rupee", "label": "Rupee falls 10%", "note": "Only the dollar assets move: US stocks and the USD wallet gain in rupee terms.",
     "shocks": {d.SEG_EQ_US: 0.10, d.SEG_COMMODITY: 0.08}},
    {"key": "gold", "label": "Gold slides 20%", "note": "A commodity-only shock, as in 2013.",
     "shocks": {d.SEG_COMMODITY: -0.20}},
    {"key": "p2p", "label": "P2P defaults double", "note": "One in five rupees lent is not repaid.",
     "shocks": {d.SEG_P2P: -0.20}},
]

# The market-exposed keys (stress `market_exposed_pct`). MF_DEBT is not one of them (G8). Recovery reads each
# key's μ from the Book; this map keeps the old name for those keys and holds the same numbers.
MARKET_KEYS = (d.SEG_EQ_IN, d.SEG_EQ_US, d.SEG_MF, d.SEG_NPS, d.SEG_COMMODITY)
RECOVERY_RATE = {k: A.ASSUMPTIONS[k][0] for k in MARKET_KEYS}


def _pct(v, n=1):
    return None if v is None else round(v * 100, n)


def _fmt_inr(v: float) -> str:
    a = abs(v)
    if a >= 1e7:
        return f"₹{v / 1e7:g} crore" if (v / 1e7) == round(v / 1e7, 2) else f"₹{v / 1e7:.2f} crore"
    if a >= 1e5:
        return f"₹{round(v / 1e5, 1):g} lakh"
    return f"₹{v:,.0f}"


def _base(book: dict | None) -> dict:
    """The base Book an engine reads (AMENDMENTS R4): the caller's `effective_book(settings)`, else the default."""
    return book if book else effective_book(None)


def book_inflation_pct(book: dict | None) -> float:
    """The base Book's inflation in percent (R4: the default wherever the user named none); 6 by default."""
    raw = (book or {}).get("inflation_pct")
    try:
        return float(raw) if raw not in (None, "") else INFLATION * 100
    except (TypeError, ValueError):
        return INFLATION * 100


def _book_inflation(book: dict | None) -> float:
    """The base Book's inflation as a fraction (INFLATION exactly when the Book names none)."""
    raw = (book or {}).get("inflation_pct")
    return INFLATION if raw in (None, "") else book_inflation_pct(book) / 100


def _book_weights(segments: list[dict] | None, positions: list[dict] | None,
                  book: dict | None = None) -> tuple[dict[str, float], dict, str]:
    """(weights over Book keys summing to 1, the Book they are read against, source).

    With open valued positions: `weights_from_positions` (a debt fund lands on MF_DEBT) and
    `rated_book(positions, base)`, source 'holdings'. Otherwise the segment value weights and the base Book,
    source 'segments'. The base Book is `book` (R4: `effective_book(settings)`), else the default Book. A key the
    Book does not know is dropped before normalising, so it never dilutes μ.
    """
    base = _base(book)
    w = {k: v for k, v in (weights_from_positions(positions) if positions else {}).items() if k in A.ASSUMPTIONS}
    if w:
        book, source = rated_book(positions, base), "holdings"
    else:
        book, source = base, "segments"
        for s in segments or []:
            k, v = s.get("segment"), _f(s.get("value"))
            if k in A.ASSUMPTIONS and v > 0:
                w[k] = w.get(k, 0.0) + v
    tot = sum(w.values())
    return ({k: v / tot for k, v in w.items()} if tot > 0 else {}), book, source


def _row_of(book: dict, key: str) -> tuple[float, float]:
    """(μ, σ) of one key in a §6.1-shaped Book, as fractions (the default row when the Book lacks it)."""
    row = (book.get("segments") or {}).get(key)
    if row is None:
        return A.ASSUMPTIONS.get(key, A.ASSUMPTIONS[d.SEG_MF])
    return float(row.get("return_pct") or 0) / 100, float(row.get("vol_pct") or 0) / 100


def _fold(w: dict[str, float]) -> dict[str, float]:
    """Book-key weights reported by segment: MF_DEBT under 'Mutual Funds' (G5)."""
    out: dict[str, float] = {}
    for k, x in w.items():
        seg = d.SEG_MF if k == A.MF_DEBT else k
        out[seg] = out.get(seg, 0.0) + x
    return out


def _mix_rows(w: dict[str, float], book: dict) -> list[dict]:
    """Display rows by segment: weight, and return and volatility as the weighted mean of the keys folded in."""
    acc: dict[str, list[float]] = {}
    for k, x in w.items():
        mu, sg = _row_of(book, k)
        a = acc.setdefault(d.SEG_MF if k == A.MF_DEBT else k, [0.0, 0.0, 0.0])
        a[0] += x
        a[1] += x * mu
        a[2] += x * sg
    rows = [{"segment": seg, "weight_pct": round(x * 100, 1), "return_pct": round(m / x * 100, 1) if x else 0.0,
             "volatility_pct": round(s / x * 100, 1) if x else 0.0} for seg, (x, m, s) in acc.items()]
    return sorted(rows, key=lambda r: -r["weight_pct"])


def _block(mu: float, sigma: float, inflation: float, basis: str, book: dict) -> dict:
    """The §6.0 rule-2 assumptions block (G5)."""
    return {"return_pct": round(mu * 100, 2), "typical_pct": round(typical(mu, sigma) * 100, 2),
            "volatility_pct": round(sigma * 100, 2), "inflation_pct": round(inflation * 100, 2), "basis": basis,
            "hash": book_hash(book)}


def blended_assumptions(segments: list[dict], perf_metrics: dict | None = None, *,
                        positions: list[dict] | None = None, book: dict | None = None) -> dict:
    """Expected annual return (μ) and volatility (σ) for the whole portfolio, from the Assumption Book.

    - μ and σ are `assumptions.mu_sigma` over Book keys: `weights_from_positions(positions)` against
      `rated_book(positions, book)` when positions are given (FD, EPF and P2P at their holding rates, debt funds
      on MF_DEBT), otherwise the segment value weights against the base Book (`book`, R4: the caller's
      `effective_book(settings)`; None = the default Book, so existing calls are unchanged).
    - An empty portfolio is assumed to be a diversified mutual fund (the Book's 'Mutual Funds' row).
    - With two or more years of history (≥ 730 days), the portfolio's own annualised TWR and volatility
      pull both 30% of the way towards what happened, clamped (μ to −5%..25%, σ to 2%..35%) so one great
      year is not extrapolated. σ never goes below 2%.

    Returns {mu, sigma, basis, mix (by segment, MF_DEBT folded into 'Mutual Funds'), weights (Book keys),
    rows (display rows), own, typical_pct, hash, book}.
    """
    w, book, source = _book_weights(segments, positions, book)
    if w:
        mu, sigma = mu_sigma(w, book)
        basis = "holdings mix" if source == "holdings" else "segment mix"
    else:
        mu, sigma = _row_of(book, d.SEG_MF)
        basis = A.NO_HOLDINGS_BASIS
    own_mu = own_sigma = None
    m = perf_metrics or {}
    if m.get("days") and m["days"] >= OWN_RECORD_DAYS and m.get("twr_annualised") is not None and m.get("volatility") is not None:
        own_mu = max(min(m["twr_annualised"] / 100, 0.25), -0.05)
        own_sigma = max(min(m["volatility"] / 100, 0.35), SIGMA_FLOOR)
        mu = (1 - OWN_WEIGHT) * mu + OWN_WEIGHT * own_mu
        sigma = (1 - OWN_WEIGHT) * sigma + OWN_WEIGHT * own_sigma
        basis += " blended with your record"
    sigma = max(sigma, SIGMA_FLOOR)
    return {"mu": mu, "sigma": sigma, "basis": basis, "mix": _fold(w), "weights": w, "rows": _mix_rows(w, book),
            "own": {"return_pct": _pct(own_mu), "volatility_pct": _pct(own_sigma)} if own_mu is not None else None,
            "typical_pct": round(typical(mu, sigma) * 100, 2), "hash": book_hash(book), "book": book}


def _fv(pv: float, sip: float, mu: float, months: int, step_up: float = 0.0) -> float:
    rm = (1 + mu) ** (1 / 12) - 1
    v, s = pv, sip
    for k in range(months):
        if k and k % 12 == 0:
            s *= 1 + step_up
        v = v * (1 + rm) + s
    return v


_SEG_ASSET_CLASS = {d.SEG_EQ_IN: d.EQUITY, d.SEG_EQ_US: d.EQUITY, d.SEG_MF: d.MUTUAL_FUND, d.SEG_COMMODITY: d.COMMODITY,
                    d.SEG_P2P: d.P2P, d.SEG_FD: d.FIXED_DEPOSIT, d.SEG_EPF: d.EPF, d.SEG_NPS: d.NPS}


def _sim_positions(port: dict) -> list[dict]:
    """The positions the simulation starts from: the port's own when any is open and valued; otherwise one
    pseudo-position per valued segment (a segment-only port, as in the tests), so an FD segment accrues at the
    Book's FD rate with no maturity and an EPF segment at the EPF rate."""
    positions = port.get("positions") or []
    if any(p.get("is_open", True) and _f(p.get("value")) > 0 for p in positions):
        return positions
    return [{"id": None, "segment": s["segment"], "asset_class": _SEG_ASSET_CLASS[s["segment"]], "value": _f(s.get("value")),
             "is_open": True} for s in port.get("segments") or [] if s.get("segment") in _SEG_ASSET_CLASS and _f(s.get("value")) > 0]


def _calibrate(book: dict, weights: dict[str, float], mu_star: float, sigma_star: float,
               base: dict | None = None) -> tuple[dict, float, float]:
    """(book', δ, s): the Book with every stochastic key's μ shifted by δ and σ scaled by s, so the mix matches
    the headline (μ*, σ*) from `blended_assumptions` (K9). Ladders keep their rates.

    With (μ_mix, σ_mix) = `mu_sigma(weights, book)` and w_s the stochastic share of the weights:
    δ = (μ* − μ_mix)/w_s clamped to ±0.05 (0 when w_s < 0.05); s = σ*/σ_mix clamped to 0.5–2 (1 when σ_mix = 0).
    With no override and no record blend δ = 0 and s = 1 (unless the σ floor bites). A stochastic key `book`
    lacks takes its row from the base Book (`base`, R4; None = the default Book)."""
    w = weights or A.NO_HOLDINGS_MIX
    mu_mix, sig_mix = mu_sigma(w, book)
    ws = sum(x for k, x in w.items() if k in S.STOCH)
    delta = 0.0 if ws < 0.05 else max(min((mu_star - mu_mix) / ws, 0.05), -0.05)
    scale = 1.0 if sig_mix <= 0 else max(min(sigma_star / sig_mix, 2.0), 0.5)
    default = _base(base)["segments"]
    segs = {k: dict(v) for k, v in (book.get("segments") or {}).items()}
    for k in S.STOCH:
        row = segs.get(k) or dict(default.get(k) or effective_book(None)["segments"][k])
        segs[k] = {**row, "return_pct": float(row.get("return_pct") or 0) + delta * 100,
                   "vol_pct": float(row.get("vol_pct") or 0) * scale}
    return {**book, "segments": segs}, delta, scale


def _simulated_mu(weights: dict[str, float], cal_book: dict, mu_star: float, *, override: bool) -> tuple[float, str | None]:
    """(μ_sim, note): the portfolio return the calibrated simulation actually uses, Σ w_k μ'_k over `cal_book`
    (`mu_sigma`, the same weights `_calibrate` used), and a note when it is not the headline μ* (wave-6 review).

    They differ when δ hit its ±5-point cap, or when under 5% of the money is market-linked (δ = 0), because
    ladders keep their rates. Payloads report μ_sim as `return_pct`, so the copy never names a return that was
    not simulated; `requested_return_pct` keeps μ*. The note is None when the two agree to 0.005 points."""
    mu_sim = mu_sigma(weights or A.NO_HOLDINGS_MIX, cal_book)[0]
    if abs(mu_sim - mu_star) < 5e-5:
        return mu_star, None
    asked = f"Your {round(mu_star * 100, 2):g}% a year" if override else \
        f"The {round(mu_star * 100, 2):g}% a year your record points to"
    return mu_sim, (f"{asked} was limited to {mu_sim * 100:.2f}% for the simulation: it shifts market-linked holdings "
                    "by at most 5 points a year, and FDs, P2P and EPF keep their own rates.")


def _plan_weights(sips: list[dict], state: dict, today: date) -> dict[str, float] | None:
    """{key: monthly equivalent} of the plans running today, by the Book key each invests in (K9 'mix' split);
    an EPF plan is left out when EPF is averaged from the ledger. None when nothing is running."""
    w: dict[str, float] = {}
    today_s = today.isoformat()
    for s in sips or []:
        if not s.get("active", 1) or _f(s.get("amount")) <= 0:
            continue
        start, end = str(s.get("start_date") or "")[:10], str(s.get("end_date") or "")[:10]
        if (start and start > today_s) or (end and end < today_s):
            continue
        key = S.plan_key(s, state)
        if key == d.SEG_EPF and (state.get("epf") or {}).get("from_ledger"):
            continue
        w[key] = w.get(key, 0.0) + _f(s.get("amount")) * SIP_PER_MONTH.get((s.get("frequency") or "monthly").lower(), 1)
    return w or None


def _extra_flows(extra, *, state: dict, today: date, horizon_months: int,
                 weights: dict[str, float] | None) -> list[dict]:
    """One-off flows (AMENDMENTS R6 `extra_flows` [{date, amount}]) routed like the SIP they ride with: split over
    `weights` ({key: share}), else pro rata over today's market-linked value. A lump dated on or before today, or
    past the horizon, is ignored; a non-positive amount or an unreadable date is skipped. One flow per key."""
    w = {k: float(x) for k, x in (weights or S.stochastic_weights(state)).items() if x and float(x) > 0}
    tot = sum(w.values())
    if tot <= 0:
        w, tot = {d.SEG_MF: 1.0}, 1.0
    by_key: dict[str, dict[int, float]] = {}
    for item in extra or []:
        day = S._date((item or {}).get("date"))
        amt = _f((item or {}).get("amount"))
        if day is None or amt <= 0:
            continue
        m = S.month_index(today, day)
        if not 1 <= m <= int(horizon_months):
            continue
        for k, x in w.items():
            months = by_key.setdefault(k, {})
            months[m] = months.get(m, 0.0) + amt * x / tot
    return [{"key": k, "months": months, "id": None, "goal_id": None, "label": "lump sum"} for k, months in by_key.items()]


def _extra_fv(extra, *, today: date, mu: float, months: int) -> float:
    """The deterministic value after `months` of the lump sums dated inside them, each compounded monthly at μ."""
    rm = (1 + mu) ** (1 / 12) - 1
    out = 0.0
    for item in extra or []:
        day = S._date((item or {}).get("date"))
        amt = _f((item or {}).get("amount"))
        if day is None or amt <= 0:
            continue
        m = S.month_index(today, day)
        if 1 <= m <= months:
            out += amt * (1 + rm) ** (months - m)
    return out


def project_portfolio(port: dict, perf_metrics: dict | None, years: int = 10, monthly_sip: float | None = 0.0,
                      step_up_pct: float = 0.0, sims: int = 2000, today: date | None = None,
                      return_override: float | None = None, *, inflation: float | None = None, sips: list[dict] | None = None,
                      txns: list[dict] | None = None, instruments: list[dict] | None = None, targets: dict | None = None,
                      after_tax: bool = False, slab_rate: float = 0.30, book: dict | None = None,
                      extra_flows: list[dict] | None = None, sip_weights: dict[str, float] | None = None,
                      plans_scale: float = 1.0, plans_step_pct: float = 0.0) -> dict:
    """Monte Carlo fan chart of the portfolio's value with monthly contributions: a thin wrapper over
    `simulate.run` (seed 42; SPEC §6.13 P2, AMENDMENTS K9). The positional signature is unchanged.

    - Each asset class is simulated on its own correlated path; FDs, P2P and EPF are deterministic ladders
      (an FD releases at maturity to the class furthest under `targets`, else to debt funds).
    - μ and σ: `blended_assumptions(..., positions=port['positions'])` gives the headline (μ*, σ*) (the Book,
      the own-record blend, `return_override` in percent for μ only); every stochastic class is shifted by δ and
      scaled by s so the mix matches them (`_calibrate`). The `assumptions` block reports the return the simulation
      used (`_simulated_mu`: μ* unless δ's ±5-point cap or a ladder-only mix stops it) with σ*, plus
      `requested_return_pct` (μ*) and `return_note` (None unless the two differ).
    - Flows: with `sips` and `monthly_sip=None`, each plan on its own due dates and class (`flows_basis`
      'plans'); otherwise `monthly_sip` is one monthly amount with `step_up_pct`, split by the plans' monthly
      equivalents when `sips` is given, else pro rata over today's market-linked holdings ('mix').
    - `scenarios`: `base`/`bear`/`bull` = end p50/p10/p90 of the one simulation; `no_more_investing` is the
      p50 of the state-only component on the same draws (exactly linear, so always ≤ base).
    - `expected` is the **mean** path (each class at μ): show it only as "Average, pulled up by the best cases".
    - `typical_cagr_pct` = (end p50 / money contributed)^(1/years) − 1.
    - `end.real_p50` deflates the median by `inflation` (a fraction; None = the 6% default; outside
      [-0.05, 0.5] raises ValueError). `end.after_tax` {p10, p50, p90, note} only with `after_tax`.
    - New keys (K9): `engine`, `by_key` (horizon medians by segment, debt funds under Mutual Funds),
      `prob_below_contributed_3y`, `max_drawdown_p50` (the typical worst fall from a peak, percent),
      `flows_basis` and `calibration` {delta_pct, vol_scale}.
    - `book` (R4) is the base Book (`effective_book(settings)`); None = the default Book. Its `inflation_pct` is
      the inflation used when `inflation` is None.
    - `extra_flows` (R6) [{date, amount}] are one-off flows routed like the SIP (the plans' monthly equivalents
      on the 'plans' basis); dates on or before today or past the horizon are ignored. `sip_weights` ({Book key:
      share}) replaces the plans' split of a 'mix'-basis SIP (compare's `mix`). Both are additive.
    - `plans_scale` / `plans_step_pct` (compare, W7 review fixes): on the 'plans' basis every plan instalment is
      × `plans_scale` and × (1 + plans_step_pct/100) per whole year from today, and `sip_weights`, when given,
      re-splits each month's plan total (`simulate.adjust_flows`). The defaults (1, 0, None) change nothing.
    """
    today = today or date.today()
    years = max(1, min(int(years), MAX_YEARS))
    sims = max(200, min(int(sims), 5000))
    infl = _book_inflation(book) if inflation is None else float(inflation)
    if not -0.05 <= infl <= 0.5:
        # a fraction: retirementPlan.inflation_pct (6) must be passed as 0.06; never clamp a percent into 50%
        raise ValueError(f"inflation must be a fraction between -0.05 and 0.5 (got {inflation}); "
                         "pass inflation_pct / 100")
    a = blended_assumptions(port["segments"], perf_metrics, positions=port.get("positions"), book=book)
    mu, sigma = a["mu"], a["sigma"]
    if return_override is not None:
        mu = max(min(float(return_override) / 100, 0.30), -0.10)
    step = max(min(float(step_up_pct or 0) / 100, 0.5), 0.0)
    months = years * 12
    state = S.build_state(_sim_positions(port), book=a["book"], today=today, txns=txns, instruments=instruments,
                          targets=targets)
    cal_book, delta, scale = _calibrate(a["book"], a["weights"], mu, sigma, base=book)
    mu_star = mu
    mu, return_note = _simulated_mu(a["weights"], cal_book, mu_star, override=return_override is not None)
    plan_w = _plan_weights(sips, state, today) if sips else None
    if sips is not None and monthly_sip is None:
        flows = S.flows_from_sips(sips, state=state, today=today, horizon_months=months)
        sip, flows_basis = monthly_sip_total(sips, today), "plans"
        route_w = plan_w
        if plans_scale != 1.0 or plans_step_pct or sip_weights:
            flows = S.adjust_flows(flows, scale=plans_scale, step_up_pct=plans_step_pct, weights=sip_weights)
            sip, route_w = round(sip * max(float(plans_scale), 0.0), 2), sip_weights or plan_w
    else:
        sip = max(float(monthly_sip or 0), 0.0)
        route_w = sip_weights or plan_w
        flows = S.lump_flow(sip, state=state, step_up_pct=step * 100, today=today, horizon_months=months,
                            weights=route_w)
        flows_basis = "mix"
    if extra_flows:
        flows = flows + _extra_flows(extra_flows, state=state, today=today, horizon_months=months, weights=route_w)
    current = state["total"]
    targets_ms = [m for m in MILESTONES if m > current * 1.05]
    r = S.run(state, flows, cal_book, horizon_months=months, sims=sims, seed=PROJECTION_SEED, after_tax=after_tax,
              slab_rate=slab_rate, milestones=targets_ms, sample_months=[months])
    sims = r["sims"]

    path = []
    for y in range(years + 1):
        row = r["years"][y]
        path.append({"year": today.year + y, "date": date(today.year + y, today.month, 1).isoformat(),
                     "p10": row["p10"], "p25": row["p25"], "p50": row["p50"], "p75": row["p75"], "p90": row["p90"],
                     "expected": r["expected"][y], "contributed": row["contributed"]})
    end = path[-1]
    milestones = []
    for m in r["milestones"]:
        prob = m["probability"] / 100
        if prob < 0.02 or m["median_months"] is None:
            continue
        med = m["median_months"]
        if prob > 0.995 and med <= 18 and len(targets_ms) > 3:
            continue  # all but certain within a year and a half: not worth a line
        milestones.append({"amount": m["amount"], "label": _fmt_inr(m["amount"]), "probability": m["probability"],
                           "median_months": med, "median_year": today.year + (today.month - 1 + med) // 12})
        if len(milestones) >= 5:
            break

    # every scenario is read from the one simulation (no ±4% deterministic paths)
    scen = {"base": end["p50"], "bear": end["p10"], "bull": end["p90"], "no_more_investing": r["no_flow_p50"][-1]}
    typical_cagr = None
    if end["contributed"] > 0 and end["p50"] > 0:
        typical_cagr = round(((end["p50"] / end["contributed"]) ** (1 / years) - 1) * 100, 2)
    at_end = r["at"][months]
    by_key: dict[str, float] = {}
    for k, v in r["years"][-1]["by_key_p50"].items():
        seg = d.SEG_MF if k == A.MF_DEBT else k
        by_key[seg] = round(by_key.get(seg, 0.0) + v, 2)
    end_out = {"p10": end["p10"], "p50": end["p50"], "p90": end["p90"], "expected": end["expected"], "contributed": end["contributed"],
               "real_p50": round(end["p50"] / (1 + infl) ** years, 2),
               "gain_p50": round(end["p50"] - end["contributed"], 2),
               "probability_of_loss": round(sum(1 for v in at_end if v < end["contributed"]) / len(at_end) * 100, 1)}
    if after_tax and r["after_tax"]:
        end_out["after_tax"] = dict(r["after_tax"])
    return {
        "years": years, "sims": sims, "current": round(current, 2), "monthly_sip": sip, "step_up_pct": round(step * 100, 1),
        "assumptions": {**_block(mu, sigma, infl, a["basis"], a["book"]), "own": a["own"], "mix": a["rows"],
                        "requested_return_pct": round(mu_star * 100, 2), "return_note": return_note},
        "path": path,
        "end": end_out,
        "typical_cagr_pct": typical_cagr,
        "scenarios": scen, "milestones": milestones, "honesty": _honesty(sims),
        "engine": "simulate", "by_key": dict(sorted(by_key.items(), key=lambda kv: -kv[1])),
        "prob_below_contributed_3y": r["prob_below_contributed_3y"], "max_drawdown_p50": r["max_drawdown_p50"],
        "flows_basis": flows_basis, "calibration": {"delta_pct": round(delta * 100, 2), "vol_scale": round(scale, 3)},
        "note": "A Monte Carlo per asset class with correlated returns, your monthly investing added to the classes it buys, "
                "FDs, P2P and EPF growing at their own rates. " + HONESTY["disclaimer"],
    }


def _stress_values(port: dict) -> dict[str, float]:
    """Today's value by stress key: the segments, with debt mutual funds split out as MF_DEBT when the port
    has positions (`assumptions.book_key`). A port without positions is not split (G8)."""
    vals: dict[str, float] = {}
    for s in port.get("segments") or []:
        vals[s["segment"]] = vals.get(s["segment"], 0.0) + float(s.get("value") or 0)
    debt = 0.0
    for p in port.get("positions") or []:
        v = _f(p.get("value"))
        if p.get("is_open", True) and v > 0 and book_key(p) == A.MF_DEBT:
            debt += v
    if debt > 0:
        vals[d.SEG_MF] = max(vals.get(d.SEG_MF, 0.0) - debt, 0.0)
        vals[A.MF_DEBT] = debt
    return vals


BETA_KEYS = (d.SEG_EQ_IN, d.SEG_MF, d.SEG_NPS)   # β against the Nifty means something only for these (K11)
BETA_CLAMP = (-0.95, 1.0)
STRESS_SIMS = 500                                # plan_impact runs (K11)
STRESS_HOLDINGS = 10                             # the drill-down lists the largest |impact| holdings only
RECOVERY_CAP = 240


def _holding_shock(base: float, key: str, beta) -> float:
    """A holding's shock: the segment shock × β for Indian equity, equity funds and NPS, clamped to −0.95..+1.0;
    the segment shock itself without a β or for any other key (β prior 1.0)."""
    if not base or beta is None or key not in BETA_KEYS:
        return base
    try:
        b = float(beta)
    except (TypeError, ValueError):
        return base
    return max(min(base * b, BETA_CLAMP[1]), BETA_CLAMP[0])


def _recovery(after_by_key: dict[str, float], rates: dict[str, float], total: float, sip: float) -> int | None:
    """Months until Σ after_k × (1 + r_k)^(m/12) (+ the SIP, at the after-shock mix's blended rate, added at each
    month end) is back to `total`; None beyond 240 months."""
    after = sum(after_by_key.values())
    if after >= total:
        return 0
    blend = sum(rates[k] * v for k, v in after_by_key.items()) / after if after > 0 else 0.0
    rm = (1 + blend) ** (1 / 12) - 1
    sip_fv = 0.0
    for m in range(1, RECOVERY_CAP + 1):
        sip_fv = sip_fv * (1 + rm) + sip
        v = sum(x * (1 + rates[k]) ** (m / 12) for k, x in after_by_key.items()) + sip_fv
        if v >= total:
            return m
    return None


def _allocation(raw) -> dict[str, float]:
    """A goal's allocation {segment: pct} from a dict or its JSON text (goals.parse_allocation's shape; G3 keeps
    `forecast` from importing `goals`)."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    out = {}
    for seg, pct in (raw or {}).items() if isinstance(raw, dict) else []:
        if _f(pct) > 0:
            out[seg] = _f(pct)
    return out


def _goal_alloc(alloc: dict[str, float]) -> dict[str, float]:
    """{Book key: share of that key's starting value} from {segment: pct}; Mutual Funds covers both fund keys."""
    out: dict[str, float] = {}
    for seg, pct in alloc.items():
        for k in ((d.SEG_MF, A.MF_DEBT) if seg == d.SEG_MF else (seg,)):
            if k in A.KEYS:
                out[k] = min(out.get(k, 0.0) + pct / 100, 1.0)
    return out


def _plan_impact(port: dict, book: dict, plan: dict, monthly_sip: float, sips, txns, instruments, today: date,
                 falling: list[tuple[str, dict]], base: dict | None = None) -> dict[str, dict]:
    """K11: {scenario key: {retirement_before, retirement_after, goals [{id, name, before, after}]}}.

    One baseline and one shocked `simulate.run` per falling scenario (seed 7, 500 sims, CRN), over the latest of
    the retirement and goal dates; the retirement figures are accumulation probabilities (value at the
    retirement month ≥ corpus_needed), the goals are valued on the same draws (their share of each class's
    starting value plus their linked SIPs, else their monthly contribution). `base` is the base Book (R4): its
    inflation is the default when the retirement params name none."""
    state = S.build_state(_sim_positions(port), book=book, today=today, txns=txns, instruments=instruments)
    ret = plan.get("retirement") or None
    corpus = ret_m = None
    cal_book = book
    if ret:
        try:
            rb = _retirement_basics(ret, inflation_default=book_inflation_pct(base))
            corpus, ret_m = rb["corpus_needed"], rb["years"] * 12
            if rb["p"]["return_pct"] is not None:
                a = blended_assumptions(port["segments"], None, positions=port.get("positions"), book=base)
                cal_book = _calibrate(book, a["weights"], rb["p"]["return_pct"] / 100, a["sigma"], base=base)[0]
        except ValueError:
            ret = None
    goal_rows = []
    for g in plan.get("goals") or []:
        due = S._date(g.get("target_date"))
        if due is None:
            continue
        m = S.month_index(today, due)
        if m < 1:
            continue
        goal_rows.append((g, m))
    horizon = max([ret_m or 0] + [m for _, m in goal_rows] + [12])
    ret_sip = (ret or {}).get("monthly_sip")
    if sips is not None and ret_sip in (None, ""):
        # the retirement plan names no SIP: the plans, each on its own dates and class (retirement_plan's rule)
        flows = S.flows_from_sips(sips, state=state, today=today, horizon_months=horizon, stop_month=ret_m)
    else:
        sip = _f(ret_sip) if ret_sip not in (None, "") else _f(monthly_sip)
        step = _f((ret or {}).get("step_up_pct"))
        flows = S.lump_flow(sip, state=state, step_up_pct=step, today=today, horizon_months=horizon, stop_month=ret_m,
                            weights=_plan_weights(sips, state, today) if sips else None)
    specs = []
    for g, m in goal_rows:
        alloc = _allocation(g.get("allocation"))
        linked = [i for i, fl in enumerate(flows) if fl.get("goal_id") is not None and fl.get("goal_id") == g.get("id")]
        if not linked and _f(g.get("monthly_contribution")) > 0:
            w = {k: x for k, x in _goal_alloc(alloc).items() if k in S.STOCH} or {d.SEG_MF: 1.0}
            for fl in S.lump_flow(_f(g.get("monthly_contribution")), state=state, today=today, horizon_months=m, weights=w):
                fl["goal_only"] = True
                linked.append(len(flows))
                flows.append(fl)
        specs.append({"id": g.get("id"), "alloc": _goal_alloc(alloc), "target": _f(g.get("target_amount")), "month": m,
                      "flows": linked})
    samples = [ret_m] if ret_m else []

    def probs(shock):
        r = S.run(state, flows, cal_book, horizon_months=horizon, sims=STRESS_SIMS, seed=RETIREMENT_SEED, shock=shock,
                  goals=specs, sample_months=samples)
        rp = None
        if ret_m:
            xs = r["at"][ret_m]
            rp = round(sum(1 for v in xs if v >= corpus) / len(xs) * 100, 1)
        return rp, {g["id"]: g["probability"] for g in r["goals"]}

    base_r, base_g = probs(None)
    out = {}
    for key, shock in falling:
        r_after, g_after = probs(shock)
        out[key] = {"retirement_before": base_r, "retirement_after": r_after,
                    "goals": [{"id": g.get("id"), "name": g.get("name"), "before": base_g.get(g.get("id")),
                               "after": g_after.get(g.get("id"))} for g, _ in goal_rows]}
    return out


def stress_test(port: dict, monthly_sip: float = 0.0, *, betas: dict | None = None, plan: dict | None = None,
                sips: list[dict] | None = None, txns: list[dict] | None = None, instruments: list[dict] | None = None,
                today: date | None = None, book: dict | None = None) -> dict:
    """What each scenario would do to today's value, class by class and holding by holding, and how long a
    recovery at long-run typical returns would take, with and without your SIPs (SPEC §6.8 P2, AMENDMENTS K11).

    - Shocks (K11): with `betas` ({instrument_id: β}), each Indian equity, equity fund or NPS holding takes the
      segment shock × β, clamped to −0.95..+1.0; holdings without a β, and every other class, take the segment
      shock. Segment rows are the sums of their holdings; each scenario lists the 10 holdings with the largest
      |impact| in `holdings` [{instrument_id, name, segment, value, beta, shock_pct, impact}].
    - Debt mutual funds (`book_key` MF_DEBT, only when the port has positions) never take the equity MF shock:
      −4% in the `rates`, `covid` and `gfc` scenarios and 0 elsewhere, in their own row
      {segment: 'Mutual Funds (debt)', book_key: 'MF_DEBT'} (G8). Every row carries `book_key`.
    - `market_exposed_pct` counts equity (India and US), equity MFs, NPS and commodities; not MF_DEBT.
    - Recovery: `recovery_months_markets` grows what is left of each class at its Book **typical** return
      (`rated_book(positions)` with positions, else the default Book) with no new money;
      `recovery_months_with_sips` adds `monthly_sip` each month. Both are capped at 240 months (None beyond).
      `recovery_months` is an alias of the with-SIPs figure.
    - `plan_impact` (only with `plan` = {retirement: merged params | None, goals: [goal rows]}): for each falling
      scenario, the retirement and goal probabilities before and after the shock on the same 500 draws (seed 7);
      the top-level copy is the worst scenario's. None without `plan`.
    - `assumptions` is the §6.0 rule-2 block for the portfolio's Book mix.
    - `book` (R4) is the base Book (`effective_book(settings)`); None = the default Book.
    """
    today = today or date.today()
    base = book
    segs = _stress_values(port)
    total = sum(v for v in segs.values() if v > 0)
    w, book, _ = _book_weights(port.get("segments"), port.get("positions"), base)
    betas = {k: v for k, v in (betas or {}).items() if v is not None}
    held = [(p, _f(p.get("value"))) for p in port.get("positions") or [] if p.get("is_open", True) and _f(p.get("value")) > 0]
    typ = {k: typical(*_row_of(book, k)) for k in segs}
    sip = max(_f(monthly_sip), 0.0)
    out = []
    for sc in STRESS_SCENARIOS:
        key_impact: dict[str, float] = defaultdict(float)
        with_pos: set[str] = set()
        holdings = []
        for p, v in held:
            k = book_key(p)
            seg_shock = sc["shocks"].get(k, 0.0)
            beta = betas.get(p.get("id"))
            if beta is None and p.get("id") is not None:
                beta = betas.get(str(p.get("id")))
            shock = _holding_shock(seg_shock, k, beta)
            amt = v * shock
            key_impact[k] += amt
            with_pos.add(k)
            if amt:
                holdings.append({"instrument_id": p.get("id"), "name": p.get("name"),
                                 "segment": DEBT_LABEL if k == A.MF_DEBT else k, "value": round(v, 2),
                                 "beta": round(float(beta), 3) if beta is not None and k in BETA_KEYS else None,
                                 "shock_pct": round(shock * 100, 1), "impact": round(amt, 2)})
        holdings.sort(key=lambda h: -abs(h["impact"]))
        rows, impact = [], 0.0
        after_by_key: dict[str, float] = {}
        for seg, val in segs.items():
            if val <= 0:
                continue
            seg_shock = sc["shocks"].get(seg, 0.0)
            amt = key_impact[seg] if seg in with_pos else val * seg_shock
            impact += amt
            after_by_key[seg] = max(val + amt, 0.0)
            if seg_shock or amt:
                rows.append({"segment": DEBT_LABEL if seg == A.MF_DEBT else seg, "book_key": seg, "value": round(val, 2),
                             "shock_pct": round(amt / val * 100, 1), "impact": round(amt, 2)})
        rows.sort(key=lambda r: r["impact"])
        after = total + impact
        markets = with_sips = None
        if impact < 0 and total > 0:
            markets = _recovery(after_by_key, typ, total, 0.0)
            with_sips = _recovery(after_by_key, typ, total, sip)
        out.append({**{k: sc[k] for k in ("key", "label", "note")}, "impact": round(impact, 2),
                    "impact_pct": round(impact / total * 100, 2) if total else 0.0, "after": round(after, 2),
                    "recovery_months_markets": markets, "recovery_months_with_sips": with_sips,
                    "recovery_months": with_sips, "rows": rows, "holdings": holdings[:STRESS_HOLDINGS],
                    "key_shocks": {k: (after_by_key[k] / segs[k] - 1) for k in after_by_key if segs[k] > 0},
                    "plan_impact": None})
    worst = min(out, key=lambda s: s["impact"]) if out else None
    top_impact = None
    if plan is not None:
        falling = [(s["key"], {k: x for k, x in s["key_shocks"].items() if x}) for s in out if s["impact"] < 0]
        impacts = _plan_impact(port, book, plan, sip, sips, txns, instruments, today, falling, base=base) if falling else {}
        for s in out:
            s["plan_impact"] = impacts.get(s["key"])
        top_impact = worst["plan_impact"] if worst else None
    for s in out:
        s.pop("key_shocks", None)
    exposed = sum(v for k, v in segs.items() if k in MARKET_KEYS and v > 0)
    mu, sigma = mu_sigma(w, book) if w else (0.0, 0.0)
    basis = ("shocks on today's values by holding (β-scaled for Indian equity, equity funds and NPS where known); "
             "recovery at each class's typical long-run return, with and without your SIP"
             + (", debt funds at the rate shock" if A.MF_DEBT in segs else ""))
    return {"total": round(total, 2), "market_exposed_pct": round(exposed / total * 100, 1) if total else 0.0,
            "scenarios": out, "worst": worst["key"] if worst else None, "plan_impact": top_impact,
            "assumptions": _block(mu, sigma, _book_inflation(base), basis, book), "honesty": dict(HONESTY_POINT),
            "note": "Shocks are applied to today's values, holding by holding. Recovery assumes each class earns its typical "
                    "long-run return on what is left, shown for markets alone and with your current SIP; real recoveries are "
                    "faster or slower than that."}


def annuity_due_factor(real: float, n: int) -> float:
    """ä_n: today's value of n yearly payments of 1 made at the start of each year, discounted at the
    real rate. Equals n when the real rate is (almost) zero."""
    if n <= 0:
        return 0.0
    if abs(real) < 1e-9:
        return float(n)
    return (1 - (1 + real) ** -n) / real * (1 + real)


def _drawdown(start: float, first_withdrawal: float, inflation: float, post_return: float, years: int) -> list[float]:
    """Balances C_0 … C_n of a retirement corpus: each year withdraws W₁(1+i)^k at its start, then the
    rest grows at the post-retirement return, C_{k+1} = (C_k − W₁(1+i)^k)(1+r). With C_0 = W₁·ä_n
    the last balance C_n is zero (to rounding)."""
    out = [start]
    c = start
    for k in range(years):
        c = (c - first_withdrawal * (1 + inflation) ** k) * (1 + post_return)
        out.append(c)
    return out


RETIREMENT_DEFAULTS = {"current_age": 30, "retire_age": 60, "life_expectancy": 85, "monthly_expenses": 50000.0,
                       "inflation_pct": INFLATION * 100, "post_return_pct": 7.0, "monthly_sip": 0.0, "step_up_pct": 0.0,
                       "return_pct": None, "other_income_monthly": 0.0}
GLIDE = {"start_age": 45, "floor": 0.30, "step": 0.01}     # K8 glide defaults, used by retirement
NPS_ANNUITY = {"share": S.ANNUITY_SHARE, "rate": S.ANNUITY_RATE}


def _retirement_basics(params: dict, inflation_default: float | None = None) -> dict:
    """The P0 deterministic inputs (SPEC §6.5): the merged params, ages, Y, n, i, r, W₁ and corpus_needed.
    `inflation_default` (percent; R4: the base Book's) replaces the 6% default when the params name none.
    Raises ValueError when retire_age ≤ current_age."""
    p = dict(RETIREMENT_DEFAULTS)
    if inflation_default is not None:
        p["inflation_pct"] = float(inflation_default)
    for k, v in (params or {}).items():
        if k in p and v not in (None, ""):
            p[k] = float(v)
    cur_age, ret_age, life = int(p["current_age"]), int(p["retire_age"]), int(p["life_expectancy"])
    if ret_age <= cur_age:
        raise ValueError("Retirement age must be after your current age")
    life = max(life, ret_age + 1)
    yrs, ret_years = ret_age - cur_age, life - ret_age
    infl, post = p["inflation_pct"] / 100, p["post_return_pct"] / 100
    annual_exp_today = p["monthly_expenses"] * 12
    other = p["other_income_monthly"] * 12
    first_withdrawal = max(annual_exp_today * (1 + infl) ** yrs - other, 0.0)  # W₁
    real = (1 + post) / (1 + infl) - 1
    return {"p": p, "cur_age": cur_age, "ret_age": ret_age, "life": life, "years": yrs, "ret_years": ret_years,
            "infl": infl, "post": post, "annual_exp_today": annual_exp_today, "other": other,
            "net_annual_today": max(annual_exp_today - other, 0.0), "first_withdrawal": first_withdrawal,
            "corpus_needed": first_withdrawal * annuity_due_factor(real, ret_years)}


def _funded_positions(positions: list[dict], funding: dict) -> tuple[list[dict], dict]:
    """K10: the money retirement may use. EPF and NPS always (locked for retirement), plus the goal-free share of
    everything else, spread pro rata over those holdings. `funding.free` counts EPF and NPS too when no goal
    claims them, so the free share of the other money is free − EPF − NPS, floored at 0 and capped at the other
    money; what is left (goal earmarks and the cushion) is `excluded`."""
    epf = nps = other = 0.0
    for p in positions:
        v = _f(p.get("value"))
        if not p.get("is_open", True) or v <= 0:
            continue
        k = book_key(p)
        if k == d.SEG_EPF:
            epf += v
        elif k == d.SEG_NPS:
            nps += v
        else:
            other += v
    free = min(max(_f(funding.get("free")) - epf - nps, 0.0), other)
    f = free / other if other > 0 else 0.0
    scaled = []
    for p in positions:
        k = book_key(p) if _f(p.get("value")) > 0 else None
        if k in (d.SEG_EPF, d.SEG_NPS) or k is None:
            scaled.append(p)
            continue
        q = dict(p)
        for fld in ("value", "cost", "invested", "outstanding", "maturity_value"):
            if q.get(fld) not in (None, ""):
                q[fld] = _f(q[fld]) * f
        scaled.append(q)
    return scaled, {"epf": round(epf, 2), "nps": round(nps, 2), "free": round(free, 2), "excluded": round(other - free, 2)}


def _order_stat(xs: list[float], p: float) -> float:
    """The exact p-th order statistic: the smallest x with at least p of the values ≤ x."""
    ys = sorted(xs)
    return ys[max(math.ceil(p * len(ys)) - 1, 0)]


def retirement_plan(port: dict, perf_metrics: dict | None, params: dict, today: date | None = None, sims: int = 1000, *,
                    funding: dict | None = None, txns: list[dict] | None = None, instruments: list[dict] | None = None,
                    sips: list[dict] | None = None, book: dict | None = None, extra_flows: list[dict] | None = None,
                    sip_weights: dict[str, float] | None = None, plans_scale: float = 1.0,
                    plans_step_pct: float = 0.0) -> dict:
    """Corpus needed, projected corpus, the chances of reaching it and of the money lasting, required SIP, FIRE
    number and a year-by-year path (SPEC §6.5 P0 + P2, AMENDMENTS K10).

    One convention everywhere: withdrawals are made at the start of each retirement year (annuity-due), at ages
    `retire_age` … `life_expectancy` − 1.

    Deterministic (P0, unchanged):
    - W₁ = 12 × monthly_expenses × (1+i)^Y − 12 × other_income_monthly, the first year's net withdrawal.
    - `corpus_needed` = W₁ × ä_n at the real post-retirement rate (1+r)/(1+i) − 1.
    - `projected` is today's money plus the SIP (with step-up) compounded monthly to retirement at μ.
    - `path`: while saving, the same monthly compounding sampled each birthday, so the row at `retire_age`
      equals `projected`; once retired, the drawdown C_{k+1} = (C_k − W_k)(1+r) from `projected`. `runs_out_at`
      is the first age whose balance is below zero (₹1 tolerance), or None.

    Simulated (P2, one `simulate.run`, seed 7, `sims` paths): every class on its own correlated path, the glide
    from age 45 (equity share −1 point a year, floor 30%), EPF locked until retirement and joining the corpus
    there, 60% of NPS joining it and 40% buying an annuity at 6% that offsets each year's withdrawal, then the
    yearly withdrawals W₁(1+i)^k.
    - `probability`: the share of paths whose money at the retirement month is ≥ corpus_needed.
    - `probability_lasts`: the share of paths that pay every withdrawal to life expectancy.
    - `depletion_age_p10`: the 10th-percentile age the money runs out, when at least 10% of paths run out.
    - `path_bands` [{age, p10, p50, p90}] from today's age to life expectancy.
    - `status` = `status_for(min(probability, probability_lasts))`; the gap only when there is no simulation.
    - `required_sip` / `required_sip_typical`: the accumulation is exactly linear in the SIP, so each path's
      need is (corpus_needed − A_i)/B_i (A_i its money at retirement with no SIP, B_i from ₹1 a month with the
      same step-up), floored at 0; they are the exact 75th and 50th percentiles, rounded up to ₹1. So the
      probability at `required_sip` is ≥ 75, and < 75 at ₹100 less (unless the need is 0).
    - μ and σ: the headline from `blended_assumptions` (a `return_pct` input replaces μ), each class shifted and
      scaled to match it (K9). `corpus_needed` keeps `post_return_pct`; the simulation's retirement years grow
      at the Book mix with the glide. The deterministic figures (`projected`, `gap`, `path`, `fire`) and
      `inputs.return_pct` use the return the simulation actually uses (`_simulated_mu`), so they and the chances
      describe one assumption; `requested_return_pct` keeps μ* and `return_note` says when the two differ.
    - SIP: the plans (`sips`, each on its own dates and class) only when `params` names no `monthly_sip`;
      otherwise `monthly_sip` with `step_up_pct`, split by the plans' monthly equivalents when `sips` is given.
      The deterministic figures use the same basis (the plans' monthly total, `monthly_sip_total`), and
      `inputs.monthly_sip` / `flows_basis` ('plans' | 'input') report it.
    - `funding` (`/plan`'s funding summary): the money used is EPF + NPS + the goal-free share of the rest
      (`sources` {epf, nps, free, excluded}); without it the whole portfolio is used and `sources` is None.
      With `funding`, plans linked to a goal (`goal_id`) are left out of the SIP too: they fund their goal.
    - `assumptions` is the §6.0 rule-2 block; `honesty` the HONESTY copy with p50 formatted for `sims`.
    - `book` (R4) is the base Book (`effective_book(settings)`; None = the default); its `inflation_pct` is the
      inflation when `params` names none.
    - `extra_flows` (R6) [{date, amount}]: one-off sums before retirement, routed like the SIP and added to the
      deterministic figures at μ; `sip_weights` ({Book key: share}) replaces the plans' split of a typed SIP.
    - `plans_scale` / `plans_step_pct` / `sip_weights` on the plans basis: as `project_portfolio` (compare's
      changed SIP over the plans); the deterministic monthly figure is the plans' total × `plans_scale`.
      With extra flows the required SIP reads A_i (money at retirement with no SIP) from a second, accumulation-only
      run of the state and the lump sums on the same draws; it is exact unless the glide applies, which trims the
      flows layer as one.

    Raises ValueError when retire_age ≤ current_age.
    """
    today = today or date.today()
    rb = _retirement_basics(params, inflation_default=book_inflation_pct(book) if book else None)
    p, cur_age, ret_age, life = rb["p"], rb["cur_age"], rb["ret_age"], rb["life"]
    yrs, ret_years, infl, post = rb["years"], rb["ret_years"], rb["infl"], rb["post"]
    first_withdrawal, corpus_needed = rb["first_withdrawal"], rb["corpus_needed"]
    a = blended_assumptions(port["segments"], perf_metrics, positions=port.get("positions"), book=book)
    mu_star = p["return_pct"] / 100 if p["return_pct"] is not None else a["mu"]
    sigma = a["sigma"]
    # one μ for the whole payload: the return the calibrated simulation uses (wave-6 review)
    cal_book, _delta, _scale = _calibrate(a["book"], a["weights"], mu_star, sigma, base=book)
    mu, return_note = _simulated_mu(a["weights"], cal_book, mu_star, override=p["return_pct"] is not None)
    positions = _sim_positions(port)
    sources = None
    current = float(port["totals"]["value"] or 0)
    if funding:
        positions, sources = _funded_positions(positions, funding)
        current = sources["epf"] + sources["nps"] + sources["free"]
        if sips:
            # a plan linked to a goal funds that goal (K15), as the goal's earmarked money does: neither counts
            # for retirement, so one rupee is never planned twice (final pass; stress plan_impact's goal_only rule)
            sips = [s for s in sips if s.get("goal_id") in (None, "")]
    # one SIP basis for the whole payload (K9's rule): the plans only when the params name no monthly_sip
    use_plans = sips is not None and (params or {}).get("monthly_sip") in (None, "")
    sip = round(monthly_sip_total(sips, today) * max(float(plans_scale), 0.0), 2) if use_plans else p["monthly_sip"]
    step = p["step_up_pct"] / 100
    net_annual_today = rb["net_annual_today"]
    projected = _fv(current, sip, mu, yrs * 12, step) + _extra_fv(extra_flows, today=today, mu=mu, months=yrs * 12)
    gap = corpus_needed - projected

    prob = lasts = dep_p10 = None
    path_bands: list[dict] = []
    required = required_typ = None
    annuity = None
    sims = int(sims or 0)
    if sims:
        ret_m, horizon = yrs * 12, (life - cur_age) * 12
        state = S.build_state(positions, book=a["book"], today=today, txns=txns, instruments=instruments)
        plan_w = _plan_weights(sips, state, today) if sips else None
        weights = sip_weights or plan_w
        if use_plans:
            flows = S.flows_from_sips(sips, state=state, today=today, horizon_months=ret_m, stop_month=ret_m)
            if plans_scale != 1.0 or plans_step_pct or sip_weights:
                flows = S.adjust_flows(flows, scale=plans_scale, step_up_pct=plans_step_pct, weights=sip_weights)
        else:
            flows = S.lump_flow(sip, state=state, step_up_pct=step * 100, today=today, horizon_months=ret_m, stop_month=ret_m,
                                weights=weights)
        extra = _extra_flows(extra_flows, state=state, today=today, horizon_months=ret_m,
                             weights=weights) if extra_flows else []
        flows = flows + extra
        glide = {"current_age": cur_age, **GLIDE}
        wd = {"start_month": ret_m, "annual": first_withdrawal, "growth": infl, "until_month": horizon,
              "annuity": dict(NPS_ANNUITY) if state["values"].get(d.SEG_NPS, 0) > 0 else None}
        # B_i, the value of ₹1 a month at retirement: the lump flows' own layer when the SIP is one lump (> 0) and
        # nothing else flows; otherwise a probe of ₹1 a month (same step-up and split) on the same draws
        lump_sip = not use_plans and sip > 0 and not extra
        probe = None if lump_sip else S.lump_flow(1.0, state=state, step_up_pct=step * 100, today=today,
                                                  horizon_months=ret_m, stop_month=ret_m, weights=weights)
        r = S.run(state, flows, cal_book, horizon_months=horizon, sims=sims, seed=RETIREMENT_SEED, glide=glide,
                  withdrawals=wd, sample_months=[ret_m], keep_paths=True, probe=probe)
        sims = r["sims"]
        totals, base = r["paths"][ret_m]["total"], r["paths"][ret_m]["state"]
        if extra:
            # A_i with the lump sums: the state and the lump sums alone, accumulated on the same draws (CRN)
            aux = S.run(state, extra, cal_book, horizon_months=ret_m, sims=sims, seed=RETIREMENT_SEED, glide=glide,
                        sample_months=[ret_m], keep_paths=True)
            base = aux["paths"][ret_m]["total"]
        prob = sum(1 for v in totals if v >= corpus_needed) / len(totals) * 100
        lasts = r["depletion"]["lasts_pct"]
        ages = r["depletion"]["ages"]
        k10 = max(math.ceil(0.10 * len(ages)) - 1, 0)
        if ages[k10] is not None:
            dep_p10 = cur_age + ages[k10] // 12
        path_bands = [{"age": cur_age + row["year"], "p10": row["p10"], "p50": row["p50"], "p90": row["p90"]}
                      for row in r["years"]]
        annuity = r["annuity"]
        # required SIP: exact on these draws, A_i + sip × B_i at retirement (K10)
        if lump_sip:
            unit = [(t - s) / sip for t, s in zip(totals, base)]
        else:
            unit = r["paths"][ret_m]["probe"]
        need = [max((corpus_needed - a_i) / b_i, 0.0) if b_i > 0 else (0.0 if a_i >= corpus_needed else float("inf"))
                for a_i, b_i in zip(base, unit)]
        q75, q50 = _order_stat(need, REQUIRED_PROB), _order_stat(need, 0.5)
        required = float(math.ceil(q75)) if math.isfinite(q75) else None
        required_typ = float(math.ceil(q50)) if math.isfinite(q50) else None
    else:
        # no simulation asked for: the helper's yearly draws keep a required SIP on the page (G8)
        req = mc.required_sip_for(current, yrs * 12, mu, sigma, corpus_needed, REQUIRED_PROB, step, seed=RETIREMENT_SEED)
        required = float(req["sip_75"]) if req["sip_75"] is not None else None
        required_typ = float(req["sip_typical"]) if req["sip_typical"] is not None else None

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
    coast_now = corpus_needed / (1 + mu) ** yrs

    # year-by-year path: monthly accumulation sampled each birthday, then the annuity-due drawdown
    path = []
    for age in range(cur_age, ret_age):
        path.append({"age": age, "year": today.year + (age - cur_age), "phase": "saving",
                     "corpus": round(max(_fv(current, sip, mu, (age - cur_age) * 12, step)
                                         + _extra_fv(extra_flows, today=today, mu=mu, months=(age - cur_age) * 12), 0.0), 2),
                     "expenses": 0.0})
    balances = _drawdown(projected, first_withdrawal, infl, post, ret_years)
    ran_out = None
    for k, c in enumerate(balances):
        age = ret_age + k
        if c < -1 and ran_out is None:
            ran_out = age
        path.append({"age": age, "year": today.year + (age - cur_age), "phase": "retired", "corpus": round(max(c, 0.0), 2),
                     "expenses": round(first_withdrawal * (1 + infl) ** k, 2) if k < ret_years else 0.0})

    probability = round(prob, 1) if prob is not None else None
    lasts_r = round(lasts, 1) if lasts is not None else None
    known = [x for x in (probability, lasts_r) if x is not None]
    status = status_for(min(known)) if known else None
    if status is None:
        status = "on_track" if gap <= 0 else "at_risk" if projected >= corpus_needed * 0.75 else "off_track"
    basis = "your input" if p["return_pct"] is not None else a["basis"]
    asked = f"your return of {mu_star * 100:g}%" + (" (limited)" if return_note else "")
    block_basis = basis if p["return_pct"] is None else f"{asked}; volatility from your {a['basis']}"
    requested = round(mu_star * 100, 2)
    return {
        "inputs": {**p, "current_age": cur_age, "retire_age": ret_age, "life_expectancy": life, "return_pct": round(mu * 100, 2),
                   "volatility_pct": round(sigma * 100, 2), "return_basis": basis, "monthly_sip": sip,
                   "requested_return_pct": requested, "return_note": return_note},
        "assumptions": {**_block(mu, sigma, infl, block_basis, a["book"]), "requested_return_pct": requested,
                        "return_note": return_note},
        "flows_basis": "plans" if use_plans else "input",
        "years_to_retire": yrs, "retirement_years": ret_years, "current": round(current, 2),
        "monthly_expenses_at_retirement": round(p["monthly_expenses"] * (1 + infl) ** yrs, 2),
        "first_year_withdrawal": round(first_withdrawal, 2), "corpus_needed": round(corpus_needed, 2),
        "projected": round(projected, 2), "gap": round(gap, 2), "required_sip": required,
        "required_sip_typical": required_typ,
        "probability": probability, "probability_lasts": lasts_r, "depletion_age_p10": dep_p10,
        "path_bands": path_bands, "sources": sources, "annuity": annuity, "engine": "simulate" if sims else None,
        "sims": sims, "status": status,
        "fire": {"number": round(fire_number, 2), "progress_pct": round(min(current / fire_number * 100, 100), 1) if fire_number else None,
                 "years_to_fi": fire_year, "fi_age": cur_age + fire_year if fire_year is not None else None,
                 "coast_amount_now": round(coast_now, 2), "coasting": current >= coast_now},
        "runs_out_at": ran_out, "path": path,
        "honesty": _honesty(sims),
        "note": "Withdrawals are taken at the start of each retirement year and grow with inflation. The corpus needed and the "
                "path use the post-retirement return you set; the chances (reaching the corpus, and the money lasting to "
                f"{life}) come from simulating each asset class, with EPF joining at retirement, 60% of NPS as a lump sum and "
                "40% buying a 6% annuity that offsets withdrawals, and an equity share that falls a point a year from 45. "
                "Status follows the lower of the two chances, never the average path; the monthly investing needed reaches "
                "the corpus in 75 of 100 futures. The FIRE number assumes a 3.5% real withdrawal rate, the conservative end "
                "for Indian inflation.",
    }


def _month_add(y: int, m: int, k: int) -> tuple[int, int]:
    t = y * 12 + (m - 1) + k
    return t // 12, t % 12 + 1


def _add_months(day: date, k: int) -> date:
    y, m = _month_add(day.year, day.month, k)
    return date(y, m, min(day.day, 28))


def _next_year(ds: str) -> str:
    """The same month and day a year later (29 February becomes the 28th)."""
    dd = to_date(ds)
    return date(dd.year + 1, dd.month, min(dd.day, 28) if dd.month == 2 else dd.day).isoformat()


def _units_on(ts: list[dict], ds: str) -> float:
    """Units held at the end of `ds` (FIFO over the rows up to that date), restated in today's units by
    applying any later splits, so a per-unit dividend stays comparable with the current quantity."""
    lots, _, _ = run_fifo(0, [t for t in ts if str(t["date"])[:10] <= ds])
    units = sum(lot.qty for lot in lots)
    for t in ts:
        if t["type"] == d.SPLIT and str(t["date"])[:10] > ds and _f(t["quantity"]) > EPS:
            units *= _f(t["quantity"])
    return units


def cash_flow_forecast(positions: list[dict], instruments: list[dict], txns: list[dict], sips: list[dict],
                       months: int = 12, today: date | None = None, *, book: dict | None = None) -> dict:
    """Expected money in and out over the coming months, from what the ledger already knows.

    Rules (SPEC §6.6):
    1. The window starts tomorrow: the rows are the `months` calendar months from tomorrow's month,
       anything dated on or before today is dropped, and a dividend or EPF contribution already
       received this month is not projected again.
    2. FD interest payouts repeat last year's dates but stop at the FD's `maturity_date`.
    3. At maturity a payout FD (one with INTEREST rows) adds principal × rate × days since its last
       payout (recorded or projected) / 365; a cumulative FD adds maturity_value − principal.
    4. Dividends: each one of the past year is restated per unit (amount ÷ units held that day) and
       repeats on the same month and day next year × the units held now. Closed holdings are skipped.
    5. P2P loans amortise to `maturity_date`, or to `first_date` + `tenure_months` when there is none,
       with monthly EMIs on the loan's own day ending on that date (EMIs dated on or before today are
       already paid); repayments are discounted by (1 − P2P_LOSS/12) for every month ahead.
    6. SIP instalments fall on their real dates: `plans.due_dates(plan, tomorrow, the last day of the
       last month)`, each at `plans.planned_amount(plan, due)` (the step-up counts whole years from the
       plan's anchor). A quarterly or yearly plan lands only on its months; a weekly one 4 or 5 times a month.
    7. EPF contributions are averaged per calendar month (AMENDMENTS H16): the BUYs dated in the last
       120 days (up to today) are summed by month, and the monthly figure is the mean of the last (up to)
       three months that have one, so employee and employer rows of one month count once.
       A SIP plan on EPF is not counted again when EPF contributions are averaged from the ledger
       (a note says so); otherwise it shows as money into EPF (`contributions`), not `sip_out`.
    8. `monthly_sip_total` leaves out plans whose `start_date` is after today.
    `p2p_overdue` events are alerts about loans already past maturity, so they keep their past date.
    `assumptions` is the §6.0 rule-2 block for the portfolio's Book mix (`rated_book(positions, book)`, where
    `book` is the base Book, R4; None = the default Book).
    """
    today = today or date.today()
    months = max(1, min(int(months), 36))
    first = today + timedelta(days=1)
    today_s = today.isoformat()
    pos_by_id = {p["id"]: p for p in positions}
    by_inst: dict[int, list[dict]] = defaultdict(list)
    for t in txns:
        by_inst[t["instrument_id"]].append(t)
    keys = [_month_add(first.year, first.month, k) for k in range(months)]
    rows = {f"{y}-{m:02d}": {"month": f"{y}-{m:02d}", "dividends": 0.0, "interest": 0.0, "principal_back": 0.0,
                             "epf_interest": 0.0, "sip_out": 0.0, "contributions": 0.0} for y, m in keys}
    events = []
    notes: list[str] = []
    since = (today - timedelta(days=365)).isoformat()
    horizon_end = date(*_month_add(first.year, first.month, months), 1).isoformat()
    last_day = to_date(horizon_end) - timedelta(days=1)   # the last day of the last month shown

    def ahead(ds: str) -> bool:
        return today_s < ds < horizon_end

    def add(ds: str, field: str, amount: float) -> None:
        if ds[:7] in rows:
            rows[ds[:7]][field] += amount

    epf_averaged: set[int] = set()
    epf_ids = {i["id"] for i in instruments if i["asset_class"] == d.EPF}

    for inst in instruments:
        p = pos_by_id.get(inst["id"])
        if not p or not p.get("is_open"):
            continue
        ts = sorted(by_inst.get(inst["id"], []), key=lambda t: (str(t["date"])[:10], t.get("id") or 0))
        ac = inst["asset_class"]
        if ac in (d.EQUITY, d.MUTUAL_FUND):
            units_now = _f(p.get("quantity"))
            if units_now <= EPS:
                continue
            paid_this_month = any(t["type"] == d.DIVIDEND and str(t["date"])[:7] == today_s[:7] and str(t["date"])[:10] <= today_s
                                  for t in ts)
            for t in ts:
                ds = str(t["date"])[:10]
                if t["type"] != d.DIVIDEND or not (since < ds <= today_s):
                    continue
                nxt = _next_year(ds)
                if not ahead(nxt) or (paid_this_month and nxt[:7] == today_s[:7]):
                    continue
                units_then = _units_on(ts, ds)
                amount = _f(t["amount"]) / units_then * units_now if units_then > EPS else _f(t["amount"])
                add(nxt, "dividends", amount)
        elif ac == d.FIXED_DEPOSIT:
            mat = str(inst.get("maturity_date") or "")[:10] or None
            paid = [t for t in ts if t["type"] == d.INTEREST]
            last_paid = max((str(t["date"])[:10] for t in paid), default=None)
            for t in paid:
                ds = str(t["date"])[:10]
                if not (since < ds <= today_s):
                    continue
                nxt = _next_year(ds)
                if not ahead(nxt) or (mat and nxt >= mat):
                    continue
                add(nxt, "interest", _f(t["amount"]))
                last_paid = max(last_paid, nxt)
            if mat and ahead(mat):
                principal = _f(p.get("invested"))
                if paid:
                    days = max((to_date(mat) - to_date(last_paid)).days, 0)
                    final_interest = principal * _f(inst.get("rate")) / 100 * days / 365
                else:
                    final_interest = max((_f(p.get("maturity_value")) or _f(p.get("value"))) - principal, 0.0)
                add(mat, "principal_back", principal)
                add(mat, "interest", final_interest)
                amount = principal + final_interest
                events.append({"date": mat, "kind": "fd_maturity", "name": inst["name"], "amount": round(amount, 2),
                               "note": f"FD matures: {_fmt_inr(amount)} back", "instrument_id": inst["id"]})
        elif ac == d.P2P:
            out = _f(p.get("outstanding"))
            if out <= 0 or (inst.get("status") or "") in ("closed", "defaulted"):
                continue
            mat = inst.get("maturity_date")
            if mat:
                end = to_date(mat)
            else:
                start = to_date(p["first_date"]) if p.get("first_date") else today
                end = _add_months(start, int(_f(inst.get("tenure_months")) or 12))
            if end < today:
                events.append({"date": end.isoformat(), "kind": "p2p_overdue", "name": inst["name"], "amount": round(out, 2),
                               "note": f"Loan past maturity with {_fmt_inr(out)} outstanding", "instrument_id": inst["id"]})
                continue
            # EMIs fall monthly on the loan's own day, the last one on its end date; only those after today count
            due = []
            j = 0
            while True:
                dd = end if j == 0 else _add_months(end, -j)
                if dd <= today:
                    break
                due.append(dd.isoformat())
                j += 1
            due.reverse()
            remaining = max(len(due), 1)
            rate = _f(inst.get("rate")) / 100 / 12
            emi = out * rate / (1 - (1 + rate) ** -remaining) if rate else out / remaining
            bal = out
            for k, ds in enumerate(due):
                if bal <= 0:
                    break
                survive = (1 - P2P_LOSS / 12) ** (k + 1)  # expected losses grow with every month ahead
                interest = bal * rate
                principal = min(emi - interest, bal)
                bal -= principal
                add(ds, "principal_back", principal * survive)
                add(ds, "interest", interest * survive)
            if ahead(end.isoformat()):
                events.append({"date": end.isoformat(), "kind": "p2p_close", "name": inst["name"], "amount": round(out, 2),
                               "note": "Loan fully repaid", "instrument_id": inst["id"]})
        elif ac == d.EPF:
            bal = _f(p.get("value"))
            rate = _f(p.get("rate")) or 8.25
            fy_end_year = first.year if first.month <= 3 else first.year + 1
            if f"{fy_end_year}-03" in rows:
                rows[f"{fy_end_year}-03"]["epf_interest"] += bal * rate / 100
            # monthly contribution (H16): BUYs in the last 120 days summed per calendar month, then the mean of
            # the last (up to) three months that have one, so employee + employer rows count as one month. One
            # helper, `epf_monthly_average`, which the plan engine's EPF ladder uses too (K8)
            monthly = epf_monthly_average(ts, today)
            if monthly is not None:
                epf_averaged.add(inst["id"])
                # rule 1: a contribution already recorded this month is not projected again
                paid_this_month = any(t["type"] == d.BUY and str(t["date"])[:7] == today_s[:7]
                                      and str(t["date"])[:10] <= today_s for t in ts)
                for y, m in keys:
                    key = f"{y}-{m:02d}"
                    if not (paid_this_month and key == today_s[:7]):
                        rows[key]["contributions"] += monthly

    skipped_epf = []
    for s in sips:
        if not s.get("active", 1):
            continue
        on_epf = s.get("instrument_id") in epf_ids or (not s.get("instrument_id") and s.get("segment") == d.SEG_EPF)
        if on_epf and (s.get("instrument_id") in epf_averaged or (not s.get("instrument_id") and epf_averaged)):
            skipped_epf.append(s.get("name") or "EPF")
            continue
        field = "contributions" if on_epf else "sip_out"
        if _f(s.get("amount")) <= 0:
            continue
        for due in plans.due_dates(s, first, last_day):
            add(due.isoformat(), field, plans.planned_amount(s, due))

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
    if income:
        notes.append(f"About {_fmt_inr(income)} of passive income is due over the next {months} months, roughly {_fmt_inr(income / months)} a month.")
    if tot["principal_back"]:
        notes.append(f"{_fmt_inr(tot['principal_back'])} of principal comes back (FD maturities and loan repayments): decide where it goes next.")
    if tot["sip_out"]:
        notes.append(f"Your SIP plans send out {_fmt_inr(tot['sip_out'])} in the same period.")
    if skipped_epf:
        notes.append(f"Your EPF plan ({', '.join(skipped_epf)}) is not counted again: EPF contributions are averaged from your recent payroll entries "
                     "and shown as money into EPF.")
    base = book
    w, book, _ = _book_weights(None, positions, base)
    mu, sigma = mu_sigma(w, book) if w else (0.0, 0.0)
    basis = (f"P2P repayments net of a {P2P_LOSS * 100:g}% a year expected loss; dividends and FD interest repeat last year's "
             "dates; SIPs on their due dates")
    return {"months": out_rows, "totals": tot, "events": events, "notes": notes, "monthly_sip_total": monthly_sip_total(sips, today),
            "assumptions": _block(mu, sigma, _book_inflation(base), basis, book), "honesty": dict(HONESTY_POINT),
            "note": "Dividends and FD interest repeat last year's dates (dividends scaled to the units you hold now, FD interest only until "
                    "maturity); loans amortise to maturity after an allowance for defaults; EPF interest is for the financial year and stays "
                    "in the account. Treat these as expectations, not commitments."}
