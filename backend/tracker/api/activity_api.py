"""Activity: how one entry flows through the app, data checks and the cash-entry rules."""
from flask import Blueprint, current_app, g, jsonify

bp = Blueprint("activity", __name__)


def S():
    return current_app.extensions["services"]


def L():
    return current_app.extensions["ledger"]


@bp.get("/trace/txn/<int:tid>")
def trace_txn(tid):
    return jsonify(S().trace(g.scope, S().settings(), tid))


@bp.get("/checks")
def checks():
    return jsonify(S().checks(g.scope, S().settings()))


@bp.get("/rules")
def rules():
    return jsonify(L().cash_rules())
