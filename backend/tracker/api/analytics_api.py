import math
from datetime import date, timedelta

from flask import Blueprint, current_app, g, jsonify, request

from .. import ai
from .. import domain as d
from .. import notices
from ..analytics import actions as actions_mod
from ..analytics import assumptions as A
from ..analytics import scenarios as scen_mod
from ..ledger import GLOBAL_OWNER, NotFound, ValidationError
from ..security import write_required

bp = Blueprint("analytics", __name__)

# R8: `assumptions` (R4) and `planScenarios` (R5) are the P2 keys; `seenNotices` is never one (D15: seen lives in
# action_log only)
SETTING_KEYS = {"targetAllocation", "taxSlabRate", "lastReviewDate", "reviewSnapshot", "dismissedInsights",
                "autoCapitalFlows", "baseCurrencyDisplay", "dashboardLayout", "riskProfile", "marketAlerts", "retirementPlan",
                "emergencyFund", "assumptions", "planScenarios", "groupTargets", "advancedFeatures",
                "p2pDefaultRecovery"}
RISK_PROFILES = ("conservative", "balanced", "growth", "aggressive")
# §7.7 / H10: the emergencyFund bounds
EF_MONTHS = (3, 24)
EF_DEFAULT_MONTHS = 6
EF_MAX_EXPENSES = 1e7
EF_MAX_CASH = 1e8


def L():
    return current_app.extensions["ledger"]


def S():
    return current_app.extensions["services"]


def body() -> dict:
    return request.get_json(silent=True) or {}


@bp.get("/portfolio")
def portfolio():
    port, _ = S().portfolio(g.scope, S().settings())
    # The portfolio is memoised and shared (tax reads realized_lots from it): send a copy, never pop
    return jsonify({k: v for k, v in port.items() if k != "realized_lots"})


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


def _arg_number(name: str, *, required: bool = False, positive: bool = True) -> float | None:
    raw = request.args.get(name)
    if raw in (None, ""):
        if required:
            raise ValidationError(f"{name} is required")
        return None
    try:
        v = float(raw)
    except ValueError:
        raise ValidationError(f"{name} must be a number")
    if not math.isfinite(v) or (positive and v <= 0):
        raise ValidationError(f"{name} must be a number above zero")
    return v


@bp.get("/tax/what-if")
def tax_what_if():
    """The tax on a hypothetical sale (§6.9, AMENDMENTS H8). `instrument_id` (int) and `qty` (> 0) are required;
    `price` (> 0) and `date` (YYYY-MM-DD) are optional. A bad parameter, and every tax.WhatIfError (no such
    holding, not tradable, more than you hold, ELSS still locked, no price, a date out of range), is a 400 with the
    engine's message. A read, so guests may call it."""
    raw = request.args.get("instrument_id")
    if raw in (None, ""):
        raise ValidationError("instrument_id is required")
    try:
        iid = int(raw)
    except ValueError:
        raise ValidationError("instrument_id must be a whole number")
    qty = _arg_number("qty", required=True)
    price = _arg_number("price")
    when = request.args.get("date") or None
    if when is not None:
        when = _iso(when, "date").isoformat()
    try:
        return jsonify(S().what_if(g.scope, S().settings(), iid, qty, price, when))
    except ValueError as e:   # tax.WhatIfError is a ValueError
        raise ValidationError(str(e))


@bp.get("/insights")
def insights():
    res = S().insights(g.scope, S().settings(), with_performance=request.args.get("performance", "1") != "0")
    return jsonify({"insights": res["insights"],
                    "benchmarks": (res["performance"] or {}).get("benchmarks", []),
                    "metrics": (res["performance"] or {}).get("metrics", {})})


@bp.get("/pulse")
def pulse():
    return jsonify(S().pulse(g.scope, S().settings()))


@bp.get("/notifications")
def notifications():
    """The bell (§8.6, AMENDMENTS R9): {items: Notice[] with `seen`, unread}. Tier-now actions (`act:` ids),
    Coming-up events within a week that no action covers, and the market notices. Not memoised (K7)."""
    return jsonify(notices.notifications(S(), g.scope, S().settings(), S().owner()))


@bp.post("/notifications/seen")
@write_required
def notifications_seen():
    """Mark notices seen (R9). Body {ids: ≤ 100 strings of ≤ 200 characters}; returns {unread}. Writers only: a
    guest shares '__global__' with the admin, so a guest marking seen would clear the admin's bell."""
    try:
        ids = notices.validate_ids(body().get("ids"))
    except ValueError as e:
        raise ValidationError(str(e))
    return jsonify(notices.mark_seen(S(), g.scope, S().settings(), S().owner(), ids))


@bp.get("/income")
def income():
    return jsonify(S().income(g.scope))


@bp.get("/instruments/<int:iid>/history")
def instrument_history(iid):
    return jsonify(S().instrument_history(g.scope, iid))


@bp.post("/insights/<path:iid>/dismiss")
@write_required
def dismiss(iid):
    """Alias (E11): snoozes the insight's action in the action log for `days` (1–365, default 30). The response
    keeps its old shape {dismissed, until} (plus the action id it wrote)."""
    raw = body().get("days")
    try:
        days = int(raw) if raw not in (None, "") else 30
    except (TypeError, ValueError):
        raise ValidationError("days must be a whole number")
    if not 1 <= days <= 365:
        raise ValidationError("days must be between 1 and 365")
    if not iid or len(iid) > MAX_ACTION_ID:
        raise ValidationError("Unknown insight id")
    return jsonify(S().dismiss_insight(g.scope, S().settings(), iid, days))


# ── the Home brief and the action list (SPEC §7.2, AMENDMENTS E3–E10) ──

MAX_ACTION_ID = 200
POST_STATUSES = ("open", "planned", "snoozed", "done", "dismissed")
DEFAULT_SNOOZE_DAYS = 30


def _iso(value, name: str) -> date:
    if not isinstance(value, str) or len(value) != 10:
        raise ValidationError(f"{name} must be a date (YYYY-MM-DD)")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ValidationError(f"{name} must be a date (YYYY-MM-DD)")


@bp.get("/brief")
def brief():
    """The Home brief. `since` (the client's last visit, its local date) must be YYYY-MM-DD and not more than one
    day ahead of the server; exactly one day ahead is today in IST while the server is still on yesterday (E9)."""
    since = request.args.get("since") or None
    if since is not None:
        day, today = _iso(since, "since"), date.today()
        if day > today + timedelta(days=1):
            raise ValidationError("since can't be in the future")
        since = min(day, today).isoformat()
    return jsonify(S().brief(g.scope, S().settings(), since))


@bp.get("/actions")
def actions():
    """Ranked actions plus planned, done and snoozed (E4). `status`, `category` and `instrument_id` filter the
    memoised result; when any is given the summary counts the filtered open and planned rows."""
    status = request.args.get("status") or None
    category = request.args.get("category") or None
    raw_iid = request.args.get("instrument_id") or None
    if status is not None and status not in (*POST_STATUSES, "expired"):
        raise ValidationError("status must be one of " + ", ".join(POST_STATUSES))
    try:
        iid = int(raw_iid) if raw_iid is not None else None
    except ValueError:
        raise ValidationError("instrument_id must be a number")
    res = S().actions(g.scope, S().settings())
    if status is None and category is None and iid is None:
        return jsonify(res)

    def keep(a: dict) -> bool:
        return ((status is None or a.get("status") == status) and (category is None or a.get("category") == category)
                and (iid is None or a.get("instrument_id") == iid))

    out = {**res, **{k: [a for a in res[k] if keep(a)] for k in ("actions", "planned", "done", "snoozed")}}
    out["summary"] = actions_mod.summary(out["actions"] + out["planned"])
    return jsonify(out)


@bp.post("/actions/<path:aid>/status")
@write_required
def action_status(aid):
    """Record the user's decision on an action (E10). Body: {status, until?, planned_for?, note?, reason?,
    txn_ids? | evidence.txn_ids?}. Bumps actions_rev only; returns the Action."""
    if len(aid) > MAX_ACTION_ID or not aid.startswith(actions_mod.ACTION_PREFIXES):
        raise ValidationError("Unknown action id")
    b = body()
    status = b.get("status")
    if status not in POST_STATUSES:
        raise ValidationError("status must be one of " + ", ".join(POST_STATUSES))
    today = date.today()
    fields: dict = {}
    if b.get("until") not in (None, ""):
        until = _iso(b["until"], "until")
        if not today < until <= today + timedelta(days=365):
            raise ValidationError("until must be after today and within a year")
        if status == "snoozed":
            fields["snooze_until"] = until.isoformat()
    elif status == "snoozed":
        fields["snooze_until"] = (today + timedelta(days=DEFAULT_SNOOZE_DAYS)).isoformat()
    if b.get("planned_for") not in (None, ""):
        pf = _iso(b["planned_for"], "planned_for")
        if not today <= pf <= today + timedelta(days=365):
            raise ValidationError("planned_for must be between today and a year from now")
        if status == "planned":
            fields["planned_for"] = pf.isoformat()
    for k in ("note", "reason"):
        if b.get(k) not in (None, ""):
            if not isinstance(b[k], str) or len(b[k]) > 500:
                raise ValidationError(f"{k} must be text of at most 500 characters")
            fields[k] = b[k]
    ev = b.get("evidence") if isinstance(b.get("evidence"), dict) else {}
    txn_ids = b.get("txn_ids") if b.get("txn_ids") is not None else ev.get("txn_ids")
    if txn_ids is not None:
        if not isinstance(txn_ids, list) or not all(isinstance(t, int) and not isinstance(t, bool) for t in txn_ids):
            raise ValidationError("txn_ids must be a list of transaction ids")
        if txn_ids and status == "done":
            fields["evidence"] = {"txn_ids": txn_ids}
    if status == "done":
        fields["done_via"] = "manual"
    return jsonify(S().set_action_status(g.scope, S().settings(), aid, status, fields))


@bp.get("/rebalance")
def rebalance():
    """The segment-level plan toward targets; `net=deploy` nets the deploy sources (A15). The payload carries
    `months_to_fix` (D2/H14): months of SIPs plus arriving money that close the gap without selling."""
    try:
        new_money = float(request.args.get("new_money") or 0)
    except ValueError:
        raise ValidationError("new_money must be a number")
    net = request.args.get("net") or None
    if net not in (None, "deploy"):
        raise ValidationError("net must be 'deploy'")
    return jsonify(S().rebalance(g.scope, S().settings(), max(new_money, 0), request.args.get("allow_sell") == "1",
                                 net=net))


@bp.post("/review/complete")
@write_required
def complete_review():
    """Close the quarterly review: writes lastReviewDate and reviewSnapshot to the settings owner of the view
    (R11), so an admin reviewing a member records the member's review."""
    port, _ = S().portfolio(g.scope, S().settings())
    snapshot = {s["segment"]: s["pct"] for s in port["segments"]}
    who = S().settings_who()
    L().set_setting(*who, "lastReviewDate", date.today().isoformat())
    L().set_setting(*who, "reviewSnapshot", snapshot)
    return jsonify({"lastReviewDate": date.today().isoformat(), "reviewSnapshot": snapshot})


# ── goals ──

@bp.get("/goals")
def goals():
    return jsonify(S().goals(g.scope, S().settings()))


@bp.post("/goals")
@write_required
def add_goal():
    L().save_goal(g.owner, g.scope, body())
    return jsonify(S().goals(g.scope, S().settings())), 201


@bp.put("/goals/<int:gid>")
@write_required
def update_goal(gid):
    L().save_goal(g.owner, g.scope, body(), gid)
    return jsonify(S().goals(g.scope, S().settings()))


@bp.delete("/goals/<int:gid>")
@write_required
def delete_goal(gid):
    L().delete_goal(gid, g.scope)
    return jsonify({"message": "Goal deleted"})


# ── settings ──

@bp.get("/settings")
def get_settings():
    """The settings of the view's settings owner (R11) plus read-only meta (§7.7, H10, R8):
    `emergencyFundSuggest` for the request's scope, `settings_owner` (the member's email or '__global__') and
    `inherited`, the setting keys whose value still comes from '__global__' because the owner has no row of its
    own (sorted; [] for '__global__' itself)."""
    who = S().settings_who()
    s = L().get_settings(*who)
    owner = L().settings_owner(*who)
    own = L().setting_keys(owner) if owner != GLOBAL_OWNER else set()
    inherited = sorted(k for k in L().setting_keys(GLOBAL_OWNER) & SETTING_KEYS if k not in own) \
        if owner != GLOBAL_OWNER else []
    out = {k: v for k, v in s.items() if k in SETTING_KEYS} | {"segments": list(d.SEGMENTS), "groups": list(d.GROUPS),
                                                               "settings_owner": owner, "inherited": inherited}
    try:
        out["emergencyFundSuggest"] = S().emergency_suggest(g.scope, s)
    except Exception as e:  # noqa: BLE001 — the settings page must still load
        print(f"[settings] cushion suggestion unavailable: {e!r}")
        out["emergencyFundSuggest"] = None
    return jsonify(out)


def _bounded(value, name: str, lo: float, hi: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{name} must be a number")
    if not math.isfinite(v) or not lo <= v <= hi:
        raise ValidationError(f"{name} must be between {lo:g} and {hi:g}")
    return v


def _emergency_fund(value) -> dict:
    """§7.7 / A25 / H10: {months_target int 3–24 (6), monthly_expenses 0–1e7 | null, instrument_ids [int] each in the
    caller's scope, cash_amount 0–1e8 (0)}. Unknown keys are dropped."""
    if not isinstance(value, dict):
        raise ValidationError("emergencyFund must be an object")
    raw = value.get("months_target")
    months = EF_DEFAULT_MONTHS if raw in (None, "") else _bounded(raw, "months_target", *EF_MONTHS)
    if months != int(months):
        raise ValidationError("months_target must be a whole number of months")
    raw = value.get("monthly_expenses")
    expenses = None if raw in (None, "") else _bounded(raw, "monthly_expenses", 0, EF_MAX_EXPENSES)
    raw = value.get("cash_amount")
    cash = 0.0 if raw in (None, "") else _bounded(raw, "cash_amount", 0, EF_MAX_CASH)
    ids = value.get("instrument_ids") or []
    if not isinstance(ids, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        raise ValidationError("instrument_ids must be a list of instrument ids")
    clean: list[int] = []
    for iid in ids:
        try:
            L().instrument(iid, g.scope)
        except NotFound:
            raise ValidationError(f"Instrument {iid} is not in this portfolio")
        if iid not in clean:
            clean.append(iid)
    return {"months_target": int(months), "monthly_expenses": expenses, "instrument_ids": clean, "cash_amount": cash}


def _plan_scenarios(value) -> list[dict]:
    """Validate `planScenarios` (§6.10, D14, AMENDMENTS R5) through the one validator the compare route also uses
    (`scenarios.validate_saved`, R2): ≤ 5 full scenarios, null stores []. A bad entry is a 400 reading
    "Scenario {n}: {field} {problem}" with n 1-based."""
    try:
        return scen_mod.validate_saved(value)
    except scen_mod.ScenarioError as e:
        raise ValidationError(str(e))


def _market_alerts(value) -> dict:
    """marketAlerts (rebuilt whole on every PUT): {enabled, push, day 1–20, week 2–40, digest}. `digest` is the
    daily action digest flag (K19, R8): a bool, false when absent, so the client always sends the whole object."""
    if not isinstance(value, dict):
        raise ValidationError("marketAlerts must be an object")
    digest = value.get("digest", False)
    if not isinstance(digest, bool):
        raise ValidationError("digest must be true or false")
    out = {"enabled": bool(value.get("enabled", True)), "push": bool(value.get("push", True)),
           "day": float(value.get("day") or 5), "week": float(value.get("week") or 10), "digest": digest}
    if not (1 <= out["day"] <= 20 and 2 <= out["week"] <= 40):
        raise ValidationError("Alert thresholds: daily move 1–20%, weekly move 2–40%")
    return out


@bp.put("/settings/<key>")
@write_required
def put_setting(key):
    """Save one setting to the view's settings owner (R11): an admin viewing a member writes the member's row,
    the family view writes '__global__'. Each key is validated (400 otherwise); returns {key, value} as stored."""
    if key not in SETTING_KEYS:
        raise ValidationError(f"Unknown setting '{key}'")
    value = body().get("value")
    if key == "targetAllocation":
        if not isinstance(value, dict):
            raise ValidationError("targetAllocation must be an object of segment → percent")
        value = {k: float(v) for k, v in value.items() if k in d.SEGMENTS and v not in (None, "")}
        if abs(sum(value.values()) - 100) > 0.5:
            raise ValidationError(f"Targets add up to {sum(value.values()):g}%, they must total 100%")
    if key == "groupTargets":
        if not isinstance(value, dict):
            raise ValidationError("groupTargets must be an object of group → percent")
        clean = {}
        for k, v in value.items():
            if k not in d.GROUPS:
                raise ValidationError(f"Unknown group '{k}'")
            if v in (None, ""):
                continue
            clean[k] = _bounded(v, d.GROUP_LABELS[k], 0, 100)
        if abs(sum(clean.values()) - 100) > 0.5:
            raise ValidationError(f"Targets add up to {sum(clean.values()):g}%, they must total 100%")
        value = clean
    if key == "advancedFeatures":
        if not isinstance(value, bool):
            raise ValidationError("advancedFeatures must be true or false")
    if key == "p2pDefaultRecovery":
        value = _bounded(value, "Recovery on defaulted P2P loans", 0, 100)
    if key == "marketAlerts":
        value = _market_alerts(value)
    if key == "taxSlabRate":
        try:
            v = float(value)
        except (TypeError, ValueError):
            raise ValidationError("Slab rate must be a number")
        if not math.isfinite(v) or not 0 <= v <= 45:
            raise ValidationError("Slab rate must be between 0 and 45%")
    if key == "riskProfile":
        value = str(value or "balanced").lower()
        if value not in RISK_PROFILES:
            raise ValidationError("riskProfile must be one of " + ", ".join(RISK_PROFILES))
    if key == "retirementPlan":
        if not isinstance(value, dict):
            raise ValidationError("retirementPlan must be an object")
        clean = {}
        for k in ("current_age", "retire_age", "life_expectancy", "monthly_expenses", "inflation_pct", "post_return_pct",
                  "monthly_sip", "step_up_pct", "return_pct", "other_income_monthly"):
            if value.get(k) not in (None, ""):
                try:
                    clean[k] = float(value[k])
                except (TypeError, ValueError):
                    raise ValidationError(f"{k} must be a number")
        for k in ("current_age", "retire_age", "life_expectancy"):
            if k in clean and not 15 <= clean[k] <= 110:
                raise ValidationError(f"{k} must be between 15 and 110")
        value = clean
    if key == "emergencyFund":
        value = _emergency_fund(value)
    if key == "assumptions":
        try:
            value = A.validate_overrides(value)
        except ValueError as e:
            raise ValidationError(str(e))
        value = value or {}   # null or {} clears the overrides
    if key == "planScenarios":
        value = _plan_scenarios(value)
    L().set_setting(*S().settings_who(), key, value)
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
