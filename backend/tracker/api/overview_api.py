"""The redesigned app's reads: the group overview and rebalancing by group."""
import math

from flask import Blueprint, current_app, g, jsonify, request

from ..ledger import ValidationError

bp = Blueprint("overview", __name__)


def S():
    return current_app.extensions["services"]


@bp.get("/overview")
def overview():
    return jsonify(S().overview(g.scope, S().settings()))


@bp.get("/overview/rebalance")
def rebalance():
    try:
        new_money = float(request.args.get("new_money") or 0)
    except ValueError:
        raise ValidationError("new_money must be a number")
    if not math.isfinite(new_money) or not 0 <= new_money <= 1e9:
        raise ValidationError("new_money must be between 0 and 100 crore")
    target_set = request.args.get("targets") or "mine"
    if target_set not in ("mine", "suggested"):
        raise ValidationError("targets must be mine or suggested")
    return jsonify(S().group_rebalance(g.scope, S().settings(), new_money, request.args.get("allow_sell") == "1",
                                       target_set))


@bp.get("/overview/group/<key>")
def group_explain(key):
    from .. import domain as d
    if key != "all" and key not in d.GROUPS:
        raise ValidationError("Unknown group")
    return jsonify(S().group_explain(g.scope, S().settings(), key))


@bp.get("/answers")
def answers():
    return jsonify(S().answers(g.scope, S().settings()))
