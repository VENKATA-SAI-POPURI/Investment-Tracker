"""Forecasting and planning: portfolio projection, stress tests, retirement planner, cash-flow calendar,
portfolio risk, per-holding outlook, the allocation lab, SIP plans, and the P1 Plan hub and Assumption Book
(AMENDMENTS H6, H7, H9)."""
from __future__ import annotations

import math

from flask import Blueprint, current_app, g, jsonify, request

from .. import domain as d
from ..analytics.optimizer import PROFILES
from ..ledger import ValidationError
from ..security import write_required

bp = Blueprint("forecast_api", __name__)

RETIREMENT_KEYS = ("current_age", "retire_age", "life_expectancy", "monthly_expenses", "inflation_pct", "post_return_pct",
                   "monthly_sip", "step_up_pct", "return_pct", "other_income_monthly")


def L():
    return current_app.extensions["ledger"]


def S():
    return current_app.extensions["services"]


def body() -> dict:
    return request.get_json(silent=True) or {}


def _num(name: str, default=None, lo: float | None = None, hi: float | None = None, required: bool = False):
    raw = request.args.get(name)
    if raw in (None, ""):
        if required:
            raise ValidationError(f"{name} is required")
        return default
    try:
        v = float(raw)
    except ValueError:
        raise ValidationError(f"{name} must be a number")
    if lo is not None and v < lo or hi is not None and v > hi:
        raise ValidationError(f"{name} must be between {lo:g} and {hi:g}")
    return v


GUEST_SIMS = 500  # guests share the server: their simulations are capped (SPEC §7.8)


def _flag(name: str) -> bool:
    """A boolean query flag: `1`/`true`/`yes` is on; absent, empty, `0`/`false`/`no` is off; anything else is a 400."""
    raw = (request.args.get(name) or "").strip().lower()
    if raw in ("", "0", "false", "no"):
        return False
    if raw in ("1", "true", "yes"):
        return True
    raise ValidationError(f"{name} must be 1 or 0")


@bp.get("/forecast")
def project():
    """Monte Carlo projection. `sims` is 200–2000 (default 1000) and silently capped at 500 for guests;
    `return` is rounded to 0.5 points and `sip` to the nearest ₹100 so the memo key space stays small.
    Without `sip` the SIP plans run on their own dates and classes (K9, R3). `after_tax=1` adds `end.after_tax`
    (D5). The payload's `sims` is the number actually used."""
    years = int(_num("years", 10, 1, 40))
    sip = _num("sip", None, 0, 1e8)
    step = _num("step", 0, 0, 50)
    sims = int(_num("sims", 1000, 200, 2000))
    if getattr(g, "role", None) == "guest":
        sims = min(sims, GUEST_SIMS)
    ret = _num("return", None, -10, 30)
    if ret is not None:
        ret = round(ret * 2) / 2
    if sip is not None:
        sip = float(round(sip / 100) * 100)
    return jsonify(S().forecast(g.scope, S().settings(), years, sip, step, sims, ret, after_tax=_flag("after_tax")))


@bp.get("/forecast/stress")
def stress():
    """The stress test with `plan_impact` (K11, R3): β from a warm risk memo, the retirement and goal chances
    before and after each falling scenario."""
    return jsonify(S().stress_detail(g.scope, S().settings()))


@bp.get("/forecast/retirement")
def retirement():
    params = {k: _num(k) for k in RETIREMENT_KEYS}
    for k in ("current_age", "retire_age", "life_expectancy"):
        if params[k] is not None and not 15 <= params[k] <= 110:
            raise ValidationError(f"{k} must be between 15 and 110")
    try:
        # the saved plan is merged in services, so the engine checks the ages after the merge
        return jsonify(S().retirement(g.scope, S().settings(), params))
    except ValueError as e:
        raise ValidationError(str(e))


@bp.get("/forecast/cashflow")
def cashflow():
    return jsonify(S().cashflow(g.scope, S().settings(), int(_num("months", 12, 1, 36))))


@bp.get("/risk")
def risk():
    return jsonify(S().risk(g.scope, S().settings()))


@bp.get("/instruments/<int:iid>/outlook")
def outlook(iid):
    return jsonify(S().outlook(g.scope, S().settings(), iid))


@bp.get("/optimizer")
def optimizer():
    profile = (request.args.get("profile") or (S().settings().get("riskProfile") or "balanced")).lower()
    if profile not in {p["key"] for p in PROFILES}:
        raise ValidationError("profile must be one of " + ", ".join(p["key"] for p in PROFILES))
    return jsonify(S().optimizer(g.scope, S().settings(), profile))


# ── the Plan hub and the Assumption Book (P1.1, P1.2) ──

@bp.get("/plan")
def plan():
    """Goals, retirement (only when a plan is saved), funding, cushion, the SIP block, counts and ▲/▼ deltas in one
    read (AMENDMENTS H6). Never rebuilt by an action status POST. `detail=1` adds `baseline` and the four
    `sensitivities` (R7), memoised apart so the plain /plan stays fast. /plan takes no `after_tax` (R3)."""
    if _flag("detail"):
        return jsonify(S().plan_detail(g.scope, S().settings()))
    return jsonify(S().plan(g.scope, S().settings()))


COMPARE_MAX, COMPARE_MAX_GUEST = 4, 2
COMPARE_SIMS = 1000


@bp.post("/plan/compare")
def plan_compare():
    """Scenarios side by side (§6.10, AMENDMENTS R5, R6). Body {scenarios: (index | inline)[]}: an index is 0-based
    into the saved `planScenarios`; an inline scenario may leave any field null or out (= today's plan). Up to 4
    scenarios at 1,000 sims, or 2 at 500 for a guest. Read-only, so guests may use it (not write_required)."""
    raw = body().get("scenarios")
    if not isinstance(raw, list):
        raise ValidationError("scenarios must be a list of saved indexes or scenario objects")
    guest = getattr(g, "role", None) == "guest"
    if guest and len(raw) > COMPARE_MAX_GUEST:
        raise ValidationError(f"Guests can compare up to {COMPARE_MAX_GUEST} scenarios")
    if len(raw) > COMPARE_MAX:
        raise ValidationError(f"Compare up to {COMPARE_MAX} scenarios at a time")
    settings = S().settings()
    try:
        scenarios = S().resolve_scenarios(g.scope, settings, raw)
        return jsonify(S().compare(g.scope, settings, scenarios, GUEST_SIMS if guest else COMPARE_SIMS))
    except ValueError as e:
        raise ValidationError(str(e))


MIX_TOLERANCE = 0.5


def parse_mix(raw: str | None) -> dict[str, float] | None:
    """`?mix=<segment>:<pct>,...` (D2, H7): every name a domain segment, every pct 0–100, summing to 100 ± 0.5.
    None when absent; anything else raises ValidationError."""
    if raw in (None, ""):
        return None
    out: dict[str, float] = {}
    for part in raw.split(","):
        name, sep, pct = part.strip().rpartition(":")
        name = name.strip()
        if not sep or name not in d.SEGMENTS:
            raise ValidationError(f"mix: unknown segment {name or part.strip()!r}")
        if name in out:
            raise ValidationError(f"mix: {name} is listed twice")
        try:
            v = float(pct)
        except ValueError:
            raise ValidationError(f"mix: {name} needs a percentage")
        if not math.isfinite(v) or not 0 <= v <= 100:
            raise ValidationError(f"mix: {name} must be between 0 and 100")
        out[name] = v
    total = sum(out.values())
    if abs(total - 100) > MIX_TOLERANCE:
        raise ValidationError(f"mix adds up to {total:g}%; it must total 100%")
    return out


@bp.get("/assumptions")
def assumptions():
    """The Assumption Book for this portfolio (§6.1, AMENDMENTS H7); `?mix=` adds the `proposed` chip (D2)."""
    return jsonify(S().assumptions_view(g.scope, S().settings(), parse_mix(request.args.get("mix"))))


# ── SIP plans ──

@bp.get("/sips")
def sips():
    """The plans with their adherence (6 months, skips from the action log) and the money arriving to invest
    (AMENDMENTS H9): `arriving_total` equals brief.deploy.suggested."""
    return jsonify(S().sips_view(g.scope, S().settings()))


@bp.post("/sips")
@write_required
def add_sip():
    return jsonify(L().save_sip(g.owner, g.scope, body())), 201


@bp.put("/sips/<int:sid>")
@write_required
def update_sip(sid):
    return jsonify(L().save_sip(g.owner, g.scope, body(), sid))


@bp.delete("/sips/<int:sid>")
@write_required
def delete_sip(sid):
    L().delete_sip(sid, g.scope)
    return jsonify({"message": "SIP plan deleted"})
