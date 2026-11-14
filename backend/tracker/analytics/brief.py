"""The Home brief: one pure composition of everything the engines already know, ranked by the question ladder.

SPEC Part 1 §2 P0.4 / P0.7, §4 (every field Home reads), §1.4 and Part 2 §7.1 / §7.8, as amended by
AMENDMENTS A6, A16, A23–A26 and A28.

`build_brief` reads the shared context (`Services.context`), the ranked actions (`actions.for_home` plus
`actions.summary`) and the optional engine outputs, and returns the Brief payload described in A6:

    status, hero, vitals[] (data, cushion, risk, mix, money_at_risk), actions[≤5], on_track {plan, market, habit},
    why (story.attribution), allocation, upcoming, tax, deploy, freshness, pending[], empty, context_line,
    assumptions_check (P1), market_state (P1)

Rules that matter:
- A missing input (None) gives an `unset` vital with a note. Unset vitals never raise the page status.
- `perf` is the ALL-range performance payload (A16); None means it is not warm yet, so the market card is
  `pending` and `pending == ['market']`.
- An empty ledger gives `empty = True`, the `onboard:import` / `onboard:add` actions and `vitals = []`.

The module is pure: no I/O, no database, no network. It does not import `actions.py` (A6); the two meet only
through the shapes fixed in AMENDMENTS A6. `cushion_state` and `deploy_state` are exported so services can
compute them once and hand the same result to both `build_actions` and `build_brief`.

P1 (AMENDMENTS G15, H11): the market context line comes first (`markets.context_line`), `assumptions_check`
compares the realised TWR with the Book's typical band, the habit card is scored from SIP adherence, cushion
candidates use `assumptions.book_key`, and `plan_track` / `plan_headline` are exported so `/plan` and the
brief's Plan card follow one rule. `p1_fields` gives the brief's `assumptions` chip and the `cushion` /
`risk_est` pass-throughs; services merges them, because `build_brief`'s own key set is pinned by A6.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone

from .. import domain as d
from ..markets import context_line as market_context_line   # markets imports only domain and prices: no cycle
from . import assumptions as A
from . import story
from .forecast import monthly_sip_total
from .insights import _inr
from .optimizer import PROFILES

# ── vocabulary ──
STATUS_RANK = {"good": 0, "watch": 1, "act": 2}           # unset / pending / info never raise the page status
GOAL_STATUS = {"achieved": "good", "on_track": "good", "at_risk": "watch", "off_track": "act"}
VITAL_ORDER = ("data", "cushion", "risk", "mix", "money_at_risk")
VITAL_LABEL = {"data": "Data", "cushion": "Cushion", "risk": "Risk", "mix": "Mix", "money_at_risk": "Money at risk"}

# ── thresholds (SPEC §2 P0.7, §4.2, A24, A16) ──
FRESH_HOURS = 26               # prices younger than this are fresh
STALE_ACT_HOURS = 96           # older than 4 days → the Data vital acts
UNPRICED_ACT_PCT = 5.0         # unpriced weight at or above this → the Data vital acts
CUSHION_FLOOR_MONTHS = 3       # below this the Cushion vital acts
DEFAULT_CUSHION_TARGET = 6
RISK_WATCH_PTS, RISK_ACT_PTS = 2.0, 5.0
CONC_WATCH_PCT, CONC_WATCH_MF_PCT = 15.0, 25.0
DRIFT_WATCH, DRIFT_ACT = 2.5, 5.0
MONEY_AT_RISK_ACT_PCT = 1.0
P2P_OVERDUE_DAYS = 30
MARKET_MIN_DAYS = 180
MARKET_WATCH_FLOOR = -3.0
REVIEW_EVERY_DAYS = 90
FD_DEPLOY_DAYS = 30
P2P_DEPLOY_DAYS = 30
CUSHION_FD_DAYS = 365
HARVEST_FLOOR, HARVEST_MIN_BOOKING = 2000, 1000   # mirror actions.HARVEST_* (A12); brief does not import actions
HABIT_GOOD_PCT, HABIT_WATCH_PCT = 90.0, 60.0       # SIP adherence over 6 months (H11)
ASSUMPTIONS_LINK_GAP_PTS = 3.0                     # typical − realised at or above this links to /plan?return= (H11)
ASSUMPTIONS_LINK_YEARS = 2.0
CHIP_BASIS = "holdings mix"                        # the portfolio chip's basis, as forecast names it

# A liquid mutual fund sorts first among the debt-fund cushion candidates (which assumptions.book_key finds).
_LIQUID_MF = re.compile(r"liquid|overnight|money market", re.I)


# ── small helpers ──
def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _date(v) -> date | None:
    if not v:
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _inrc(v: float) -> str:
    """Compact rupees: ₹4.2 L, ₹1.23 Cr, otherwise the full Indian grouping."""
    a = abs(v)
    sign = "-" if v < 0 else ""
    if a >= 1e7:
        return f"{sign}₹{a / 1e7:.2f} Cr"
    if a >= 1e5:
        return f"{sign}₹{a / 1e5:.1f} L"
    return _inr(v)


def _worst(statuses) -> str:
    """The most severe of good/watch/act; anything else (unset, pending, info) is ignored. Nothing → good."""
    best = "good"
    for s in statuses:
        if s in STATUS_RANK and STATUS_RANK[s] > STATUS_RANK[best]:
            best = s
    return best


def _vital(key: str, status: str, value: str, note: str | None, link: str) -> dict:
    return {"key": key, "status": status, "label": VITAL_LABEL[key], "value": value, "note": note, "link": link}


def _age_text(minutes: float) -> str:
    if minutes < 60:
        return f"{int(minutes)} min"
    if minutes < 48 * 60:
        return f"{int(minutes // 60)} h"
    return f"{int(minutes // (24 * 60))} days"


def _is_debt_mf(p: dict) -> bool:
    """A debt mutual fund in the Book's sense (G15, E15): `assumptions.book_key` maps it to MF_DEBT. The name is
    never read, so "Liquid" in a fund's name alone does not make it a cushion candidate."""
    return p.get("asset_class") == d.MUTUAL_FUND and A.book_key(p) == A.MF_DEBT


def _empty_ledger(ctx: dict) -> bool:
    data = ctx.get("data")
    if isinstance(data, dict) and data.get("transactions") is not None:
        return len(data["transactions"]) == 0
    positions = (ctx.get("port") or {}).get("positions") or []
    return not any(p.get("txn_count") for p in positions)


# ── exported helpers (A6) ──
def cushion_state(port: dict, settings: dict | None, today: date) -> dict:
    """The emergency cushion (A6 `Cushion`, A25).

    months = (Σ value of `emergencyFund.instrument_ids` + `emergencyFund.cash_amount`) / `monthly_expenses`.
    `cash_amount` is bank money the user declares; it counts toward the cushion only, never toward the
    portfolio. With no `monthly_expenses` the cushion is not set (`months` None).

    Candidates (SPEC §7.7 auto-suggest), sorted by liquidity: the USD wallet, then liquid MFs, then other debt
    MFs, then FDs maturing within a year by maturity date.
    """
    ef = (settings or {}).get("emergencyFund") or {}
    if not isinstance(ef, dict):
        ef = {}
    positions = port.get("positions") or []
    ids = [int(i) for i in (ef.get("instrument_ids") or []) if str(i).lstrip("-").isdigit()]
    chosen = set(ids)
    held = sum(_f(p.get("value")) for p in positions if p.get("id") in chosen and p.get("is_open"))
    cash = max(_f(ef.get("cash_amount")), 0.0)
    expenses = _f(ef.get("monthly_expenses")) or None
    target = int(ef.get("months_target") or DEFAULT_CUSHION_TARGET)
    amount = held + cash

    ranked: list[tuple[tuple, dict]] = []
    for p in positions:
        if not p.get("is_open") or _f(p.get("value")) <= 0:
            continue
        ac = p.get("asset_class")
        row = {"instrument_id": p.get("id"), "name": p.get("name"), "value": round(_f(p.get("value")), 2)}
        if ac == d.CASH:
            ranked.append(((0, 0, ""), {**row, "kind": "usd"}))
        elif _is_debt_mf(p):
            liquid = any(_LIQUID_MF.search(p.get(k) or "") for k in ("category", "sub_category", "name"))
            ranked.append(((1, 0 if liquid else 1, p.get("name") or ""), {**row, "kind": "mf_debt"}))
        elif ac == d.FIXED_DEPOSIT and p.get("days_to_maturity") is not None and 0 <= p["days_to_maturity"] <= CUSHION_FD_DAYS:
            ranked.append(((2, p["days_to_maturity"], p.get("maturity_date") or ""), {**row, "kind": "fd"}))
    candidates = [r for _, r in sorted(ranked, key=lambda x: x[0])]
    is_set = bool(expenses and expenses > 0)
    return {
        "set": is_set,
        "months": round(amount / expenses, 2) if is_set else None,
        "target_months": target,
        "monthly_expenses": round(expenses, 2) if expenses else None,
        "amount": round(amount, 2),
        "cash_amount": round(cash, 2),
        "instrument_ids": ids,
        "candidates": candidates,
        "candidates_amount": round(sum(c["value"] for c in candidates), 2),
    }


def deploy_state(port: dict, cashflow_events: list[dict] | None, today: date) -> dict:
    """Money that is free, or about to be, for redeploying (SPEC §5.1 Deploy, A6 `Deploy`, A15).

    suggested = USD wallet `value` + Σ FD `maturity_value` with `days_to_maturity` ≤ 30 + P2P principal due
    within 30 days (cash-flow `p2p_close` events) + the P2P escrow balance.

    Each source carries `held_value`: the part of `amount` already counted inside `segment`, so the rebalance
    can net it instead of adding the money twice (A15). The FD's is its current value (the interest still to
    come is genuinely new money); the wallet's is its whole value; escrow's is 0. With no cash-flow events
    (None), the P2P principal source is left out.
    """
    sources: list[dict] = []
    positions = port.get("positions") or []
    for p in positions:
        if not p.get("is_open"):
            continue
        if p.get("asset_class") == d.CASH and _f(p.get("value")) >= 1:
            v = round(_f(p["value"]), 2)
            sources.append({"kind": "usd", "label": f"USD wallet · {p.get('name')}", "segment": p.get("segment"),
                            "instrument_id": p.get("id"), "date": None, "amount": v, "held_value": v})
    fds = [p for p in positions if p.get("is_open") and p.get("asset_class") == d.FIXED_DEPOSIT
           and p.get("days_to_maturity") is not None and 0 <= p["days_to_maturity"] <= FD_DEPLOY_DAYS]
    for p in sorted(fds, key=lambda p: p["days_to_maturity"]):
        amount = _f(p.get("maturity_value")) or _f(p.get("value"))
        if amount < 1:
            continue
        sources.append({"kind": "fd", "label": f"FD matures · {p.get('name')}", "segment": p.get("segment") or d.SEG_FD,
                        "instrument_id": p.get("id"), "date": p.get("maturity_date"), "amount": round(amount, 2),
                        "held_value": round(min(_f(p.get("value")), amount), 2)})
    for e in cashflow_events or []:
        if e.get("kind") != "p2p_close":
            continue
        when = _date(e.get("date"))
        if when is None or not (0 <= (when - today).days <= P2P_DEPLOY_DAYS):
            continue
        amount = round(_f(e.get("amount")), 2)
        if amount < 1:
            continue
        # principal still lent out sits inside the P2P segment until it comes back
        sources.append({"kind": "p2p_principal", "label": f"P2P principal back · {e.get('name') or 'loans'}",
                        "segment": d.SEG_P2P, "instrument_id": e.get("instrument_id"), "date": when.isoformat(),
                        "amount": amount, "held_value": amount})
    escrow = _f((port.get("contributions") or {}).get("p2p_escrow_balance"))
    if escrow >= 1:
        sources.append({"kind": "escrow", "label": "P2P escrow balance", "segment": None, "instrument_id": None,
                        "date": None, "amount": round(escrow, 2), "held_value": 0.0})
    return {"suggested": round(sum(s["amount"] for s in sources), 2), "sources": sources}


# ── freshness and the Data vital (SPEC §2 P0.7) ──
def _ts(v) -> datetime | None:
    if not v:
        return None
    try:
        ts = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def _freshness(port: dict, now: datetime) -> dict:
    """Price freshness of THIS portfolio (SPEC §2 P0.7, §7.8).

    The age is that of the oldest price among the open market-priced holdings that have one: each holding's own
    `price_at` (written only when its quote actually came back), falling back to the global `prices:last_refresh`
    stamp for a holding with no `price_at`. The global stamp alone is not enough: it is shared by every owner and
    a refresh only fetches the caller's symbols. `data:stale-prices` reads the same `price_at`, so the Data vital
    and that action agree."""
    totals = port.get("totals") or {}
    total = _f(totals.get("value"))
    raw_global = (port.get("prices") or {}).get("last_refresh")
    glob = (_ts(raw_global), raw_global)
    priced = [p for p in port.get("positions") or [] if p.get("is_open") and p.get("asset_class") in d.TRADABLE]
    unpriced = [p for p in priced if not p.get("has_price")]
    stamps = [(_ts(p.get("price_at")), p.get("price_at")) if _ts(p.get("price_at")) else glob
              for p in priced if p.get("has_price")] or [glob]
    oldest = None if any(ts is None for ts, _ in stamps) else min(stamps, key=lambda s: s[0])
    age = max((now - oldest[0]).total_seconds() / 60, 0.0) if oldest else None
    last = oldest[1] if oldest else None
    missing_value = sum(_f(p.get("value")) for p in unpriced)
    return {
        "last_refresh": last,
        "age_minutes": round(age) if age is not None else None,
        "missing_prices": list(totals.get("missing_prices") or [p.get("name") for p in unpriced]),
        "missing_weight_pct": round(missing_value / total * 100, 2) if total > 0 else 0.0,
        "stale": bool(priced) and (age is None or age > FRESH_HOURS * 60),
        "_needs_prices": bool(priced),
        "_missing_count": len(unpriced),
    }


def _data_vital(fresh: dict) -> dict:
    link = "/settings#prices"
    if not fresh["_needs_prices"]:
        return _vital("data", "good", "No holdings need live prices", None, link)
    age, pct, n = fresh["age_minutes"], fresh["missing_weight_pct"], fresh["_missing_count"]
    age_txt = f"Prices {_age_text(age)} old" if age is not None else "Prices never refreshed"
    if n:
        value = f"{n} holding{'s' if n > 1 else ''} at cost ({pct:.1f}% of value)"
    else:
        value = f"{age_txt} · all priced"
    if pct >= UNPRICED_ACT_PCT or (age is not None and age > STALE_ACT_HOURS * 60):
        status = "act"
    elif n or age is None or age > FRESH_HOURS * 60:
        status = "watch"
    else:
        status = "good"
    note = None
    if status != "good":
        parts = []
        if n:
            parts.append("add tickers so these are valued at market")
        if age is None or age > FRESH_HOURS * 60:
            parts.append(f"{age_txt.lower()}; refresh them")
        note = "Values may be off: " + " · ".join(parts) if parts else None
    return _vital("data", status, value, note, link)


def _data_headline(fresh: dict) -> str:
    age = fresh["age_minutes"]
    if age is not None and age > STALE_ACT_HOURS * 60:
        return f"Prices are {int(age // (24 * 60))} days old — values may be off"
    return f"{fresh['missing_weight_pct']:.1f}% of your portfolio has no live price — values may be off"


# ── the other vitals (SPEC §4.2, A24, A25, A28) ──
def _cushion_vital(cushion: dict | None) -> dict:
    link = "/settings#cushion"
    if cushion is None:
        return _vital("cushion", "unset", "Not set", "Cushion couldn't be measured right now", link)
    if not cushion.get("set"):
        found = _f(cushion.get("candidates_amount"))
        note = (f"Mark your emergency money — we found {_inrc(found)} of candidates" if found >= 1
                else "Add your monthly expenses and mark your emergency money")
        return _vital("cushion", "unset", "Not set", note, link)
    months, target = _f(cushion.get("months")), int(cushion.get("target_months") or DEFAULT_CUSHION_TARGET)
    status = "good" if months >= target else "watch" if months >= CUSHION_FLOOR_MONTHS else "act"
    note = None
    if status != "good":
        short = (target - months) * _f(cushion.get("monthly_expenses"))
        note = f"Target {target} months · {_inrc(short)} short"
    return _vital("cushion", status, f"{months:.1f} months of expenses", note, link)


def _concentration(port: dict) -> tuple[dict | None, dict | None]:
    """(largest open holding, largest holding over its concentration limit) among the holdings the
    `concentration:<iid>` insight applies to (not P2P, FD or the wallet). The limit is 15%, or 25% for an MF."""
    rows = [p for p in port.get("positions") or [] if p.get("is_open")
            and p.get("asset_class") not in (d.P2P, d.FIXED_DEPOSIT, d.CASH)]
    top = max(rows, key=lambda p: _f(p.get("weight")), default=None)
    over = [p for p in rows if _f(p.get("weight")) >= (CONC_WATCH_MF_PCT if p.get("asset_class") == d.MUTUAL_FUND
                                                       else CONC_WATCH_PCT)]
    return top, max(over, key=lambda p: _f(p.get("weight")), default=None)


def _closest_label(key: str | None) -> str | None:
    prof = next((p for p in PROFILES if p["key"] == key), None)
    return prof["label"] if prof else key


def _risk_vital(risk_est: dict | None, port: dict, settings: dict) -> dict:
    link = "/risk"
    if risk_est is None:
        return _vital("risk", "unset", "—", "Risk estimate unavailable right now", link)
    profile = risk_est.get("profile") or settings.get("riskProfile")
    v = risk_est.get("vol_pct")
    top, conc = _concentration(port)
    top_w = _f(top.get("weight")) if top else 0.0
    top_txt = f" · Top holding {top_w:.0f}%" if top_w >= CONC_WATCH_PCT else ""
    if not profile:
        closest = _closest_label(risk_est.get("closest_profile"))
        value = f"Est. volatility {v:.1f}%" if v is not None else "—"
        note = f"Looks like {closest}" if closest else "Pick a risk profile"
        return _vital("risk", "unset", value + top_txt, note, link)
    prof = next((p for p in PROFILES if p["key"] == profile), None)
    t = risk_est.get("target_vol_pct")
    if t is None and prof:
        t = round(prof["target_vol"] * 100, 2)
    label = prof["label"] if prof else str(profile).title()
    if v is None or t is None:
        return _vital("risk", "unset", "—", "Risk estimate unavailable right now", link)
    v, t = float(v), float(t)
    eps = 1e-9  # the boundaries t+2 and t+5 belong to the milder status (A24: v ≤ t + 2 is good)
    status = "good" if v <= t + RISK_WATCH_PTS + eps else "watch" if v <= t + RISK_ACT_PTS + eps else "act"
    if conc is not None and status == "good":
        status = "watch"
    note = None
    if status != "good":
        bits = []
        if v > t + RISK_WATCH_PTS:
            bits.append(f"{v - t:.1f} pts above your {label} target")
        if conc is not None:
            bits.append(f"{conc.get('name')} is {_f(conc.get('weight')):.1f}% of the portfolio")
        note = " · ".join(bits) or None
    return _vital("risk", status, f"Est. volatility {v:.1f}% · {label} target {t:.0f}%{top_txt}", note, link)


def _mix_vital(port: dict) -> dict:
    link = "/risk#mix"
    rows = [s for s in port.get("segments") or [] if s.get("target") is not None and s.get("drift") is not None]
    if not rows:
        return _vital("mix", "unset", "No targets", "Set target allocation to see drift", link)
    worst = max(rows, key=lambda s: abs(_f(s["drift"])))
    drift = _f(worst["drift"])
    status = "good" if abs(drift) < DRIFT_WATCH else "watch" if abs(drift) < DRIFT_ACT else "act"
    if status == "good":
        return _vital("mix", status, f"Within {DRIFT_WATCH:g} pts of target", None, link)
    value = f"{worst['segment']} {drift:+.1f} pts {'over' if drift > 0 else 'under'}"
    return _vital("mix", status, value, "Route new money to the classes under target", link)


def _money_at_risk(port: dict, today: date) -> dict:
    """P2P defaulted (`at_risk`), P2P overdue > 30 days (`outstanding`) and FDs past maturity with no MATURITY
    row (A28: `is_open` and `maturity_date` < today; amount = value, which is the accrued value at maturity)."""
    defaulted = overdue = fd_amount = 0.0
    fd_count = 0
    for p in port.get("positions") or []:
        ac = p.get("asset_class")
        if ac == d.P2P:
            at_risk = _f(p.get("at_risk"))
            if at_risk > 0:
                defaulted += at_risk
            elif p.get("is_open") and int(_f(p.get("overdue_days"))) > P2P_OVERDUE_DAYS:
                overdue += _f(p.get("outstanding"))
        elif ac == d.FIXED_DEPOSIT and p.get("is_open"):
            mat = _date(p.get("maturity_date"))
            if mat and mat < today:
                fd_count += 1
                fd_amount += _f(p.get("value"))
    return {"defaulted": round(defaulted, 2), "overdue": round(overdue, 2), "fd_unrecorded": round(fd_amount, 2),
            "fd_count": fd_count, "total": round(defaulted + overdue + fd_amount, 2)}


def _money_vital(mar: dict, total_value: float) -> dict:
    if mar["total"] <= 0:
        return _vital("money_at_risk", "good", "None", None, "/p2p")
    pct = mar["total"] / total_value * 100 if total_value > 0 else 100.0
    status = "act" if pct >= MONEY_AT_RISK_ACT_PCT else "watch"
    parts = []
    if mar["defaulted"]:
        parts.append(f"{_inr(mar['defaulted'])} defaulted")
    if mar["overdue"]:
        parts.append(f"{_inr(mar['overdue'])} overdue")
    if mar["fd_count"]:
        parts.append(f"{mar['fd_count']} FD{'s' if mar['fd_count'] > 1 else ''} matured unrecorded")
    link = ("/p2p?tab=defaulted" if mar["defaulted"] else "/p2p?tab=overdue" if mar["overdue"] else "/fixed-deposits")
    note = f"{pct:.1f}% of your portfolio" if pct >= 0.1 else "Under 0.1% of your portfolio"
    if mar["fd_count"] and not (mar["defaulted"] or mar["overdue"]):
        note = "Record the maturity so the money shows where it went"
    return _vital("money_at_risk", status, " · ".join(parts), note, link)


def _money_headline(mar: dict) -> str:
    if mar["defaulted"]:
        return f"{_inr(mar['defaulted'])} of P2P loans are in default"
    if mar["overdue"]:
        return f"{_inr(mar['overdue'])} of P2P loans are over {P2P_OVERDUE_DAYS} days overdue"
    n = mar["fd_count"]
    return f"{_inr(mar['fd_unrecorded'])} in {n} matured FD{'s' if n > 1 else ''} is not recorded"


def _safe(build, key: str) -> dict:
    """A vital whose engine raised becomes unset with a note (SPEC §7.8): /brief never fails on one vital."""
    try:
        return build()
    except Exception:  # noqa: BLE001 — one broken input must not take the page down
        return _vital(key, "unset", "—", "Couldn't check this right now", {
            "data": "/settings#prices", "cushion": "/settings#cushion", "risk": "/risk", "mix": "/risk#mix",
            "money_at_risk": "/p2p"}[key])


# ── on track (SPEC §4.4, A16) ──
def _snap_data(snapshot_then: dict | None) -> dict:
    if not snapshot_then:
        return {}
    data = snapshot_then.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    return data if isinstance(data, dict) else {}


def plan_track(ctx: dict, plan: dict | None, snap: dict | None) -> dict:
    """The Plan card (A6 `PlanTrack`) and `/plan` `rows` (H6): one row per goal plus the retirement row when a plan
    is saved, worst first, each with its ▲/▼ `delta` in points against the snapshot's `goal_probs`.

    ctx   {goals, ...}: goals projected by services (used when `plan` is None or has no goals).
    plan  {goals, retirement|None} or None (retirement unknown: no row).
    snap  the snapshot's data dict, or the {date, data} row kpi_snapshot_at returns, or None.
    Status: the worst of the rows (good/watch/act), `unset` when no row is scored."""
    if snap and "data" in snap and "goal_probs" not in snap:
        snap = _snap_data(snap)
    snap = snap or {}
    goals = (plan or {}).get("goals") if plan and plan.get("goals") is not None else ctx.get("goals") or []
    retirement = (plan or {}).get("retirement")
    probs_then = snap.get("goal_probs") or {}
    rows = []
    for g in goals:
        pr = g.get("projection") or {}
        prob = pr.get("probability")
        then = probs_then.get(str(g.get("id"))) if isinstance(probs_then, dict) else None
        rows.append({"kind": "goal", "id": g.get("id"), "name": g.get("name"), "probability": prob,
                     "status": GOAL_STATUS.get(pr.get("status"), "unset"),
                     "target_amount": g.get("target_amount"), "target_date": g.get("target_date"),
                     "delta": round(prob - float(then), 1) if prob is not None and then is not None else None})
    if retirement:
        prob = retirement.get("probability")
        then = probs_then.get("retirement") if isinstance(probs_then, dict) else None
        age = (retirement.get("inputs") or {}).get("retire_age")
        rows.append({"kind": "retirement", "id": None, "name": f"Retire at {age}" if age else "Retirement",
                     "probability": prob, "status": GOAL_STATUS.get(retirement.get("status"), "unset"),
                     "target_amount": retirement.get("corpus_needed"), "target_date": None,
                     "delta": round(prob - float(then), 1) if prob is not None and then is not None else None})
    rows.sort(key=lambda r: (-STATUS_RANK.get(r["status"], -1), r["probability"] if r["probability"] is not None else 101))
    statuses = [r["status"] for r in rows]
    status = "unset" if not any(s in STATUS_RANK for s in statuses) else _worst(statuses)
    return {"status": status, "on_track": sum(1 for s in statuses if s == "good"), "total": len(rows), "rows": rows}


_plan_track = plan_track   # the P0 name


def plan_headline(track: dict) -> str:
    """The Plan hero sentence (H6): "N of M goals on track", joined with " · retirement P% likely" when a
    retirement row exists; "No goals yet" when there is no row at all. Services appends " · family plan"."""
    rows = track.get("rows") or []
    goals = [r for r in rows if r.get("kind") == "goal"]
    ret = next((r for r in rows if r.get("kind") == "retirement"), None)
    if not goals and ret is None:
        return "No goals yet"
    parts = []
    if goals:
        good = sum(1 for r in goals if r.get("status") == "good")
        parts.append(f"{good} of {len(goals)} goal{'s' if len(goals) != 1 else ''} on track")
    if ret is not None:
        p = ret.get("probability")
        bit = f"retirement {p:.0f}% likely" if p is not None else "retirement not scored yet"
        parts.append(bit if goals else bit[0].upper() + bit[1:])
    return " · ".join(parts)


def status_from_excess(excess: float | None, days: int | None) -> str:
    """The market card rule (A16; mirrored by priority.ts `statusFromExcess`): under 180 days of history → unset;
    excess ≥ 0 → good; > −3 → watch; otherwise act."""
    if excess is None or days is None or days < MARKET_MIN_DAYS:
        return "unset"
    if excess >= 0:
        return "good"
    return "watch" if excess > MARKET_WATCH_FLOOR else "act"


def _market_track(port: dict, perf: dict | None, today: date) -> dict:
    if perf is None:
        return {"status": "pending", "excess": None, "diff_value": None, "since": None, "days": None}
    mc = story.market_compare(port, perf)
    row = next((r for r in (mc or {}).get("rows") or [] if r["key"] == story.PRIMARY_BENCH), None)
    since = (mc or {}).get("since")
    since_d = _date(since)
    days = (today - since_d).days if since_d else None
    if row is None:
        return {"status": "unset", "excess": None, "diff_value": None, "since": since, "days": days}
    excess = row.get("excess")
    return {"status": status_from_excess(excess, days), "excess": excess, "diff_value": row.get("diff_value"),
            "since": since, "days": days}


def _milestone(port: dict, monthly: float, today: date) -> dict | None:
    """The next portfolio milestone ahead ({label, when, in}) from story.milestones, or None."""
    try:
        if not (port.get("totals") or {}).get("value"):
            return None
        ahead = (story.milestones(port, monthly, today) or {}).get("ahead") or []
    except Exception:  # noqa: BLE001 — a decoration, never a reason to fail the card
        return None
    row = ahead[0] if ahead else None
    return {"label": row.get("label"), "when": row.get("when"), "in": row.get("in")} if row else None


def _habit_track(ctx: dict, today: date) -> dict:
    """The habit card (A6 `HabitTrack`, H11).

    `invested_month` (BUYs this month, the USD wallet excluded) and `planned_month` (the monthly equivalent of the
    plans running today) keep their P0 meaning. From `ctx['adherence']` (plans.sip_adherence, 6 months):
    `adherence_6m_pct`; `pace` = invested_this_month / planned_this_month × 100 (None when nothing is planned this
    month); `next_due` = the first instalment still to pay; `milestone` = the next story milestone at the plans'
    monthly total. Status: no active plan or no score → unset; ≥ 90 good; ≥ 60 watch; otherwise act. The habit card
    never raises the page status."""
    data = ctx.get("data") or {}
    cash_ids = {i["id"] for i in data.get("instruments") or [] if i.get("asset_class") == d.CASH}
    month = today.isoformat()[:7]
    invested = sum(_f(t.get("amount")) for t in data.get("transactions") or []
                   if t.get("type") == d.BUY and str(t.get("date"))[:7] == month and str(t.get("date"))[:10] <= today.isoformat()
                   and t.get("instrument_id") not in cash_ids)
    planned = monthly_sip_total(ctx.get("sips") or [], today)  # the same total /sips and the forecast use
    adh = ctx.get("adherence") if isinstance(ctx.get("adherence"), dict) else None
    pct = pace = next_due = None
    active = False
    if adh:
        pct = adh.get("adherence_6m_pct")
        active = any(p.get("active", True) for p in adh.get("plans") or [])
        p_month, i_month = _f(adh.get("planned_this_month")), _f(adh.get("invested_this_month"))
        pace = round(i_month / p_month * 100, 1) if p_month > 0 else None
        nd = adh.get("next_due") or []
        next_due = dict(nd[0]) if nd else None
    if not active or pct is None:
        status = "unset"
    else:
        status = "good" if pct >= HABIT_GOOD_PCT else "watch" if pct >= HABIT_WATCH_PCT else "act"
    return {"status": status, "invested_month": round(invested, 2), "planned_month": round(planned, 2),
            "adherence_6m_pct": pct, "pace": pace, "next_due": next_due,
            "milestone": _milestone(ctx.get("port") or {}, planned, today)}


# ── allocation, context line, since-last ──
def _allocation(port: dict) -> list[dict]:
    out = []
    for s in port.get("segments") or []:
        if _f(s.get("value")) <= 0 and s.get("target") is None:
            continue
        drift = s.get("drift")
        if s.get("target") is None or drift is None:
            ds = "unset"
        else:
            ds = "act" if abs(drift) >= DRIFT_ACT else "watch" if abs(drift) >= DRIFT_WATCH else "good"
        out.append({"segment": s["segment"], "value": s.get("value"), "pct": s.get("pct"), "target": s.get("target"),
                    "drift": drift, "drift_status": ds})
    return out


def _context_line(ctx: dict, top: list[dict], summary: dict, settings: dict, today: date,
                  market_state: dict | None = None) -> dict | None:
    """≤1 line, by priority (SPEC §4.1): crash/correction (`markets.context_line(market_state)`, H11), the FY
    window (1 Jan–31 Mar with open tax actions: `summary.tax_open` over every visible action, else the Home list),
    then a review overdue by more than 90 days. The 'tax-free gains unused' figure uses the tax:ltcg-harvest
    thresholds (A12), so it never contradicts that action closing."""
    line = market_context_line(market_state) if market_state else None
    if line:
        return line
    if today.month <= 3:
        opp = ((ctx.get("tax") or {}).get("opportunities") or {}).get("ltcg_harvest") or {}
        remaining, booking = _f(opp.get("remaining_exemption")), _f(opp.get("suggested_booking"))
        tax_open = (int(summary.get("tax_open") or 0) if "tax_open" in summary
                    else sum(1 for a in top if a.get("category") == "tax" and str(a.get("id") or "").startswith("tax:")))
        if tax_open:
            days = (date(today.year, 3, 31) - today).days
            fy = (ctx.get("tax") or {}).get("fy") or ctx.get("fy") or d.fy_of(today.isoformat())
            harvest = remaining >= HARVEST_FLOOR and booking > HARVEST_MIN_BOOKING
            bit = f"{_inrc(remaining)} tax-free gains unused" if harvest else "tax moves still open"
            return {"kind": "fy_window", "text": f"{days} days left in {fy} · {bit} · Plan the sales",
                    "link": "/tax?tab=save"}
    last = _date(settings.get("lastReviewDate"))
    if last is None or (today - last).days > REVIEW_EVERY_DAYS:
        return {"kind": "review", "text": "Quarterly review due · ~10 min", "link": "/actions?tab=review"}
    return None


# ── the Assumption Book on Home (H11) ──
def _book_and_weights(port: dict, settings: dict | None) -> tuple[dict, dict]:
    positions = port.get("positions") or []
    return A.rated_book(positions, A.effective_book(settings)), A.weights_from_positions(positions)


def assumptions_block(port: dict, settings: dict | None) -> dict:
    """The portfolio's ChipBlock (H11): `assumptions.chip(book, weights)` over the holdings mix, plus `basis` and
    `chip` (an alias of `text`, which Home's P0 template reads). `hash` equals Services.book's hash.
    With nothing valued it is the diversified mutual fund forecast assumes (A.NO_HOLDINGS_MIX), not 0% ± 0%."""
    book, w = _book_and_weights(port, settings)
    if not w:
        c = A.chip(book, A.NO_HOLDINGS_MIX)
        return {**c, "basis": A.NO_HOLDINGS_BASIS, "chip": c["text"]}
    c = A.chip(book, w)
    return {**c, "basis": CHIP_BASIS, "chip": c["text"]}


def assumptions_check(port: dict, perf: dict | None, settings: dict | None) -> dict | None:
    """Is the realised return inside the Book's typical band (A6 `AssumptionsCheck` plus `link`, H11)?

    Only with the ALL-range performance (`perf`); None without it, without a start and end, or with nothing held.
    years = (metrics.end − metrics.start) / 365.25 and realised_pct = metrics.twr_annualised. μ, σ =
    mu_sigma(weights_from_positions, rated_book). Under a year (or with no annualised TWR yet) the verdict is
    `too_short` with the 1-year band; otherwise typical_band(μ, σ, years) gives `within`, `above` or `below`.
    `link` = /plan?return=<realised to 0.5> only when below, typical − realised ≥ 3 pts and years ≥ 2."""
    if perf is None:
        return None
    m = perf.get("metrics") or {}
    start, end = _date(m.get("start")), _date(m.get("end"))
    if start is None or end is None:
        return None
    book, w = _book_and_weights(port, settings)
    if not w:
        return None
    mu, sigma = A.mu_sigma(w, book)
    years = (end - start).days / 365.25
    realised = m.get("twr_annualised")
    realised = float(realised) if isinstance(realised, (int, float)) else None
    if years < 1 or realised is None:
        band, verdict = A.typical_band(mu, sigma, 1), "too_short"
    else:
        band = A.typical_band(mu, sigma, years)
        verdict = "above" if realised > band["hi"] else "below" if realised < band["lo"] else "within"
    link = None
    if (verdict == "below" and band["typical"] - realised >= ASSUMPTIONS_LINK_GAP_PTS
            and years >= ASSUMPTIONS_LINK_YEARS):
        link = f"/plan?return={round(realised * 2) / 2:g}"
    return {"realised_pct": realised, "years": round(years, 2), "typical": band["typical"], "lo": band["lo"],
            "hi": band["hi"], "verdict": verdict, "link": link}


def p1_fields(port: dict, settings: dict | None, cushion: dict | None, risk_est: dict | None,
              empty: bool = False) -> dict:
    """The brief's optional P1 fields W1-F1 typed (H11): `assumptions` (ChipBlock, None for an empty ledger) and
    the `cushion` / `risk_est` pass-throughs. Services merges them into the payload; they stay outside
    `build_brief`'s return because its key set is the A6 contract that test_wave1_contracts pins."""
    try:
        chip = None if empty else assumptions_block(port, settings)
    except Exception:  # noqa: BLE001 — a missing chip never fails the brief
        chip = None
    return {"assumptions": chip, "cushion": cushion, "risk_est": risk_est}


def _since_last(port: dict, snapshot_then: dict | None, snap: dict, top: list[dict], summary: dict) -> dict | None:
    if not snapshot_then or "value" not in snap:
        return None
    then, now = _f(snap.get("value")), _f((port.get("totals") or {}).get("value"))
    change = now - then
    if "new" in summary:
        new = int(summary["new"] or 0)
    else:
        seen = set(snap.get("action_ids") or [])
        new = sum(1 for a in top if a.get("is_new") or (seen and a.get("id") not in seen))
    return {"date": snapshot_then.get("date"), "change": round(change, 2),
            "change_pct": round(change / then * 100, 2) if then > 0 else None, "actions_new": new}


def _nifty_d1(quote) -> float | None:
    if isinstance(quote, str):
        try:
            quote = json.loads(quote)
        except ValueError:
            return None
    if not isinstance(quote, dict):
        return None
    price, prev = _f(quote.get("price")), _f(quote.get("prev_close"))
    return round((price / prev - 1) * 100, 2) if price > 0 and prev > 0 else None


# ── onboarding (SPEC §7.8) ──
def _onboard_actions(today: date) -> list[dict]:
    base = {"kind": "state", "tier": "now", "severity": "info", "status": "open", "category": "data", "why": None,
            "assumptions": None, "impact": None, "due": None, "days": None, "confidence": "fact", "score": 0.0,
            "owner": None, "instrument_id": None, "first_seen": today.isoformat(), "is_new": False, "done_via": None,
            "evidence": None, "planned_for": None, "snooze_until": None, "days_late": None, "meta": {}}
    return [
        {**base, "id": "onboard:import", "title": "Import a CAS statement",
         "detail": "Bring in your mutual funds and stocks in one go from a CAS or broker statement.",
         "cta": {"label": "Import", "type": "route", "route": "/import"}, "link": "/import"},
        {**base, "id": "onboard:add", "title": "Add your first transaction",
         "detail": "Record a purchase, an FD or a loan by hand.",
         "cta": {"label": "Add", "type": "dialog",
                 "dialog": {"kind": None, "instrumentId": None, "type": "BUY", "amount": None}},
         "link": "/transactions"},
    ]


# ── the brief ──
def build_brief(ctx: dict, actions: dict | None, upcoming: dict | None, plan: dict | None, risk_est: dict | None,
                stress: dict | None, perf: dict | None, snapshot_then: dict | None, market_state: dict | None,
                nifty_quote: dict | None, settings: dict | None, today: date | None, *,
                cushion: dict | None = None, deploy: dict | None = None, now: datetime | None = None) -> dict:
    """Compose the Home brief (AMENDMENTS A6 `Brief`).

    ctx            `Services.context` ({port, data, fy, tax, goals, sips, adherence}); read-only. Services hands a
                   shallow copy whose `adherence` is `Services.adherence` (H2); None leaves the habit card unset.
    actions        {"top": [Action ≤5] from actions.for_home, "summary": {now, month, consider, good, impact_total,
                   new, tax_open}} or None (no actions, zero summary). `new` and `tax_open` count every visible
                   action; without them the brief falls back to counting `top`.
    upcoming       calendar.upcoming() output (H3), passed through; None when it could not be built.
    plan           {goals, retirement|None} (the shared action inputs); None → goals from ctx, no retirement row.
    risk_est       {vol_pct, target_vol_pct, profile, closest_profile}; None → Risk vital unset.
    stress         accepted for the stress-aware notes (P2); unused.
    perf           the ALL-range performance payload (A16); None → market card pending, pending = ['market'],
                   and no assumptions_check.
    snapshot_then  {date, data} from kpi_snapshot_at(since); None → no since-last stat.
    market_state   markets.market_state over the stored ^NSEI closes (H4), passed through; in a correction or a
                   crash it sets the context line.
    nifty_quote    {price, prev_close, date} (system value quote:^NSEI) → hero.nifty_d1.
    settings       the owner's settings (emergencyFund, riskProfile, lastReviewDate, targetAllocation...).
    today          the brief's date.
    cushion/deploy precomputed `cushion_state` / `deploy_state` results; None → computed here (deploy without
                   P2P principal, since there are no cash-flow events).
    now            the clock for price freshness (default: the current UTC time).
    """
    del stress  # P2: the stress-aware cushion/risk notes
    today = today or date.today()
    now = now or datetime.now(timezone.utc)
    settings = settings or {}
    port = ctx.get("port") or {}
    totals = port.get("totals") or {}
    total_value = _f(totals.get("value"))
    actions = actions or {}
    top = list(actions.get("top") or [])[:5]
    summary = actions.get("summary") or {}
    count_now, count_month = int(summary.get("now") or 0), int(summary.get("month") or 0)
    impact_total = round(_f(summary.get("impact_total")), 2)
    snap = _snap_data(snapshot_then)
    tax = ctx.get("tax") or {}
    pending = ["market"] if perf is None else []

    cushion = cushion if cushion is not None else cushion_state(port, settings, today)
    deploy = deploy if deploy is not None else deploy_state(port, None, today)
    fresh = _freshness(port, now)
    freshness = {k: v for k, v in fresh.items() if not k.startswith("_")}
    hero_since = _since_last(port, snapshot_then, snap, top, summary)
    common = {
        "hero": {"nifty_d1": _nifty_d1(nifty_quote), "since_last": hero_since},
        "why": story.attribution(port),
        "allocation": _allocation(port),
        "upcoming": upcoming,
        "tax": {"fy": tax.get("fy") or ctx.get("fy"), "estimate_total": (tax.get("estimate") or {}).get("total")},
        "deploy": deploy,
        "freshness": freshness,
        "assumptions_check": None,
        "market_state": market_state,
    }
    if not _empty_ledger(ctx):
        try:
            common["assumptions_check"] = assumptions_check(port, perf, settings)
        except Exception:  # noqa: BLE001 — a T3 comparison never fails the brief
            common["assumptions_check"] = None

    if _empty_ledger(ctx):
        return {
            "status": {"status": "unset", "headline": "Let's add your first investment", "count_now": 0,
                       "count_month": 0, "impact_total": 0.0},
            **common,
            "vitals": [],
            "actions": _onboard_actions(today),
            "on_track": {"plan": {"status": "unset", "on_track": 0, "total": 0, "rows": []},
                         "market": _market_track(port, perf, today), "habit": _habit_track(ctx, today)},
            "context_line": None,
            "pending": pending,
            "empty": True,
        }

    mar = _money_at_risk(port, today)
    vitals = [
        _safe(lambda: _data_vital(fresh), "data"),
        _safe(lambda: _cushion_vital(cushion), "cushion"),
        _safe(lambda: _risk_vital(risk_est, port, settings), "risk"),
        _safe(lambda: _mix_vital(port), "mix"),
        _safe(lambda: _money_vital(mar, total_value), "money_at_risk"),
    ]
    by_key = {v["key"]: v for v in vitals}

    # Headline: first match of the §4.1 ladder
    if by_key["money_at_risk"]["status"] == "act":
        headline, ladder = _money_headline(mar), "act"
    elif by_key["data"]["status"] == "act":
        headline, ladder = _data_headline(fresh), "act"
    elif count_now > 0:
        headline = f"{count_now} thing{'s need' if count_now > 1 else ' needs'} you this week"
        if top:
            headline += f" · top: {top[0].get('title')}"
        ladder = "act"
    elif count_month > 0:
        headline, ladder = f"{count_month} thing{'s' if count_month > 1 else ''} to look at this month", "watch"
    else:
        headline, ladder = "All clear — nothing needs you today", "good"
    vital_statuses = [v["status"] for v in vitals]
    status = _worst([ladder, *vital_statuses])
    if ladder == "good" and status != "good":
        # nothing is due, but a vital is watch/act: don't call that "all clear"
        flagged = [v["label"] for v in vitals if v["status"] in ("watch", "act")]
        headline = f"Nothing due today · {' and '.join(flagged[:2])} need{'s' if len(flagged) == 1 else ''} a look"

    return {
        "status": {"status": status, "headline": headline, "count_now": count_now, "count_month": count_month,
                   "impact_total": impact_total},
        **common,
        "vitals": vitals,
        "actions": top,
        "on_track": {"plan": plan_track(ctx, plan, snap), "market": _market_track(port, perf, today),
                     "habit": _habit_track(ctx, today)},
        "context_line": _context_line(ctx, top, summary, settings, today, market_state),
        "pending": pending,
        "empty": False,
    }
