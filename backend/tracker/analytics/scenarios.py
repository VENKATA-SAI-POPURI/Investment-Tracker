"""Plan scenarios: the PlanScenario contract, side-by-side compare and the sensitivities (SPEC §6.10; AMENDMENTS
R5–R7, D14, K19).

A pure module: no database, no network, no Flask. `services.py` gathers the inputs and memoises; everything that
decides a number lives here.

The contract (R5)
- A PlanScenario is {name, sip, step, return, retire_age, lump_sums, inflation_pct, mix}.
- `validate_scenario(raw, *, partial=False)` checks one entry. Saved entries (`planScenarios`, `partial=False`)
  need `name`, `sip` and `step`; inline entries (`POST /plan/compare`, `partial=True`) may leave any field out, and
  null or absent means "the baseline's value". Unknown keys are dropped. A wrong type or range raises
  `ScenarioError`, whose message starts with the field. `validate_saved(value)` checks the whole setting (≤ 5).
- `baseline(saved_retirement, plans_total)` is "Today's plan": the saved `monthly_sip` (else the plans' monthly
  total), the saved `step_up_pct` (else 0) and the saved `retire_age` (else null); every other field is null/[].
- `resolve(sc, base, n)` fills the nulls from the baseline. A resolved field equal to the baseline's is unchanged:
  when `sip` and `step` both are, the column's money flows exactly as the baseline's (the plans, or the typed SIP,
  by L5). Otherwise, with a typed SIP (or no plan running today) the column invests `sip` with `step` as one
  monthly amount split by the plans' monthly equivalents (or by the column's `mix`); when today's plan runs on
  the plans, every plan instalment is scaled by sip / baseline sip and by the step change per year from today, so
  each plan keeps its own step-up, end and start (`plans_adjust`, W7 review fixes). So `compare([baseline])`
  gives deltas of exactly 0 and a higher SIP never lowers a figure.

Compare (R6)
- Every column runs on the baseline's seeds (CRN): `forecast.project_portfolio` (seed 42) over the shared horizon,
  `forecast.retirement_plan` (seed 7) when a retirement plan is saved, and one `simulate.run` (seed 7) that values
  the goals on the same draws, built the way `forecast._plan_impact` builds them. `run_column` computes one column;
  `build_compare` lays the columns out as rows of values and deltas.
- `mix` scales today's positions per segment by mix% / current% (`mix_port`); a segment held at 0 gets one
  pseudo-position at the Book rate. A changed SIP is then split by the mix (`mix_weights`, Mutual Funds split by the
  current debt share, E16). With `sip` and `step` unchanged the flows stay the baseline's (R5 wins), so a mix equal
  to today's gives deltas of 0.

Sensitivities (R7)
- `sensitivity_scenarios` builds the four one-step changes (SIP up, retire 2 years later, returns 1 point lower,
  inflation 1 point higher) and `sensitivities` reads each one's retirement and worst-goal deltas from a compare.

Honesty: every value is a simulated estimate under the Book's assumptions; probabilities are "N of 100 futures",
p50 is "typical", p10/p90 the 1-in-10 bad and good cases (the `honesty` block travels with the payload).
"""
from __future__ import annotations

import math
from datetime import date

from .. import domain as d
from . import forecast
from . import simulate as S

FIELDS = ("name", "sip", "step", "return", "retire_age", "lump_sums", "inflation_pct", "mix")
BASELINE_NAME = "Today's plan"
MAX_SAVED = 5            # planScenarios holds up to 5 entries (R5)
MAX_COMPARE = 4          # POST /plan/compare takes up to 4 scenarios (R6)
MAX_COMPARE_GUEST = 2    # ... or 2 for a guest
GUEST_SIMS = 500
COMPARE_SIMS = 1000
SENSITIVITY_SIMS = 500   # R7: one compare at 500 sims for every role
MAX_LUMPS = 10
MIX_TOLERANCE = 0.5
NAME_MAX = 40
MIN_YEARS, MAX_YEARS = 10, 40
DEFAULT_CURRENT_AGE, DEFAULT_RETIRE_AGE = 30, 60   # forecast.RETIREMENT_DEFAULTS

# (lo, hi) of every numeric field (R5); `return` and `inflation_pct` may be null, `retire_age` is a whole number
RANGES = {"sip": (0.0, 1e8), "step": (0.0, 50.0), "return": (-10.0, 30.0), "retire_age": (15, 110),
          "inflation_pct": (0.0, 15.0)}
LUMP_MAX = 1e9


class ScenarioError(ValueError):
    """A scenario that breaks the R5 contract. `field` names the offending field ('sip', 'lump_sums[0].amount', …)
    and the message always reads "{field} {problem}", so a caller can prefix "Scenario {n}: " (the form W7-B2's
    `planScenarios` validator uses). `index` is the 0-based entry when the caller knows it."""

    def __init__(self, field: str, problem: str, index: int | None = None):
        super().__init__(f"{field} {problem}")
        self.field = field
        self.problem = problem
        self.index = index


def _number(raw, field: str, *, integer: bool = False) -> float | int:
    lo, hi = RANGES[field]
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(float(raw)):
        raise ScenarioError(field, "must be a number")
    v = float(raw)
    if not lo <= v <= hi:
        raise ScenarioError(field, f"must be between {lo:g} and {hi:g}")
    if integer and not v.is_integer():
        raise ScenarioError(field, "must be a whole number of years")
    return int(v) if integer else v


def _name(raw) -> str:
    if not isinstance(raw, str):
        raise ScenarioError("name", "must be text")
    name = raw.strip()
    if not 1 <= len(name) <= NAME_MAX:
        raise ScenarioError("name", f"must be 1 to {NAME_MAX} characters")
    return name


def _lump_sums(raw) -> list[dict]:
    if not isinstance(raw, list):
        raise ScenarioError("lump_sums", "must be a list of {date, amount}")
    if len(raw) > MAX_LUMPS:
        raise ScenarioError("lump_sums", f"can hold at most {MAX_LUMPS} amounts")
    out = []
    for j, item in enumerate(raw):
        field = f"lump_sums[{j}]"
        if not isinstance(item, dict):
            raise ScenarioError(field, "must be an object with date and amount")
        when = item.get("date")
        try:
            day = date.fromisoformat(when) if isinstance(when, str) and len(when) == 10 else None
        except ValueError:
            day = None
        if day is None:
            raise ScenarioError(f"{field}.date", "must be a date (YYYY-MM-DD)")
        amt = item.get("amount")
        if isinstance(amt, bool) or not isinstance(amt, (int, float)) or not math.isfinite(float(amt)):
            raise ScenarioError(f"{field}.amount", "must be a number")
        if not 0 <= float(amt) <= LUMP_MAX:
            raise ScenarioError(f"{field}.amount", f"must be between 0 and {LUMP_MAX:g}")
        out.append({"date": day.isoformat(), "amount": float(amt)})
    return out


def _mix(raw) -> dict[str, float]:
    """{segment: pct} as given (floats, the caller's order, zero shares kept); `mix_key` is the canonical form."""
    if not isinstance(raw, dict):
        raise ScenarioError("mix", "must be an object of class → percent")
    out: dict[str, float] = {}
    for seg, pct in raw.items():
        if seg not in d.SEGMENTS:
            raise ScenarioError("mix", f"names an unknown class '{seg}'")
        if isinstance(pct, bool) or not isinstance(pct, (int, float)) or not math.isfinite(float(pct)) \
                or not 0 <= float(pct) <= 100:
            raise ScenarioError("mix", f"{seg} must be a percent between 0 and 100")
        out[seg] = float(pct)
    total = sum(out.values())
    if abs(total - 100) > MIX_TOLERANCE:
        raise ScenarioError("mix", f"adds up to {total:g}%; it must total 100%")
    return out


def mix_key(mix: dict[str, float] | None) -> dict[str, float] | None:
    """A mix in canonical form (segment order, zero shares dropped), so equal mixes compare and memoise equal."""
    if not mix:
        return None
    return {seg: float(mix[seg]) for seg in d.SEGMENTS if float(mix.get(seg) or 0) > 0}


def validate_scenario(raw, *, partial: bool = False) -> dict:
    """One PlanScenario checked against R5 and returned with all eight keys (unknown keys dropped).

    - `name`: trimmed text, 1–40 characters; `sip`: 0–1e8; `step`: 0–50; `return`: null or −10..30;
      `retire_age`: null or a whole number 15–110; `lump_sums`: ≤ 10 × {date YYYY-MM-DD, amount 0–1e9};
      `inflation_pct`: null or 0..15; `mix`: null or {segment of domain.SEGMENTS: 0–100} summing to 100 ± 0.5.
      Numbers must be JSON numbers (a string "60000" is refused).
    - `partial=False` (a saved entry): `name`, `sip` and `step` are required; an absent nullable field is null and
      absent `lump_sums` is [].
    - `partial=True` (inline in POST /plan/compare): every field is optional, and null or absent stays None,
      meaning "the baseline's value" (`resolve` fills it; a missing name reads "Scenario {n}").
    Raises ScenarioError (a ValueError) whose message is "{field} {problem}"."""
    if not isinstance(raw, dict):
        raise ScenarioError("scenario", "must be an object")
    out: dict = {}
    if raw.get("name") is None:
        if not partial:
            raise ScenarioError("name", "must be text")
        out["name"] = None
    else:
        out["name"] = _name(raw["name"])
    for f in ("sip", "step"):
        if raw.get(f) is None and not partial:
            raise ScenarioError(f, "is required")
    for f in ("sip", "step", "return", "inflation_pct"):
        out[f] = _number(raw[f], f) if raw.get(f) is not None else None
    out["retire_age"] = _number(raw["retire_age"], "retire_age", integer=True) \
        if raw.get("retire_age") is not None else None
    if raw.get("lump_sums") is not None:
        out["lump_sums"] = _lump_sums(raw["lump_sums"])
    else:
        out["lump_sums"] = None if partial else []
    out["mix"] = _mix(raw["mix"]) if raw.get("mix") is not None else None
    return {f: out[f] for f in FIELDS}


def validate_saved(value) -> list[dict]:
    """The `planScenarios` setting: a list of at most 5 full scenarios (None clears it). Raises ScenarioError; an
    entry's message reads "Scenario {n}: {field} {problem}" with n 1-based, as W7-B2's route words it."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ScenarioError("planScenarios", "must be a list of scenarios")
    if len(value) > MAX_SAVED:
        raise ScenarioError("planScenarios", f"can hold up to {MAX_SAVED} scenarios")
    out = []
    for i, raw in enumerate(value):
        try:
            out.append(validate_scenario(raw))
        except ScenarioError as e:
            err = ScenarioError(e.field, e.problem, index=i)
            err.args = (f"Scenario {i + 1}: {e}",)
            raise err from None
    return out


# ── the baseline and resolution (R5) ──

def _opt_float(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def typed_sip(saved: dict | None) -> bool:
    """L5: the saved retirement plan names a SIP, so that typed amount (with its step-up) is today's plan."""
    return bool(saved) and _opt_float(saved.get("monthly_sip")) is not None


def baseline(saved: dict | None, plans_total: float) -> dict:
    """"Today's plan" (R5): `sip` = the saved retirementPlan.monthly_sip when set, else the plans' monthly total;
    `step` = the saved step_up_pct or 0; `retire_age` = the saved value or null; the rest null / []."""
    saved = saved if isinstance(saved, dict) else {}
    sip = _opt_float(saved.get("monthly_sip"))
    ra = _opt_float(saved.get("retire_age"))
    return {"name": BASELINE_NAME, "sip": round(float(sip if sip is not None else plans_total or 0.0), 2),
            "step": float(_opt_float(saved.get("step_up_pct")) or 0.0), "return": None,
            "retire_age": int(ra) if ra is not None else None, "lump_sums": [], "inflation_pct": None, "mix": None}


def resolve(sc: dict, base: dict, n: int) -> dict:
    """A validated scenario with every null filled from the baseline; a missing name reads "Scenario {n}"."""
    out = {f: (sc.get(f) if sc.get(f) is not None else base.get(f)) for f in FIELDS}
    out["name"] = sc.get("name") or f"Scenario {n}"
    out["lump_sums"] = list(out["lump_sums"] or [])
    return out


SIP_TOLERANCE = 1.0   # ₹: a SIP within a rupee of the baseline's is the baseline's (a prefill rounded to ₹4,333)


def flows_unchanged(sc: dict, base: dict) -> bool:
    """R5: `sip` (within ₹1, SIP_TOLERANCE) and `step` both equal the baseline's, so the column's money flows exactly
    as today's."""
    return abs(float(sc["sip"]) - float(base["sip"])) < SIP_TOLERANCE and float(sc["step"]) == float(base["step"])


def plans_adjust(sc: dict, base: dict, inp: dict) -> dict | None:
    """How a changed SIP reshapes the plans when today's plan runs on them (W7 review fixes, amending R5).

    {scale, step_pct}: every plan instalment × sip / baseline sip, and × (1 + step) / (1 + baseline step) per
    whole year from today. That keeps each plan's own step-up, end date and future start, as `run_goals` already
    scales the goal flows. None when the flows are unchanged, when the SIP is typed (L5: the column invests `sip`
    with `step` as one amount, as the baseline does), or when no plan runs today (baseline sip 0), where there is
    nothing to scale and the column invests `sip` with `step` as one amount."""
    if flows_unchanged(sc, base) or typed_sip(inp.get("saved")) or not inp.get("sips") or float(base["sip"]) <= 0:
        return None
    step = 0.0
    if float(sc["step"]) != float(base["step"]):
        step = ((1 + float(sc["step"]) / 100) / (1 + float(base["step"]) / 100) - 1) * 100
    return {"scale": float(sc["sip"]) / float(base["sip"]), "step_pct": step}


def compute_key(sc: dict) -> dict:
    """The scenario without its name, its mix canonical: what decides a column's numbers (memo keys share equal
    columns)."""
    return {**{f: sc[f] for f in FIELDS if f not in ("name", "mix")}, "mix": mix_key(sc.get("mix"))}


# ── the horizon (R6) ──

def horizon_years(columns: list[dict], *, saved: dict | None, goals: list[dict], today: date) -> int:
    """H = clamp(max(10, years to the latest retire_age across columns when a retirement plan is saved, years to
    the furthest goal), 1, 40)."""
    years = [MIN_YEARS]
    if saved:
        cur = _opt_float(saved.get("current_age")) or DEFAULT_CURRENT_AGE
        for c in columns:
            ra = c.get("retire_age") or _opt_float(saved.get("retire_age")) or DEFAULT_RETIRE_AGE
            years.append(int(math.ceil(float(ra) - float(cur))))
    for g in goals:
        due = S._date(g.get("target_date"))
        if due is not None and due > today:
            years.append(int(math.ceil(S.month_index(today, due) / 12)))
    return max(1, min(max(years), MAX_YEARS))


# ── the mix (R6, E16) ──

def _seg(p: dict) -> str | None:
    try:
        return p.get("segment") or d.segment_of(p)
    except (KeyError, TypeError):
        return None


def _open_value(p: dict) -> float:
    try:
        v = float(p.get("value") or 0)
    except (TypeError, ValueError):
        return 0.0
    return v if p.get("is_open", True) and v > 0 else 0.0


def current_mix(port: dict) -> dict[str, float]:
    """Today's value by segment, in percent of the whole: from the open positions (what `mix_port` scales), else
    from the segment values."""
    vals: dict[str, float] = {}
    for p in port.get("positions") or []:
        v, seg = _open_value(p), _seg(p)
        if v > 0 and seg:
            vals[seg] = vals.get(seg, 0.0) + v
    if not vals:
        for s in port.get("segments") or []:
            v = float(s.get("value") or 0)
            if v > 0:
                vals[s["segment"]] = vals.get(s["segment"], 0.0) + v
    tot = sum(vals.values())
    return {k: v / tot * 100 for k, v in vals.items()} if tot > 0 else {}


_SCALED = ("value", "cost", "invested", "outstanding", "maturity_value")


def mix_port(port: dict, mix: dict[str, float]) -> dict:
    """A copy of `port` whose positions are scaled per segment by mix% / current% (value, cost, invested,
    outstanding and maturity value, as `forecast._funded_positions` scales). A segment held at 0 with a mix share
    gets one pseudo-position at the Book rate (an FD with no maturity, a P2P pool). The mix is normalised to 100,
    so the total is unchanged; `segments` and `totals.value` follow."""
    positions = port.get("positions") or []
    cur: dict[str, float] = {}
    for p in positions:
        v, seg = _open_value(p), _seg(p)
        if v > 0 and seg:
            cur[seg] = cur.get(seg, 0.0) + v
    if not cur:
        for s in port.get("segments") or []:
            v = float(s.get("value") or 0)
            if v > 0:
                cur[s["segment"]] = cur.get(s["segment"], 0.0) + v
    total = sum(cur.values())
    msum = sum(mix.values()) or 100.0
    want = {seg: total * pct / msum for seg, pct in mix.items() if pct > 0}
    out_pos = []
    for p in positions:
        seg = _seg(p)
        if _open_value(p) <= 0 or not seg or cur.get(seg, 0) <= 0:
            out_pos.append(p)
            continue
        f = want.get(seg, 0.0) / cur[seg]
        q = dict(p)
        for fld in _SCALED:
            if q.get(fld) not in (None, ""):
                try:
                    q[fld] = float(q[fld]) * f
                except (TypeError, ValueError):
                    pass
        out_pos.append(q)
    for seg, v in want.items():
        if cur.get(seg, 0) <= 0 and seg in forecast._SEG_ASSET_CLASS:
            out_pos.append({"id": None, "name": f"{seg} (proposed)", "segment": seg,
                            "asset_class": forecast._SEG_ASSET_CLASS[seg], "value": v, "cost": v, "invested": v,
                            "is_open": True})
    segments = [{"segment": seg, "value": v} for seg, v in want.items()]
    totals = {**(port.get("totals") or {}), "value": total}
    return {**port, "positions": out_pos, "segments": segments, "totals": totals}


def mix_weights(mix: dict[str, float], positions) -> dict[str, float]:
    """{Book key: share} for splitting a SIP by the mix: Mutual Funds split by today's debt share of fund value
    (E16, `optimizer._split_mf`)."""
    from . import optimizer   # inside: optimizer imports tax, which this module does not otherwise need
    tot = sum(v for v in mix.values() if v > 0) or 1.0
    seg_w = {k: v / tot for k, v in mix.items() if v > 0}
    return optimizer._split_mf(seg_w, optimizer._debt_share(positions))


# ── one column (R6) ──

def _goal_specs(goals: list[dict], sips: list[dict], state: dict, today: date, scale: float) -> tuple[list, list]:
    """(flows, specs) for valuing the goals on the same draws, as `forecast._plan_impact` builds them: each goal's
    share of each class's starting value, plus its linked SIP plans (else its monthly contribution) as goal-only
    flows, every amount × `scale` (column sip / baseline sip)."""
    flows: list[dict] = []
    specs: list[dict] = []
    for g in goals:
        due = S._date(g.get("target_date"))
        if due is None:
            continue
        m = S.month_index(today, due)
        if m < 1:
            continue
        alloc = forecast._allocation(g.get("allocation"))
        linked = [s for s in sips or [] if s.get("goal_id") is not None and s.get("goal_id") == g.get("id")]
        own = S.flows_from_sips(linked, state=state, today=today, horizon_months=m) if linked else []
        if not own and forecast._f(g.get("monthly_contribution")) > 0:
            w = {k: x for k, x in forecast._goal_alloc(alloc).items() if k in S.STOCH} or {d.SEG_MF: 1.0}
            own = S.lump_flow(forecast._f(g.get("monthly_contribution")), state=state, today=today, horizon_months=m,
                              weights=w)
        idx = []
        for fl in own:
            fl = {**fl, "months": {k: v * scale for k, v in fl["months"].items()}, "goal_only": True}
            idx.append(len(flows))
            flows.append(fl)
        specs.append({"id": g.get("id"), "alloc": forecast._goal_alloc(alloc), "target": forecast._f(g.get("target_amount")),
                      "month": m, "flows": idx})
    return flows, specs


# The fields each part of a column reads, so a caller can memoise a part on exactly those (a scenario that changes
# only `retire_age` or `inflation_pct` re-runs only the retirement part). The projection's inflation feeds only its
# real_p50 and assumptions block, which compare never reads outside the baseline column, so it is not a projection
# field; goal targets are nominal and the lump sums are not goal flows (R6).
PROJECTION_FIELDS = ("sip", "step", "return", "lump_sums", "mix")
GOAL_FIELDS = ("sip", "return", "mix")


def part_key(sc: dict, fields: tuple[str, ...]) -> dict:
    """The scenario fields one part reads (mix canonical), for a memo key."""
    return {f: (mix_key(sc.get("mix")) if f == "mix" else sc.get(f)) for f in fields}


def _column_setup(sc: dict, base: dict, inp: dict) -> tuple[bool, dict, dict | None]:
    """(flows unchanged, the column's port, the SIP split) for a scenario: `mix` scales today's positions, and a
    changed SIP is split by the mix (R6); unchanged flows stay the baseline's (R5)."""
    unchanged = flows_unchanged(sc, base)
    port, sip_w = inp["port"], None
    if sc.get("mix"):
        if not unchanged:
            sip_w = mix_weights(sc["mix"], port.get("positions"))
        port = mix_port(port, sc["mix"])
    return unchanged, port, sip_w


def run_projection(sc: dict, base: dict, inp: dict, *, years: int, sims: int) -> dict:
    """The column's projection (R6 step 1): `project_portfolio` over the shared horizon on seed 42, with the
    column's flows, return, lump sums and mix. Reads only PROJECTION_FIELDS; the inflation is always `inp`'s.
    Returns {p10, p50, p90, path_p50, path_p10, path_p90, assumptions, requested_return_pct, sims}."""
    unchanged, port, sip_w = _column_setup(sc, base, inp)
    adj = plans_adjust(sc, base, inp)
    if unchanged:
        monthly, step = (float(base["sip"]), float(base["step"])) if typed_sip(inp.get("saved")) else (None, 0.0)
    elif adj is not None:
        monthly, step = None, 0.0
    else:
        monthly, step = float(sc["sip"]), float(sc["step"])
    proj = forecast.project_portfolio(
        port, inp.get("perf"), years=years, monthly_sip=monthly, step_up_pct=step, sims=sims, today=inp["today"],
        return_override=sc.get("return"), inflation=inp.get("inflation"), sips=inp.get("sips"),
        txns=inp.get("txns"), instruments=inp.get("instruments"), targets=inp.get("targets"),
        slab_rate=inp.get("slab_rate", 0.30), book=inp["book"], extra_flows=sc.get("lump_sums") or None,
        sip_weights=sip_w, plans_scale=adj["scale"] if adj else 1.0, plans_step_pct=adj["step_pct"] if adj else 0.0)
    return {"p10": proj["end"]["p10"], "p50": proj["end"]["p50"], "p90": proj["end"]["p90"],
            "path_p50": [r["p50"] for r in proj["path"]], "path_p10": [r["p10"] for r in proj["path"]],
            "path_p90": [r["p90"] for r in proj["path"]], "assumptions": proj["assumptions"],
            "requested_return_pct": proj["assumptions"].get("requested_return_pct"), "sims": proj["sims"]}


def run_retirement(sc: dict, base: dict, inp: dict, *, sims: int) -> dict | None:
    """The column's retirement (R6 step 2, only with a saved plan; None otherwise): `retirement_plan` on seed 7 with
    the column's SIP and step (or the plans when unchanged), retire_age, inflation (else the saved one, else the
    Book's), return, lump sums, mix, /plan's funding and the base Book. Reads every field.
    Returns {retire_age, probability, lasts, needed, life_expectancy}. Raises ValueError when retire_age ≤
    current_age."""
    saved = inp.get("saved")
    if not saved:
        return None
    unchanged, port, sip_w = _column_setup(sc, base, inp)
    book = inp["book"]
    params = dict(saved)
    if sc.get("retire_age") is not None:
        params["retire_age"] = sc["retire_age"]
    if sc.get("inflation_pct") is not None:
        params["inflation_pct"] = sc["inflation_pct"]
    elif _opt_float(saved.get("inflation_pct")) is None:
        params["inflation_pct"] = forecast.book_inflation_pct(book)
    if sc.get("return") is not None:
        params["return_pct"] = sc["return"]
    adj = plans_adjust(sc, base, inp)
    if adj is not None:
        params["step_up_pct"] = float(sc["step"])      # the deterministic figures; the plans carry their own
    elif not unchanged:
        params["monthly_sip"], params["step_up_pct"] = float(sc["sip"]), float(sc["step"])
    ret = forecast.retirement_plan(port, inp.get("perf"), params, today=inp["today"], sims=sims,
                                   funding=inp.get("funding"), txns=inp.get("txns"),
                                   instruments=inp.get("instruments"), sips=inp.get("sips"), book=book,
                                   extra_flows=sc.get("lump_sums") or None, sip_weights=sip_w,
                                   plans_scale=adj["scale"] if adj else 1.0,
                                   plans_step_pct=adj["step_pct"] if adj else 0.0)
    return {"retire_age": ret["inputs"]["retire_age"], "probability": ret["probability"],
            "lasts": ret["probability_lasts"], "needed": ret["required_sip"],
            "life_expectancy": ret["inputs"]["life_expectancy"]}


def run_goals(sc: dict, base: dict, inp: dict, *, sims: int) -> dict:
    """The column's goal chances (R6 step 3): one `simulate.run` on seed 7 valuing every unachieved goal, built as
    `forecast._plan_impact` builds them, each goal's flows × column sip / baseline sip. Return override and mix
    apply; inflation does not (targets are nominal). Reads only GOAL_FIELDS. Returns {goal id: probability}."""
    goals = inp.get("goals") or []
    if not goals:
        return {}
    today, book = inp["today"], inp["book"]
    _unchanged, port, _sip_w = _column_setup(sc, base, inp)
    a = forecast.blended_assumptions(port["segments"], inp.get("perf"), positions=port.get("positions"), book=book)
    mu = a["mu"] if sc.get("return") is None else max(min(float(sc["return"]) / 100, 0.30), -0.10)
    cal_book = forecast._calibrate(a["book"], a["weights"], mu, a["sigma"], base=book)[0]
    state = S.build_state(forecast._sim_positions(port), book=a["book"], today=today, txns=inp.get("txns"),
                          instruments=inp.get("instruments"), targets=inp.get("targets"))
    # only `sip` (GOAL_FIELDS): within SIP_TOLERANCE of the baseline's it is the baseline's
    same_sip = abs(float(sc["sip"]) - float(base["sip"])) < SIP_TOLERANCE
    scale = float(sc["sip"]) / float(base["sip"]) if float(base["sip"]) > 0 and not same_sip else 1.0
    flows, specs = _goal_specs(goals, inp.get("sips"), state, today, scale)
    if not specs:
        return {}
    horizon = max(s["month"] for s in specs)
    r = S.run(state, flows, cal_book, horizon_months=horizon, sims=sims, seed=forecast.RETIREMENT_SEED, goals=specs)
    return {g["id"]: g["probability"] for g in r["goals"]}


def run_column(sc: dict, base: dict, inp: dict, *, years: int, sims: int) -> dict:
    """One compare column on the baseline's seeds (R6): its three parts.

    `inp`: {port, perf, sips, txns, instruments, targets, slab_rate, book, today, saved (the saved retirementPlan,
    unmerged, or None), funding, goals (unachieved goal rows), inflation (the projection's default, a fraction or
    None)}. Returns {projection {p10, p50, p90, path_p50, path_p10, path_p90, assumptions, requested_return_pct,
    sims}, retirement {retire_age, probability, lasts, needed, life_expectancy} | None, goals {id: probability}}.
    Raises ValueError when the column's retirement ages do not work (retire_age ≤ current_age)."""
    return {"projection": run_projection(sc, base, inp, years=years, sims=sims),
            "retirement": run_retirement(sc, base, inp, sims=sims),
            "goals": run_goals(sc, base, inp, sims=sims)}


# ── the payload (R6) ──

def _delta(v, b, first: bool):
    if v is None or b is None:
        return None
    return 0 if first else round(float(v) - float(b), 2)


def _row(key: str, label: str, fmt: str, values: list) -> dict:
    base = values[0]
    return {"key": key, "label": label, "format": fmt, "values": values,
            "deltas": [_delta(v, base, i == 0) for i, v in enumerate(values)]}


def build_compare(scenarios: list[dict], cols: list[dict], *, goals: list[dict], years: int, sims: int,
                  today: date, honesty: dict) -> dict:
    """The PlanCompare payload (K19 + R6) from resolved scenarios (column 0 is the baseline) and their columns.

    Rows, in order: p10, p50, p90 (inr); with a saved retirement plan retire_age (age), retirement and lasts (pct)
    and needed (inr); then one `goal:<id>` (pct) per goal, worst baseline first. Deltas are value − baseline, null
    where either is null, 0 in column 0."""
    rows = [
        _row("p10", f"1-in-10 bad case in {years} yrs", "inr", [c["projection"]["p10"] for c in cols]),
        _row("p50", f"Typical in {years} yrs", "inr", [c["projection"]["p50"] for c in cols]),
        _row("p90", f"1-in-10 good case in {years} yrs", "inr", [c["projection"]["p90"] for c in cols]),
    ]
    base_ret = cols[0].get("retirement")
    if base_ret is not None:
        def ret(k):
            return [(c.get("retirement") or {}).get(k) for c in cols]
        rows += [_row("retire_age", "Retirement age", "age", ret("retire_age")),
                 _row("retirement", "Chance of reaching the corpus", "pct", ret("probability")),
                 _row("lasts", f"Money lasts to {base_ret['life_expectancy']}", "pct", ret("lasts")),
                 _row("needed", "Monthly needed for retirement", "inr", ret("needed"))]
    goal_rows = []
    for g in goals:
        vals = [c["goals"].get(g.get("id")) for c in cols]
        if vals[0] is None and all(v is None for v in vals):
            continue
        goal_rows.append((vals[0] if vals[0] is not None else 101.0, str(g.get("name") or ""),
                          _row(f"goal:{g.get('id')}", str(g.get("name") or f"Goal {g.get('id')}"), "pct", vals)))
    rows += [r for _, _, r in sorted(goal_rows, key=lambda t: (t[0], t[1]))]
    base_p = cols[0]["projection"]
    return {
        "columns": [s["name"] for s in scenarios],
        "rows": rows,
        "paths": [{"name": s["name"], "p50": c["projection"]["path_p50"]} for s, c in zip(scenarios, cols)],
        "band": {"p10": base_p["path_p10"], "p90": base_p["path_p90"]},
        "labels": [str(today.year + y) for y in range(len(base_p["path_p50"]))],
        "years": years,
        "sims": base_p["sims"],
        "assumptions": base_p["assumptions"],
        "honesty": honesty,
        "baseline": scenarios[0],
        "scenarios": scenarios,
    }


# ── sensitivities (R7) ──

def inr(v: float) -> str:
    """₹ with Indian digit grouping: ₹5,000, ₹1,20,000."""
    n = int(round(abs(float(v))))
    s = str(n)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts) + "," + tail
    return ("−" if float(v) < 0 else "") + "₹" + s


def sip_bump(sip: float) -> float:
    """R7: max(₹5,000, 10% of the SIP rounded to ₹1,000)."""
    return float(max(5000.0, round(0.10 * float(sip), -3)))


def sensitivity_scenarios(base: dict, *, saved: dict | None, requested_return_pct: float | None,
                          inflation_pct: float) -> list[dict]:
    """The four R7 changes as [{key, label, change, scenario}], each scenario a full resolved PlanScenario:
    - sip: sip + max(5000, round(0.10 × sip, −3)); `change` is that ₹ figure;
    - retire: retire_age + 2, only with a saved retirement plan (otherwise the scenario is the baseline);
    - returns: return = the baseline's requested return (μ*) − 1, to 0.1 point (`change` −1);
    - inflation: inflation_pct = the saved (or the Book's) inflation + 1 (`change` 1)."""
    bump = sip_bump(base["sip"])
    items = [{"key": "sip", "label": f"SIP +{inr(bump)}/month", "change": bump,
              "scenario": {**base, "name": f"SIP +{inr(bump)}/month", "sip": round(float(base["sip"]) + bump, 2)}}]
    if saved:
        ra = base.get("retire_age") or int(_opt_float(saved.get("retire_age")) or DEFAULT_RETIRE_AGE)
        items.append({"key": "retire", "label": "Retire 2 years later", "change": 2,
                      "scenario": {**base, "name": "Retire 2 years later", "retire_age": min(int(ra) + 2, 110)}})
    else:
        items.append({"key": "retire", "label": "Retire 2 years later", "change": 2, "scenario": dict(base)})
    req = requested_return_pct if requested_return_pct is not None else 0.0
    ret = max(min(round(float(req) - 1, 1), RANGES["return"][1]), RANGES["return"][0])
    items.append({"key": "returns", "label": "Returns 1 point lower", "change": -1,
                  "scenario": {**base, "name": "Returns 1 point lower", "return": ret}})
    infl = max(min(round(float(inflation_pct) + 1, 2), RANGES["inflation_pct"][1]), RANGES["inflation_pct"][0])
    items.append({"key": "inflation", "label": "Inflation 1 point higher", "change": 1,
                  "scenario": {**base, "name": "Inflation 1 point higher", "inflation_pct": infl}})
    return items


def sensitivities(items: list[dict], compare: dict, *, retirement_saved: bool) -> list[dict]:
    """Each R7 item with `retirement_pts` (Δ of the `retirement` row; null without a saved plan, and for `retire`
    when there is none), `worst_goal_pts` (Δ of the goal with the lowest baseline probability in this compare;
    null without goals) and `worst_goal` {id, name} naming that goal (null without goals), so the client labels
    the delta with the goal it belongs to (W7 review fixes). `compare` holds the baseline in column 0 and the items
    in columns 1–4, in order."""
    rows = {r["key"]: r for r in compare["rows"]}
    ret_row = rows.get("retirement")
    goal_row = next((r for r in compare["rows"] if r["key"].startswith("goal:")), None)
    worst = None
    if goal_row is not None:
        gid = goal_row["key"][len("goal:"):]
        worst = {"id": int(gid) if gid.lstrip("-").isdigit() else gid, "name": goal_row["label"]}
    out = []
    for i, it in enumerate(items, start=1):
        rp = ret_row["deltas"][i] if ret_row is not None and retirement_saved else None
        out.append({"key": it["key"], "label": it["label"], "change": it["change"], "retirement_pts": rp,
                    "worst_goal_pts": goal_row["deltas"][i] if goal_row is not None else None,
                    "worst_goal": dict(worst) if worst else None, "scenario": it["scenario"]})
    return out
