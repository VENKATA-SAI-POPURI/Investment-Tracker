from datetime import date, timedelta

from flask import Blueprint, current_app, g, jsonify, request

from .. import ai
from .. import domain as d
from ..ledger import ValidationError
from ..security import write_required

bp = Blueprint("analytics", __name__)

SETTING_KEYS = {"targetAllocation", "taxSlabRate", "lastReviewDate", "reviewSnapshot", "dismissedInsights",
                "autoCapitalFlows", "baseCurrencyDisplay", "dashboardLayout", "riskProfile"}


def L():
    return current_app.extensions["ledger"]


def S():
    return current_app.extensions["services"]


def body() -> dict:
    return request.get_json(silent=True) or {}


@bp.get("/portfolio")
def portfolio():
    port, _ = S().portfolio(g.scope, S().settings())
    port.pop("realized_lots", None)
    return jsonify(port)


@bp.get("/performance")
def performance():
    rng = request.args.get("range", "ALL").upper()
    segment = request.args.get("segment") or None
    if segment and segment not in d.SEGMENTS:
        raise ValidationError("Unknown segment")
    return jsonify(S().performance(g.scope, rng, segment))


@bp.get("/tax")
def tax():
    fy = request.args.get("fy")
    if fy and not (len(fy) == 9 and fy.startswith("FY")):
        raise ValidationError("fy must look like FY2026-27")
    return jsonify(S().tax(g.scope, S().settings(), fy))


@bp.get("/insights")
def insights():
    res = S().insights(g.scope, S().settings(), with_performance=request.args.get("performance", "1") != "0")
    return jsonify({"insights": res["insights"],
                    "benchmarks": (res["performance"] or {}).get("benchmarks", []),
                    "metrics": (res["performance"] or {}).get("metrics", {})})


@bp.get("/pulse")
def pulse():
    return jsonify(S().pulse(g.scope, S().settings()))


@bp.get("/income")
def income():
    return jsonify(S().income(g.scope))


@bp.get("/instruments/<int:iid>/history")
def instrument_history(iid):
    return jsonify(S().instrument_history(g.scope, iid))


@bp.post("/insights/<path:iid>/dismiss")
@write_required
def dismiss(iid):
    days = int(body().get("days") or 30)
    current = dict(S().settings().get("dismissedInsights") or {})
    today = date.today().isoformat()
    current = {k: v for k, v in current.items() if v >= today}  # drop expired
    current[iid] = (date.today() + timedelta(days=days)).isoformat()
    L().set_setting(g.email, g.role, "dismissedInsights", current)
    return jsonify({"dismissed": iid, "until": current[iid]})


@bp.get("/rebalance")
def rebalance():
    try:
        new_money = float(request.args.get("new_money") or 0)
    except ValueError:
        raise ValidationError("new_money must be a number")
    return jsonify(S().rebalance(g.scope, S().settings(), max(new_money, 0), request.args.get("allow_sell") == "1"))


@bp.post("/review/complete")
@write_required
def complete_review():
    port, _ = S().portfolio(g.scope, S().settings())
    snapshot = {s["segment"]: s["pct"] for s in port["segments"]}
    L().set_setting(g.email, g.role, "lastReviewDate", date.today().isoformat())
    L().set_setting(g.email, g.role, "reviewSnapshot", snapshot)
    return jsonify({"lastReviewDate": date.today().isoformat(), "reviewSnapshot": snapshot})


# ── goals ──

@bp.get("/goals")
def goals():
    return jsonify(S().goals(g.scope, S().settings()))


@bp.post("/goals")
@write_required
def add_goal():
    L().save_goal(g.email, g.scope, body())
    return jsonify(S().goals(g.scope, S().settings())), 201


@bp.put("/goals/<int:gid>")
@write_required
def update_goal(gid):
    L().save_goal(g.email, g.scope, body(), gid)
    return jsonify(S().goals(g.scope, S().settings()))


@bp.delete("/goals/<int:gid>")
@write_required
def delete_goal(gid):
    L().delete_goal(gid, g.scope)
    return jsonify({"message": "Goal deleted"})


# ── settings ──

@bp.get("/settings")
def get_settings():
    s = S().settings()
    return jsonify({k: v for k, v in s.items() if k in SETTING_KEYS} | {"segments": list(d.SEGMENTS)})


@bp.put("/settings/<key>")
@write_required
def put_setting(key):
    if key not in SETTING_KEYS:
        raise ValidationError(f"Unknown setting '{key}'")
    value = body().get("value")
    if key == "targetAllocation":
        if not isinstance(value, dict):
            raise ValidationError("targetAllocation must be an object of segment → percent")
        value = {k: float(v) for k, v in value.items() if k in d.SEGMENTS and v not in (None, "")}
        if abs(sum(value.values()) - 100) > 0.5:
            raise ValidationError(f"Targets add up to {sum(value.values()):g}%, they must total 100%")
    if key == "taxSlabRate":
        v = float(value)
        if not 0 <= v <= 45:
            raise ValidationError("Slab rate must be between 0 and 45%")
    L().set_setting(g.email, g.role, key, value)
    return jsonify({"key": key, "value": value})


# ── AI ──

def _context() -> str:
    res = S().insights(g.scope, S().settings())
    return ai.build_context(res["portfolio"], res["tax"], res["insights"], res["goals"], res["performance"])


@bp.get("/ai/status")
def ai_status():
    name, _ = ai.provider()
    return jsonify({"enabled": bool(name), "provider": name, "disclaimer": ai.DISCLAIMER})


@bp.post("/ai/analyze")
def ai_analyze():
    try:
        return jsonify({"analysis": ai.analyze(_context()), "disclaimer": ai.DISCLAIMER})
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503


@bp.post("/ai/chat")
def ai_chat():
    data = body()
    msg = (data.get("message") or "").strip()
    if not msg:
        raise ValidationError("Message is required")
    try:
        return jsonify({"reply": ai.chat(_context(), data.get("history") or [], msg)})
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
