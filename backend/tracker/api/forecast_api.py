"""Forecasting and planning: portfolio projection, stress tests, retirement planner, cash-flow calendar,
portfolio risk, per-holding outlook, the allocation lab and SIP plans."""
from __future__ import annotations

from flask import Blueprint, current_app, g, jsonify, request

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


@bp.get("/forecast")
def project():
    years = int(_num("years", 10, 1, 40))
    sip = _num("sip", None, 0, 1e8)
    step = _num("step", 0, 0, 50)
    sims = int(_num("sims", 2000, 200, 5000))
    ret = _num("return", None, -10, 30)
    return jsonify(S().forecast(g.scope, S().settings(), years, sip, step, sims, ret))


@bp.get("/forecast/stress")
def stress():
    return jsonify(S().stress(g.scope, S().settings()))


@bp.get("/forecast/retirement")
def retirement():
    params = {k: _num(k) for k in RETIREMENT_KEYS}
    for k in ("current_age", "retire_age", "life_expectancy"):
        if params[k] is not None and not 15 <= params[k] <= 110:
            raise ValidationError(f"{k} must be between 15 and 110")
    return jsonify(S().retirement(g.scope, S().settings(), params))


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


# ── SIP plans ──

@bp.get("/sips")
def sips():
    rows = L().sips(g.scope)
    return jsonify({"plans": rows, "monthly_total": S().monthly_sip_total(rows)})


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
