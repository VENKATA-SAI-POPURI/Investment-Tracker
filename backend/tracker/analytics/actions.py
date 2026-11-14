"""Actions: what to do next, ranked by real rupees.

Implements SPEC Part 1 §1.4–§1.7 and Part 2 §8.1–§8.5 (not §8.6), as amended by AMENDMENTS A6–A15, A24
and A28. A pure module: it reads the sources it is handed and never touches the database or services.
It imports nothing from ``brief.py`` (A6); ``brief.py`` composes the result through ``for_home`` and
``summary``.

The pieces:

* ``build_actions(src, log, today)`` turns the sources (``ActionSources``) into Action objects (§8.1):
  every §8.3 rule whose source key is present fires, the action log is overlaid (snoozed, planned,
  done, dismissed, expired, and the legacy period-free snooze alias of A8), the §8.3 close rules run
  (``auto_done``), event windows expire, and the visible actions come back ranked.
* ``rank(actions, vitals)`` assigns the §1.7 tier and score and sorts.
* ``diversify(actions, k)`` and ``for_home(actions, total_value, data_status, k)`` apply the §1.4
  admission thresholds and the §1.5 budgets.
* ``summary(actions)`` gives the counts per tier and the rupees at stake (lump impacts only).
* ``auto_done(action, txns, port, tax, today)`` is the evidence that closes an action, or None.
* ``follow_through(log, adherence, today)`` measures what the user acted on (§8.5).
* ``action_id_for_insight(insight, today, sips)`` derives the period-keyed action id of A8 and A9.
* ``action_from_row(row, src, today)`` maps an action-log row to the Action shape (Done / Snoozed lists, E5).

Severity uses the §8.3 vocabulary ``crit``, ``warn``, ``info``, ``pos`` (models.ts ``ActionSeverity``); an
insight's ``critical``/``warning``/``info``/``positive`` maps onto it, with the §8.3 overrides. ``link`` is
the evidence page and ``cta`` is what to do (A7); a CTA route carries its query and fragment separately so
the router can navigate with them (A13).
"""
from __future__ import annotations

import calendar as _calendar
from datetime import date, timedelta
from statistics import median
from typing import Any, TypedDict
from urllib.parse import parse_qsl, urlencode, urlsplit

from .. import domain as d

# ── constants ──

HARVEST_FLOOR = 2000            # A12: tax:ltcg-harvest fires at remaining_exemption >= floor and closes below it
HARVEST_MIN_BOOKING = 1000      # ... and only when more than ₹1,000 can be booked
LOSS_HARVEST_MIN = 500          # offsettable losses worth a mention (the insight's threshold)
LOSS_HARVEST_DONE_SHARE = 0.2   # closes when offsettable falls by >= 80%
WAIT_LT_DAYS, WAIT_LT_MIN_SAVING = 45, 200
REDEPLOY_SHARE = 0.8            # FD / P2P money counts as redeployed at >= 80% ...
REDEPLOY_DAYS = 45              # ... within 45 days
SIP_MATCH_SHARE = 0.8           # P1.10: an SIP BUY in the window at >= 80% of the instalment
SIP_WINDOW_BEFORE, SIP_WINDOW_AFTER = 3, 20   # §7.6 matching window [d - 3, d + 20]
SIP_MISSED_EXPIRY = 30          # sip:missed expires 30 days after its due date
SIP_DUE_AHEAD = 5               # sip:due shows 5 days ahead
FD_SOON_DAYS = 30               # fd:maturing within 30 days
FD_OVERDUE_CRIT_DAYS = 30       # fd:matured-unrecorded turns critical after 30 days
P2P_PRINCIPAL_MIN = 10000
P2P_PRINCIPAL_WINDOW = 30
DEPLOY_MIN = 10000
USD_MIN = 50
RISK_WATCH_PTS, RISK_ACT_PTS = 2.0, 5.0       # A24: v > t + 2 -> warning, v > t + 5 -> critical
STRESS_TOLERANCE = 2.5          # covid impact_pct < -2.5 x target_vol_pct
PROB_DROP_PTS = 10
UNPRICED_CRIT_PCT = 5.0
IMPACT_FLOOR = 1000             # score = max(amount, 1000) x U x C
HOME_SHARE = 0.0025             # §1.4: T1 needs impact >= max(₹1,000, 0.25% of value) ...
HOME_DAYS = 30                  # ... or a deadline within 30 days

# The id grammar: every action id starts with one of these. W2-B1's POST route rejects anything else (A11).
ACTION_PREFIXES = (
    "data:missing-prices", "data:stale-prices", "data:import-due:", "nps:nav-stale:",
    "p2p:defaulted", "p2p:overdue", "p2p:yield",
    "fd:maturing:", "fd:matured-unrecorded:",
    "cash:usd", "cash:p2p-principal:", "deploy:idle", "cushion:low",
    "drift:", "targets:missing", "concentration:", "sector:", "diversification:stocks",
    "risk:above-profile", "stress:beyond-tolerance",
    "tax:ltcg-harvest:", "tax:loss-harvest:", "tax:wait-lt:", "elss:unlocked:",
    "sip:missed:", "sip:due:", "sip:ended:", "sip:gap:",
    "goal:", "retirement:gap", "plan:probability-drop:", "review:due:",
    "loser:", "winner:", "perf:vs-nifty", "perf:drawdown", "perf:xirr",
    "market:target-hit:", "onboard:", "notice:",
)

SEVERITY_OF_INSIGHT = {"critical": "crit", "warning": "warn", "info": "info", "positive": "pos"}
TIERS = ("now", "month", "consider", "good")
TIER_ORDER = {t: i for i, t in enumerate(TIERS)}
CONFIDENCE = {"fact": 1.0, "estimate": 0.8, "model": 0.6, "signal": 0.3}
OPEN_STATUSES = ("open", "planned")

# State actions whose condition clearing is the user's doing: when they stop firing they close as done
# (auto), not expired (§8.4). Anything else that stops firing without evidence expires.
CLEARED_IS_DONE = ("data:missing-prices", "data:stale-prices", "nps:nav-stale:", "p2p:defaulted", "p2p:overdue",
                   "cash:usd", "cushion:low", "targets:missing", "review:due:", "sip:ended:")
# Mix actions that clear either because the user rebalanced (done) or because prices moved (expired): the stale
# path credits them only with evidence of user activity (`_activity_evidence`).
ACTIVITY_IS_DONE = ("drift:", "concentration:", "risk:above-profile")


class Cushion(TypedDict, total=False):
    set: bool
    months: float | None
    target_months: int
    monthly_expenses: float | None
    amount: float
    cash_amount: float
    instrument_ids: list[int]
    candidates: list[dict]
    candidates_amount: float


class Deploy(TypedDict, total=False):
    suggested: float
    sources: list[dict]   # {kind, label, segment, instrument_id, date, amount, held_value}


class RiskEst(TypedDict, total=False):
    vol_pct: float | None
    target_vol_pct: float | None
    profile: str | None
    closest_profile: str | None


class ActionSources(TypedDict, total=False):
    """Everything ``build_actions`` can read (A6). Every key is optional; a missing key skips its rules."""
    owner: str                    # the settings owner: the user's email, or '__global__'
    port: dict                    # compute_portfolio output
    txns: list[dict]              # ledger transaction rows
    sips: list[dict]              # sip_plans rows
    settings: dict
    insights: list[dict]          # build_insights output
    calendar: dict                # build_calendar output (read by brief; no §8.3 rule uses it)
    cashflow_events: list[dict]   # cash_flow_forecast(...)["events"]
    tax: dict                     # the current-FY compute_tax output, with opportunities
    adherence: dict | None        # plans.sip_adherence output (§7.6); None until W4-B1
    upcoming: Any                 # accepted for brief parity; no §8.3 rule reads it
    plan: dict                    # {"goals": [goal rows with projection], "retirement": retirement_plan output}
    stress: dict                  # forecast.stress_test output
    market_state: Any             # context line only (brief); no action
    snapshot_then: dict           # kpi snapshot {date, data} or its data: action_ids, goal_probs, ...
    cushion: Cushion
    deploy: Deploy
    risk_est: RiskEst


# ── small helpers ──

def _d(v) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _inr(v: float) -> str:
    v = round(v)
    s, neg = str(abs(v)), v < 0
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts) + "," + tail
    return ("-₹" if neg else "₹") + s


def _month_day(y: int, m: int, day: int) -> date:
    """`day` of the month, clamped to the month's last day (a plan on the 31st falls due on 28 Feb)."""
    return date(y, m, min(max(int(day or 1), 1), _calendar.monthrange(y, m)[1]))


def _quarter(today: date) -> tuple[str, date]:
    q = (today.month - 1) // 3 + 1
    end_m = q * 3
    return f"{today.year}-Q{q}", date(today.year, end_m, _calendar.monthrange(today.year, end_m)[1])


def _fy_end(fy: str) -> date:
    return date.fromisoformat(d.fy_bounds(fy)[1])


def _last_weekday_on_or_before(day: date) -> date:
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def _route(url: str, label: str) -> dict:
    """A route CTA from a link string: the path, its query and fragment kept apart (A13)."""
    parts = urlsplit(url)
    cta = {"label": label, "type": "route", "route": parts.path or "/"}
    if parts.query:
        cta["query"] = dict(parse_qsl(parts.query))
    if parts.fragment:
        cta["fragment"] = parts.fragment
    return cta


def deploy_cta(amount: float | None, label: str = "Plan where it goes") -> dict:
    """The deploy CTA (A13): /actions with ?new_money=<amount> and #deploy; bare /actions#deploy without an amount."""
    cta = {"label": label, "type": "route", "route": "/actions", "fragment": "deploy"}
    if amount and amount > 0:
        cta["query"] = {"new_money": int(round(amount))}
    return cta


def cta_href(cta: dict | None) -> str | None:
    """The string form of a route CTA: path, then ?query, then #fragment (never the query after '#')."""
    if not cta or cta.get("type") != "route" or not cta.get("route"):
        return None
    href = cta["route"]
    if cta.get("query"):
        href += "?" + urlencode(cta["query"])
    if cta.get("fragment"):
        href += "#" + cta["fragment"]
    return href


_IMPACT_LABEL = {
    "tax": "Saves {} tax (est.)", "p2p": "{} at risk", "fd": "{} to reinvest", "cash": "{} to reinvest",
    "allocation": "{} off target", "habit": "{} instalment", "goals": "+{}/month needed",
    "data": "{} valued at cost", "risk": "{} above 10%",
}


def _impact(amount: float | None, category: str, kind: str = "lump", label: str | None = None) -> dict | None:
    if amount is None or amount <= 0.5:
        return None
    amount = round(float(amount), 2)
    tpl = label or _IMPACT_LABEL.get(category, "{}")
    return {"amount": amount, "kind": kind, "label": tpl.format(_inr(amount))}


def legacy_id(aid: str) -> str | None:
    """The period-free id an action had before A8 (sip:missed:<sid>:<due> -> sip:missed:<sid>), or None."""
    for base in ("tax:ltcg-harvest", "tax:loss-harvest", "review:due"):
        if aid.startswith(base + ":"):
            return base
    if aid.startswith("sip:missed:") and aid.count(":") >= 3:
        return aid.rsplit(":", 1)[0]
    return None


def _sip_due(plan: dict | None, today: date) -> date:
    return _month_day(today.year, today.month, (plan or {}).get("day_of_month") or 1)


def action_id_for_insight(insight: dict | str, today: date | None = None, sips: list[dict] | None = None) -> str:
    """The action id for an insight id (A8, A9). Insight ids are frozen; period keys live only here.

    tax:ltcg-harvest -> tax:ltcg-harvest:<FY>; tax:loss-harvest -> tax:loss-harvest:<FY>;
    review:due -> review:due:<YYYY-Qn>; sip:missed:<sid> -> sip:missed:<sid>:<due>, where due is the plan's
    day_of_month this month, clamped to the month's end. Every other id is returned unchanged.
    """
    iid = insight if isinstance(insight, str) else insight.get("id") or ""
    today = today or date.today()
    if iid in ("tax:ltcg-harvest", "tax:loss-harvest"):
        return f"{iid}:{d.fy_of(today.isoformat())}"
    if iid == "review:due":
        return f"review:due:{_quarter(today)[0]}"
    if iid.startswith("sip:missed:") and iid.count(":") == 2:
        sid = iid.split(":")[2]
        plan = next((s for s in sips or [] if str(s.get("id")) == sid), None)
        return f"{iid}:{_sip_due(plan, today).isoformat()}"
    return iid


# ── the action object ──

def _new(id_: str, *, category: str, severity: str, confidence: str, title: str, cta: dict, link: str | None,
         detail: str | None = None, why: str | None = None, impact: dict | None = None, due: date | None = None,
         kind: str | None = None, instrument_id: int | None = None, meta: dict | None = None,
         expires: date | None = None) -> dict:
    return {
        "id": id_, "kind": kind or ("event" if due else "state"), "tier": None, "severity": severity, "status": "open",
        "category": category, "title": title, "detail": detail, "why": why, "assumptions": None,
        "impact": impact, "due": due.isoformat() if due else None, "days": None, "confidence": confidence,
        "score": None, "owner": None, "instrument_id": instrument_id, "cta": cta, "link": link,
        "first_seen": None, "is_new": False, "done_via": None, "evidence": None, "planned_for": None,
        "snooze_until": None, "days_late": None, "meta": meta or {},
        "_expires": expires,
    }


class _Ctx:
    """Lookups shared by the rules."""

    def __init__(self, src: ActionSources, today: date):
        self.src, self.today = src, today
        self.port = src.get("port")
        port = self.port or {}
        self.positions = port.get("positions") or []
        self.pos = {p["id"]: p for p in self.positions if p.get("id") is not None}
        self.total = _f((port.get("totals") or {}).get("value"))
        self.sips = {s["id"]: s for s in src.get("sips") or [] if s.get("id") is not None}
        self.txns = src.get("txns") or []
        self.settings = src.get("settings") or {}
        self.owner = src.get("owner")
        self.log: dict = {}   # the action log, set by build_actions (read by rules that span periods)

    def sip(self, sid) -> dict | None:
        try:
            return self.sips.get(int(sid))
        except (TypeError, ValueError):
            return self.sips.get(sid)

    def owner_of(self, a: dict) -> str | None:
        """A10: instrument.owner for an instrument action; the plan's instrument owner (or sip.owner) for an
        SIP action; otherwise the settings owner."""
        sid = a["meta"].get("sip_id")
        if sid is not None:
            plan = self.sip(sid) or {}
            p = self.pos.get(plan.get("instrument_id") or a.get("instrument_id"))
            if p and p.get("owner"):
                return p["owner"]
            return plan.get("owner") or self.owner
        p = self.pos.get(a.get("instrument_id"))
        if p and p.get("owner"):
            return p["owner"]
        return self.owner


def _maturity_received(c: _Ctx, iid: int) -> tuple[float, date | None]:
    rows = [t for t in c.txns if t.get("instrument_id") == iid and t.get("type") == d.MATURITY]
    return sum(_f(t.get("amount")) for t in rows), max((_d(t["date"]) for t in rows), default=None)


def _fd_maturing(c: _Ctx, iid: int, due: date | None, amount: float | None, name: str | None,
                 matured: bool = False) -> dict:
    days = (due - c.today).days if due else None
    when = ("matured" if matured else "matures today" if days == 0 else f"matures in {days} days" if days is not None
            else "matures soon")
    amt = _inr(amount) if amount else "the money"
    return _new(
        f"fd:maturing:{iid}", category="fd", severity="warn", confidence="fact",
        title=f"FD at {name or 'your bank'} {when}",
        detail=f"About {amt} {'came back' if matured else 'will be credited'}.",
        why="Decide where the money goes next, so it doesn't sit idle.",
        impact=_impact(amount, "fd"), due=due, kind="event", instrument_id=iid,
        cta=deploy_cta(amount), link="/fixed-deposits", meta={"maturity_value": amount},
        expires=due + timedelta(days=REDEPLOY_DAYS) if due else None)


# ── rules, one function per source ──

def _rules_port(c: _Ctx):
    """fd:matured-unrecorded (A28) and fd:maturing from the FD positions, including a recorded maturity's
    45-day redeploy window."""
    if c.port is None:
        return
    for p in c.positions:
        if p.get("asset_class") != d.FIXED_DEPOSIT:
            continue
        mat = _d(p.get("maturity_date"))
        if p.get("is_open"):
            if mat is None:
                continue
            if mat < c.today:   # A28: after maturity days_to_maturity is None, so test the date itself
                overdue = (c.today - mat).days
                amount = _f(p.get("value")) or None   # value is accrued up to maturity
                yield _new(
                    f"fd:matured-unrecorded:{p['id']}", category="fd",
                    severity="crit" if overdue > FD_OVERDUE_CRIT_DAYS else "warn", confidence="fact",
                    title=f"FD at {p.get('name')} matured {overdue} days ago",
                    detail=f"It matured on {mat.isoformat()} but no maturity is recorded, so about "
                           f"{_inr(amount or 0)} is still counted as a deposit.",
                    why="Record the maturity so the money shows as available.",
                    impact=_impact(amount, "fd"), due=mat, kind="event", instrument_id=p["id"],
                    cta={"label": "Mark matured", "type": "fd_mature", "instrument_id": p["id"]},
                    link="/fixed-deposits")
            elif (mat - c.today).days <= FD_SOON_DAYS:
                yield _fd_maturing(c, p["id"], mat, p.get("maturity_value") or p.get("value"), p.get("name"))
        else:
            received, on = _maturity_received(c, p["id"])
            on = on or mat
            if on is None or not (0 <= (c.today - on).days <= REDEPLOY_DAYS):
                continue
            amount = received or (_f(p.get("invested")) + _f(p.get("realized"))) or None
            yield _fd_maturing(c, p["id"], on, amount, p.get("name"), matured=True)


def _rules_cashflow(c: _Ctx):
    for e in c.src.get("cashflow_events") or []:
        if e.get("kind") != "fd_maturity" or e.get("instrument_id") is None:
            continue
        due = _d(e.get("date"))
        if due is None or not (0 <= (due - c.today).days <= FD_SOON_DAYS):
            continue
        p = c.pos.get(e["instrument_id"]) or {}
        yield _fd_maturing(c, e["instrument_id"], due, p.get("maturity_value") or e.get("amount"),
                           p.get("name") or e.get("name"))


def _sip_cta(plan: dict, amount: float, due: date) -> dict:
    if plan.get("instrument_id"):
        # no dialog kind: the action runner derives the add-dialog kind from the instrument's class
        return {"label": "Record the instalment", "type": "dialog",
                "dialog": {"instrumentId": plan["instrument_id"], "type": d.BUY,
                           "amount": round(amount, 2), "date": due.isoformat()}}
    return _route("/recurring", "Open Recurring")


def _sip_action(c: _Ctx, kind: str, sid, due: date, amount: float, plan: dict, name: str | None) -> dict:
    name = name or plan.get("name") or "your SIP"
    if kind == "missed":
        return _new(
            f"sip:missed:{sid}:{due.isoformat()}", category="habit", severity="warn", confidence="fact",
            title=f"SIP of {_inr(amount)} in {name} looks missed",
            detail=f"It was due on {due.isoformat()} and no matching purchase is recorded.",
            why="Record the instalment if it went through, or skip this month.",
            impact=_impact(amount, "habit"), due=due, kind="event", instrument_id=plan.get("instrument_id"),
            cta=_sip_cta(plan, amount, due), link="/recurring",
            meta={"sip_id": sid, "segment": plan.get("segment"), "amount": amount},
            expires=due + timedelta(days=SIP_MISSED_EXPIRY))
    return _new(
        f"sip:due:{sid}:{due.isoformat()}", category="habit", severity="info", confidence="fact",
        title=f"SIP of {_inr(amount)} in {name} is due {'today' if due == c.today else 'on ' + due.isoformat()}",
        detail="Record it once the money has gone through.", why=None,
        impact=_impact(amount, "habit"), due=due, kind="event", instrument_id=plan.get("instrument_id"),
        cta=_sip_cta(plan, amount, due), link="/recurring",
        meta={"sip_id": sid, "segment": plan.get("segment"), "amount": amount},
        expires=due + timedelta(days=SIP_WINDOW_AFTER))


def _rules_adherence(c: _Ctx):
    """sip:missed and sip:due from the plans engine (§7.6). When adherence is present it is the only source of
    sip:missed (A9)."""
    adh = c.src.get("adherence")
    if not adh:
        return
    for plan_row in adh.get("plans") or []:
        sid = plan_row.get("id")
        plan = {**(c.sip(sid) or {}), "id": sid}
        plan.setdefault("name", plan_row.get("name"))
        for m in plan_row.get("months") or []:
            due = _d(m.get("due"))
            if due is None:
                continue
            amount = _f(m.get("planned")) or _f(plan.get("amount"))
            st = m.get("status")
            if st == "missed" and (c.today - due).days <= SIP_MISSED_EXPIRY:
                yield _sip_action(c, "missed", sid, due, amount, plan, plan_row.get("name"))
            elif st == "upcoming" and 0 <= (due - c.today).days <= SIP_DUE_AHEAD:
                yield _sip_action(c, "due", sid, due, amount, plan, plan_row.get("name"))


def _rules_sips(c: _Ctx):
    """sip:ended: a plan still marked active whose end date has passed."""
    if "sips" not in c.src:
        return
    for sid, s in c.sips.items():
        end = _d(s.get("end_date"))
        if s.get("active", 1) and end and end < c.today:
            yield _new(
                f"sip:ended:{sid}", category="habit", severity="info", confidence="fact",
                title=f"SIP plan {s.get('name') or sid} ended on {end.isoformat()}",
                detail="The plan is still marked active. Extend it, or pause it so it stops counting.",
                cta=_route("/recurring", "Open Recurring"), link="/recurring", instrument_id=s.get("instrument_id"),
                meta={"sip_id": sid, "segment": s.get("segment")})


def _rated_lines(tax: dict | None) -> list[tuple[float, float]]:
    """This year's taxable capital-gains lines as (rate fraction, taxable ₹), highest rate first."""
    lines = [(_f(line.get("rate")) / 100, _f(line.get("taxable"))) for line in (tax or {}).get("tax_lines") or []]
    return sorted(((r, t) for r, t in lines if r > 0 and t > 0), key=lambda x: -x[0])


def loss_harvest_saving(tax: dict | None, offsettable: float) -> float:
    """Tax a loss harvest of `offsettable` saves (est.): the losses cancel this year's taxable lines highest rate
    first, Σ min(remaining, line.taxable) × rate. Never more than the year's capital-gains tax, because gains that
    the exemption already shields (or that pay a lower rate) save nothing extra (W2 review, amends the §1.7
    'offsettable × top rate')."""
    left, saved = max(_f(offsettable), 0.0), 0.0
    for rate, taxable in _rated_lines(tax):
        if left <= 0:
            break
        used = min(left, taxable)
        saved += used * rate
        left -= used
    return saved


def _offset_for_saving(tax: dict | None, saving: float) -> float:
    """The inverse of `loss_harvest_saving` over today's lines: the offsettable a stored saving stood for. A saving
    larger than today's whole capital-gains tax (the lines have shrunk since) is extended at the lowest rate.
    0 when there is no line to read a rate from."""
    lines = _rated_lines(tax)
    left, off = max(_f(saving), 0.0), 0.0
    for rate, taxable in lines:
        if left <= rate * taxable:
            return off + left / rate
        off += taxable
        left -= rate * taxable
    return off + left / lines[-1][0] if lines else 0.0


def _rules_tax(c: _Ctx):
    tax = c.src.get("tax")
    if not tax or not tax.get("opportunities"):
        return
    fy = tax.get("fy") or d.fy_of(c.today.isoformat())
    opp = tax["opportunities"]
    q4 = c.today.month in (1, 2, 3)
    lt = opp.get("ltcg_harvest") or {}
    remaining, booking = _f(lt.get("remaining_exemption")), _f(lt.get("suggested_booking"))
    if remaining >= HARVEST_FLOOR and booking > HARVEST_MIN_BOOKING:
        due = _last_weekday_on_or_before(_fy_end(fy))
        yield _new(
            f"tax:ltcg-harvest:{fy}", category="tax", severity="warn" if q4 else "info", confidence="estimate",
            title=f"Book up to {_inr(booking)} of long-term gains tax-free",
            detail=f"{_inr(remaining)} of this year's equity LTCG exemption is unused.",
            why="Sell and rebuy the same units before 31 March to reset your cost basis.",
            impact=_impact(lt.get("future_tax_saved"), "tax"), due=due, kind="event",
            cta=_route("/tax?tab=save", "See the harvest plan"), link="/tax?tab=save",
            meta={"fy": fy, "remaining_exemption": remaining, "suggested_booking": booking}, expires=due)
    off = _f(opp.get("loss_harvest_offsettable"))
    if off > LOSS_HARVEST_MIN:
        due = _fy_end(fy)
        yield _new(
            f"tax:loss-harvest:{fy}", category="tax", severity="warn" if q4 else "info", confidence="estimate",
            title=f"Harvest losses to offset {_inr(off)} of gains",
            detail="Holdings below cost can be sold to cancel out capital gains already booked this year.",
            why="Review the loss-harvesting list on the Tax page.",
            impact=_impact(loss_harvest_saving(tax, off), "tax"), due=due, kind="event",
            cta=_route("/tax?tab=save", "See the losses"), link="/tax?tab=save",
            meta={"fy": fy, "offsettable": off}, expires=due)
    for lot in (opp.get("upcoming_long_term") or [])[:3]:
        if lot.get("days_to_lt", 999) > WAIT_LT_DAYS or _f(lot.get("tax_saving")) < WAIT_LT_MIN_SAVING:
            continue
        lt_on = _d(lot.get("lt_on"))
        iid = lot.get("instrument_id")
        yield _new(
            f"tax:wait-lt:{iid}:{lot.get('date')}", category="tax", severity="info", confidence="estimate",
            title=f"Hold {lot.get('name')} {lot.get('days_to_lt')} more days",
            detail=f"The lot bought on {lot.get('date')} turns long-term on {lot.get('lt_on')}; selling after that "
                   f"saves about {_inr(_f(lot.get('tax_saving')))}.",
            impact=_impact(lot.get("tax_saving"), "tax"), due=lt_on, kind="event", instrument_id=iid,
            cta={"label": "What if I sell now?", "type": "whatif",
                 "whatif": {"instrument_id": iid, "qty": lot.get("qty")}},
            link=f"/tax?tab=whatif&whatif={iid}", expires=lt_on)


def _rules_cushion(c: _Ctx):
    cu = c.src.get("cushion")
    if not cu or not cu.get("set") or cu.get("months") is None:
        return
    months, target = _f(cu.get("months")), _f(cu.get("target_months"))
    if target <= 0 or months >= target:
        return
    short = (target - months) * _f(cu.get("monthly_expenses"))
    yield _new(
        "cushion:low", category="cash", severity="warn" if months < 3 else "info", confidence="fact",
        title=f"Your emergency cushion covers {months:.1f} months",
        detail=f"The target is {target:g} months of expenses.",
        why="Build the cushion before adding risk: it is what stops a bad month turning into a forced sale.",
        impact=_impact(short, "cash", label="{} short"), cta=_route("/settings#cushion", "Set up the cushion"),
        link="/settings#cushion")


def _rules_deploy(c: _Ctx):
    dep = c.src.get("deploy")
    if not dep:
        return
    amount = _f(dep.get("suggested"))
    if amount <= DEPLOY_MIN:
        return
    yield _new(
        "deploy:idle", category="allocation", severity="info", confidence="estimate",
        title=f"{_inr(amount)} is ready to invest",
        detail="Matured deposits, returned loan principal and idle cash add up to money with no plan yet.",
        why="Put it where your mix is short, by asset class; you choose the fund.",
        impact=_impact(amount, "allocation", label="{} ready to invest"), cta=deploy_cta(amount),
        link="/actions#deploy")


def _rules_risk(c: _Ctx):
    r = c.src.get("risk_est")
    if not r or r.get("vol_pct") is None or r.get("target_vol_pct") is None:
        return
    v, t = _f(r["vol_pct"]), _f(r["target_vol_pct"])
    if v <= t + RISK_WATCH_PTS:
        return
    prof = r.get("profile") or "chosen"
    yield _new(
        "risk:above-profile", category="risk", severity="crit" if v > t + RISK_ACT_PTS else "warn",
        confidence="estimate", title=f"Your mix swings more than your {prof} profile",
        detail=f"Estimated volatility is {v:.1f}% a year against a {t:.1f}% target.",
        why="Move new money toward steadier classes, or choose a profile that matches the mix you hold.",
        cta=_route("/risk", "Review risk & mix"), link="/risk")


def _rules_stress(c: _Ctx):
    stress, r = c.src.get("stress"), c.src.get("risk_est") or {}
    t = r.get("target_vol_pct")
    if not stress or t is None:
        return
    covid = next((s for s in stress.get("scenarios") or [] if s.get("key") == "covid"), None)
    if not covid or covid.get("impact_pct") is None:
        return
    ip, limit = _f(covid["impact_pct"]), STRESS_TOLERANCE * _f(t)
    if ip >= -limit:
        return
    total = _f(stress.get("total")) or c.total
    yield _new(
        "stress:beyond-tolerance", category="risk", severity="warn", confidence="model",
        title=f"A 2020-style crash would cut {abs(ip):.0f}% from your portfolio",
        detail=f"That is beyond the {limit:.0f}% your risk profile is built to take.",
        why="Check the stress test and decide whether the mix is right for you.",
        impact=_impact((abs(ip) - limit) / 100 * total, "risk", label="{} beyond tolerance"),
        cta=_route("/risk#stress", "See the stress test"), link="/risk#stress")


def _goal_view(g: dict) -> dict:
    pr = g.get("projection") or {}
    return {"id": g.get("id"), "name": g.get("name"), "status": pr.get("status", g.get("status")),
            "probability": pr.get("probability", g.get("probability")),
            "required_sip": pr.get("required_sip", g.get("required_sip")),
            "monthly_contribution": g.get("monthly_contribution"), "target_date": g.get("target_date"),
            "target_amount": g.get("target_amount")}


def _snap_data(snap: dict | None) -> dict:
    if not snap:
        return {}
    return snap.get("data") if isinstance(snap.get("data"), dict) else snap


def _goal_action(g: dict) -> dict | None:
    if g["status"] not in ("at_risk", "off_track"):
        return None
    extra = _f(g.get("required_sip")) - _f(g.get("monthly_contribution"))
    prob = g.get("probability")
    return _new(
        f"goal:{g['id']}", category="goals", severity="crit" if g["status"] == "off_track" else "warn",
        confidence="model", title=f"Goal '{g.get('name')}' is {g['status'].replace('_', ' ')}",
        detail=(f"{prob:.0f}% likely to reach {_inr(_f(g.get('target_amount')))}"
                + (f" by {g['target_date']}." if g.get("target_date") else ".")) if prob is not None else None,
        why=f"Raise the monthly contribution by about {_inr(extra)}." if extra > 0 else "Extend the date or adjust the target.",
        impact=_impact(extra if extra > 0 else None, "goals", "monthly"), due=_d(g.get("target_date")), kind="state",
        cta=_route(f"/plan?tab=goals#goal-{g['id']}", "Adjust the goal"), link=f"/plan?tab=goals#goal-{g['id']}")


def _rules_plan(c: _Ctx):
    plan = c.src.get("plan")
    if not plan:
        return
    goals = [_goal_view(g) for g in plan.get("goals") or []]
    for g in goals:
        a = _goal_action(g)
        if a:
            yield a
    ret = plan.get("retirement")
    if ret and ret.get("status") in ("at_risk", "off_track"):
        gap = _f(ret.get("required_sip")) - _f((ret.get("inputs") or {}).get("monthly_sip"))
        prob = ret.get("probability")
        yield _new(
            "retirement:gap", category="goals", severity="crit" if ret["status"] == "off_track" else "warn",
            confidence="model", title=f"Retirement is {ret['status'].replace('_', ' ')}",
            detail=f"{prob:.0f} of 100 simulated futures reach the corpus you need." if prob is not None else None,
            why=f"Invest about {_inr(gap)} more a month, or adjust the plan." if gap > 0 else "Adjust the plan.",
            impact=_impact(gap if gap > 0 else None, "goals", "monthly"),
            cta=_route("/plan?tab=retirement", "Open the retirement plan"), link="/plan?tab=retirement")
    snap = _snap_data(c.src.get("snapshot_then"))
    if not snap:
        return
    then_probs = {str(k): v for k, v in (snap.get("goal_probs") or {}).items()}
    for g in goals:
        then, now = then_probs.get(str(g["id"])), g.get("probability")
        if then is None or now is None or _f(then) - _f(now) < PROB_DROP_PTS:
            continue
        extra = _f(g.get("required_sip")) - _f(g.get("monthly_contribution"))
        yield _new(
            f"plan:probability-drop:{g['id']}", category="goals", severity="warn", confidence="model",
            title=f"Goal '{g.get('name')}' fell from {_f(then):.0f}% to {_f(now):.0f}% likely",
            detail="Its chance of success dropped by 10 points or more since the last snapshot.",
            impact=_impact(extra if extra > 0 else None, "goals", "monthly"),
            cta=_route("/plan", "Open the plan"), link="/plan")
    if ret and snap.get("retirement_probability") is not None and ret.get("probability") is not None:
        then, now = _f(snap["retirement_probability"]), _f(ret["probability"])
        if then - now >= PROB_DROP_PTS:
            gap = _f(ret.get("required_sip")) - _f((ret.get("inputs") or {}).get("monthly_sip"))
            yield _new(
                "plan:probability-drop:retirement", category="goals", severity="warn", confidence="model",
                title=f"Retirement fell from {then:.0f}% to {now:.0f}% likely",
                detail="Its chance of success dropped by 10 points or more since the last snapshot.",
                impact=_impact(gap if gap > 0 else None, "goals", "monthly"),
                cta=_route("/plan", "Open the plan"), link="/plan")


def _p2p_principal_covered(c: _Ctx) -> date | None:
    """The last day of repayments the user already closed a cash:p2p-principal action over (done or dismissed):
    those repayments are never raised again under another month's id."""
    out = None
    for (owner, aid), row in c.log.items():
        if owner != c.owner or not aid.startswith("cash:p2p-principal:") or row.get("status") not in ("done", "dismissed"):
            continue
        closed = _d(row.get("done_at")) or _d(row.get("updated_at")) or _d(row.get("first_seen"))
        if closed and (out is None or closed > out):
            out = closed
    return out


def _rules_p2p_principal(c: _Ctx):
    """cash:p2p-principal:<YYYY-MM>: at least ₹10k of P2P principal came back in the last 30 days. The id is the
    month of the earliest repayment counted, so the same money keeps its id across a month boundary; repayments
    covered by an action the user already closed are left out."""
    if c.port is None or "txns" not in c.src:
        return
    p2p_ids = {p["id"] for p in c.positions if p.get("asset_class") == d.P2P}
    start = c.today - timedelta(days=P2P_PRINCIPAL_WINDOW)
    covered = _p2p_principal_covered(c)
    if covered and covered > start:
        start = covered
    rows = [t for t in c.txns if t.get("type") == d.REPAYMENT and t.get("instrument_id") in p2p_ids
            and (dt := _d(t.get("date"))) and start < dt <= c.today]
    back = sum(_f(t["principal"]) if t.get("principal") is not None else _f(t.get("amount")) for t in rows)
    if back < P2P_PRINCIPAL_MIN:
        return
    since = min(_d(t["date"]) for t in rows)
    yield _new(
        f"cash:p2p-principal:{since.isoformat()[:7]}", category="cash", severity="info", confidence="fact",
        title=f"{_inr(back)} of P2P principal came back",
        detail="Repaid loan principal from the last 30 days is sitting with no plan.",
        why="Decide whether to lend it again or move it where your mix is short.",
        impact=_impact(back, "cash"), cta=deploy_cta(back), link="/cash-flows?view=past",
        meta={"since": since.isoformat()}, expires=since + timedelta(days=REDEPLOY_DAYS))


# ── insights → actions ──

def _missing_priced(c: _Ctx) -> tuple[float, float]:
    """(Σ cost, Σ value) of open market-priced positions that have no live price."""
    rows = [p for p in c.positions if p.get("is_open") and p.get("asset_class") in d.TRADABLE and not p.get("has_price")]
    return sum(_f(p.get("cost")) for p in rows), sum(_f(p.get("value")) for p in rows)


def _from_insight(ins: dict, c: _Ctx) -> dict | None:
    """Map one insight to an action per §8.3 and §1.7: category, severity, confidence, impact, CTA and link."""
    iid, amt = ins.get("id") or "", ins.get("amount")
    title, detail, why, ilink = ins.get("title"), ins.get("detail"), ins.get("action"), ins.get("link")
    sev, cat = ins.get("severity") or "info", ins.get("category") or "review"
    tail = iid.split(":")[-1]
    iid_int = int(tail) if tail.isdigit() else None

    def mk(id_=iid, *, category=cat, severity=SEVERITY_OF_INSIGHT.get(sev, "info"), confidence="fact", impact=None, link=ilink, cta=None,
           cta_label="Open", due=None, kind=None, instrument_id=None, meta=None, expires=None):
        return _new(id_, category=category, severity=severity, confidence=confidence, title=title, detail=detail,
                    why=why, impact=impact, due=due, kind=kind, instrument_id=instrument_id, meta=meta,
                    cta=cta or (_route(link, cta_label) if link else None), link=link, expires=expires)

    if iid == "empty":
        return None   # brief.py emits onboard:* for an empty ledger
    if iid == "data:missing-prices":
        cost, value = _missing_priced(c)
        crit = c.total > 0 and value / c.total * 100 >= UNPRICED_CRIT_PCT
        return mk(category="data", severity="crit" if crit else "warn",
                  impact=_impact(cost, "data"), link="/settings#prices", cta_label="Add tickers")
    if iid == "data:stale-prices":
        return mk(category="data", severity="warn", link=ilink or "/",
                  cta={"label": "Refresh prices", "type": "api", "api": "prices_refresh"})
    if iid.startswith("nps:nav-stale:"):
        p = c.pos.get(iid_int) or {}
        return mk(category="data", severity="info", impact=_impact(p.get("value") or amt, "data", label="{} on an old NAV"),
                  link="/nps", cta_label="Update the NAV", instrument_id=iid_int)
    if iid == "p2p:defaulted":
        return mk(category="p2p", severity="crit", impact=_impact(amt, "p2p"), link="/p2p?tab=defaulted",
                  cta_label="See defaulted loans")
    if iid == "p2p:overdue":
        if c.port is not None:
            amount = sum(_f(p.get("outstanding")) for p in c.positions
                         if p.get("asset_class") == d.P2P and _f(p.get("overdue_days")) > 30)
        else:
            amount = amt
        return mk(category="p2p", severity="warn", impact=_impact(amount, "p2p"), link="/p2p?tab=overdue",
                  cta_label="See overdue loans")
    if iid == "p2p:yield":
        return mk(category="p2p", severity="info", confidence="estimate", link="/p2p", cta_label="Open P2P")
    if iid.startswith("fd:maturing:"):
        p = c.pos.get(iid_int) or {}
        due = _d(p.get("maturity_date"))
        a = _fd_maturing(c, iid_int, due, p.get("maturity_value") or amt, p.get("name"))
        a.update(title=title or a["title"], detail=detail or a["detail"], why=why or a["why"])
        return a
    if iid == "cash:usd":
        return mk(category="cash", severity="info", impact=_impact(amt, "cash"), link=ilink or "/forex",
                  cta=deploy_cta(amt, "Deploy"))   # SPEC §5.7: the USD wallet's strip button reads "Deploy"
    if iid.startswith("drift:"):
        return mk(category="allocation", confidence="estimate", impact=_impact(amt, "allocation"),
                  link=ilink or "/risk#rebalance", cta_label="Plan the rebalance")
    if iid == "targets:missing":
        return mk(category="allocation", severity="info", link=ilink or "/risk#mix", cta_label="Set targets")
    if iid.startswith("concentration:"):
        p = c.pos.get(iid_int) or {}
        w = _f(p.get("weight"))
        limit = 25 if p.get("asset_class") == d.MUTUAL_FUND else 15
        over = (w - 10) / 100 * c.total if w > 10 and c.total else None
        return mk(category="risk", severity="warn" if w >= limit else "info", impact=_impact(over, "risk"),
                  link=ilink or f"/holding/{iid_int}", instrument_id=iid_int, cta_label="Open the holding")
    if iid.startswith("sector:"):
        eq = sum(_f(p.get("value")) for p in c.positions if p.get("is_open") and p.get("asset_class") == d.EQUITY)
        over = (_f(amt) - 0.30 * eq) if eq and amt else None
        return mk(category="risk", severity="warn", impact=_impact(over, "risk", label="{} above 30%"),
                  link=ilink or "/risk#concentration", cta_label="See concentration")
    if iid == "diversification:stocks":
        return mk(category="risk", severity="info", link="/holdings/equity", cta_label="See your stocks")
    if iid in ("tax:ltcg-harvest", "tax:loss-harvest"):
        fy = d.fy_of(c.today.isoformat())
        due = _fy_end(fy)
        if iid == "tax:ltcg-harvest":
            due = _last_weekday_on_or_before(due)
            impact = _impact(_f(amt) * 0.125 if amt else None, "tax")
        else:
            impact = None   # the top slab rate needs the tax lines; the tax source supplies them
        return mk(action_id_for_insight(iid, c.today), category="tax", confidence="estimate", impact=impact,
                  link="/tax?tab=save", cta_label="See the plan", due=due, kind="event", meta={"fy": fy}, expires=due)
    if iid.startswith("tax:wait-lt:"):
        parts = iid.split(":")
        inst = int(parts[2]) if parts[2].isdigit() else None
        return mk(category="tax", severity="info", confidence="estimate", impact=_impact(amt, "tax"),
                  link=f"/tax?tab=whatif&whatif={inst}" if inst is not None else "/tax?tab=whatif",
                  cta_label="What if I sell now?", instrument_id=inst)
    if iid.startswith("elss:unlocked:"):
        return mk(category="tax", severity="info", impact=_impact(amt, "tax", label="{} unlocked"),
                  link=ilink or f"/holding/{iid_int}", instrument_id=iid_int, cta_label="Open the holding")
    if iid.startswith("sip:missed:"):
        sid = iid.split(":")[2]
        plan = c.sip(sid) or {"id": sid}
        due = _sip_due(plan, c.today)
        amount = _f(amt) or _f(plan.get("amount"))
        a = _sip_action(c, "missed", plan.get("id", sid), due, amount, plan, plan.get("name"))
        a.update(title=title or a["title"])
        return a
    if iid.startswith("sip:gap:"):
        return mk(category="habit", severity="info", link=ilink or f"/holding/{iid_int}", instrument_id=iid_int,
                  cta_label="Open the holding")
    if iid.startswith("goal:"):
        # the insight says warning for off_track and info for at_risk; §8.3 says crit and warn
        g = {"id": iid.split(":", 1)[1], "name": None, "status": "off_track" if sev in ("warning", "critical") else "at_risk",
             "probability": None, "required_sip": amt, "monthly_contribution": 0}
        a = _goal_action(g)
        a.update(title=title, detail=detail, why=why)
        return a
    if iid == "review:due":
        qkey, qend = _quarter(c.today)
        return mk(f"review:due:{qkey}", category="review", severity="info", due=qend, kind="event",
                  link=ilink or "/actions?tab=review",
                  cta={"label": "Mark review done", "type": "api", "api": "review_complete"}, expires=qend)
    if iid.startswith(("loser:", "winner:")):
        return mk(category="performance", severity="info", link=ilink or f"/holding/{iid_int}", instrument_id=iid_int,
                  cta_label="Open the holding")
    if iid.startswith("perf:"):
        return mk(category="performance", severity="pos" if sev == "positive" else "warn",
                  link=ilink or "/performance", cta_label="See performance")
    # an id this catalogue does not know yet: keep the insight's own terms
    return mk(impact=_impact(amt, cat), link=ilink, instrument_id=iid_int if ":" in iid else None)


def _rules_insights(c: _Ctx, taken: set[str]):
    adherence_on = bool(c.src.get("adherence"))
    tax_on = bool((c.src.get("tax") or {}).get("opportunities"))
    plan_goals_on = bool((c.src.get("plan") or {}).get("goals"))
    for ins in c.src.get("insights") or []:
        iid = ins.get("id") or ""
        if iid.startswith("sip:missed:") and adherence_on:
            continue   # A9: the plans rule is the only source once adherence exists
        if iid.startswith("tax:") and tax_on:
            continue   # the tax source carries the real thresholds (A12) and rates
        if iid.startswith("goal:") and plan_goals_on:
            continue
        if action_id_for_insight(iid, c.today, c.src.get("sips")) in taken:
            continue
        a = _from_insight(ins, c)
        if a:
            yield a


# ── ranking, admission and budgets ──

def _urgency(days: int | None) -> float:
    if days is None:
        return 0.25
    if days <= 3:
        return 1.0
    if days <= 7:
        return 0.85
    if days <= 14:
        return 0.7
    if days <= 31:
        return 0.5
    if days <= 90:
        return 0.3
    return 0.25


def _score_amount(a: dict) -> float:
    imp = a.get("impact") or {}
    amount = _f(imp.get("amount"))
    return amount * 12 if imp.get("kind") == "monthly" else amount


def score(a: dict) -> float:
    """§8.2: max(amount, 1000) × U(days) × C(confidence); a monthly impact counts at its 12-month amount."""
    return round(max(_score_amount(a), IMPACT_FLOOR) * _urgency(a.get("days")) * CONFIDENCE.get(a.get("confidence"), 0.3), 2)


def _data_act(vitals) -> bool:
    if not vitals:
        return False
    if isinstance(vitals, dict):
        v = vitals.get("data")
        return (v.get("status") if isinstance(v, dict) else v) == "act"
    return any(v.get("key") == "data" and v.get("status") == "act" for v in vitals)


def tier_of(a: dict, data_act: bool = False) -> str:
    """§1.7.1: now = critical, 0 ≤ days ≤ 7, a data action while the Data vital is act, or a late plan;
    month = warning or days ≤ 31; consider = info; good = positive."""
    if a.get("days_late"):
        return "now"
    sev, days = a.get("severity"), a.get("days")
    if sev == "pos":
        return "good"
    if sev == "crit" or (days is not None and 0 <= days <= 7) or (data_act and a.get("category") == "data"):
        return "now"
    if sev == "warn" or (days is not None and days <= 31):
        return "month"
    return "consider"


def rank(actions: list[dict], vitals=None) -> list[dict]:
    """Assign tier and score, then sort by tier, score descending, then id. `vitals` is the brief's list
    (A23) or a {key: status} dict; only the Data vital matters here. Returns new dicts."""
    data_act = _data_act(vitals)
    out = []
    for a in actions:
        a = dict(a)
        a["tier"] = tier_of(a, data_act)
        a["score"] = score(a)
        out.append(a)
    out.sort(key=lambda a: (TIER_ORDER[a["tier"]], -a["score"], a["id"]))
    return out


def diversify(actions: list[dict], k: int = 3) -> list[dict]:
    """§1.5: at most one action per category, and at most one data action unless it is critical."""
    out, cats = [], set()
    for a in actions:
        if len(out) >= k:
            break
        cat = a.get("category")
        if cat in cats and not (cat == "data" and a.get("severity") == "crit"):
            continue
        out.append(a)
        cats.add(cat)
    return out


def admitted(a: dict, total_value: float, data_status: str | None = None) -> bool:
    """§1.4: watch/act (tier now or month), and real ₹ ≥ max(₹1,000, 0.25% of value), a deadline within 30 days,
    a plan at risk, or a data action while the Data vital is act."""
    if a.get("status") not in OPEN_STATUSES or a.get("severity") == "pos":
        return False
    if a.get("tier") not in ("now", "month"):
        return False
    if data_status == "act" and a.get("category") == "data":
        return True
    if _score_amount(a) >= max(IMPACT_FLOOR, HOME_SHARE * _f(total_value)):
        return True
    if a.get("days") is not None and a["days"] <= HOME_DAYS:
        return True
    return a.get("category") == "goals"


def for_home(actions: list[dict], total_value: float, data_status: str | None = None, k: int = 5) -> list[dict]:
    """The Home list: §1.4 admission over the ranked actions, then `diversify(k)`."""
    ranked = rank(actions, [{"key": "data", "status": data_status}]) if data_status == "act" else actions
    return diversify([a for a in ranked if admitted(a, total_value, data_status)], k)


def is_tax_move(a: dict) -> bool:
    """A tax action whose impact is tax saved (est.): the `tax:*` ids. ELSS unlocks are not."""
    return a.get("category") == "tax" and str(a.get("id") or "").startswith("tax:")


def summary(actions: list[dict]) -> dict:
    """Counts per tier over open and planned actions, and ₹ at stake: Σ lump impacts of now + month (§1.7).

    Over the same visible actions (not just the Home five) it also counts `new` (is_new: not in the last snapshot,
    for the hero's 'N new') and `tax_open` (open tax moves, which gate the FY-window context line, §4.1, and the
    Tax nav badge). Only `tax:*` ids are tax moves: `elss:unlocked:*` sits in the tax category but its impact is
    principal that has unlocked, not tax saved."""
    out = {t: 0 for t in TIERS}
    total = 0.0
    new = tax_open = 0
    for a in actions:
        if a.get("status") not in OPEN_STATUSES or a.get("tier") not in out:
            continue
        out[a["tier"]] += 1
        new += bool(a.get("is_new"))
        tax_open += is_tax_move(a)
        imp = a.get("impact") or {}
        if a["tier"] in ("now", "month") and imp.get("kind") == "lump":
            total += _f(imp.get("amount"))
    out["impact_total"] = round(total, 2)
    out["new"] = new
    out["tax_open"] = tax_open
    return out


# ── close rules ──

def _buys(txns: list[dict], since: date, until: date, *, exclude: set | None = None, only: set | None = None,
          skip_classes: set | None = None, classes: dict | None = None) -> list[dict]:
    out = []
    for t in txns or []:
        if t.get("type") != d.BUY:
            continue
        dt = _d(t.get("date"))
        if dt is None or not (since <= dt <= until):
            continue
        iid = t.get("instrument_id")
        if exclude and iid in exclude:
            continue
        if only is not None and iid not in only:
            continue
        if skip_classes and classes and classes.get(iid) in skip_classes:
            continue
        out.append(t)
    return out


def _evidence(rows: list[dict], today: date) -> dict:
    return {"txn_ids": [t.get("id") for t in rows if t.get("id") is not None],
            "amount": round(sum(_f(t.get("amount")) for t in rows), 2), "date": today.isoformat()}


def _redeployed(txns, since: date, today: date, target: float, exclude: set, classes: dict) -> dict | None:
    """BUYs from `since` for up to 45 days (EPF payroll contributions aside) summing to ≥ 80% of `target`."""
    if target <= 0 or today < since:
        return None
    rows = _buys(txns, since, min(today, since + timedelta(days=REDEPLOY_DAYS)), exclude=exclude,
                 skip_classes={d.EPF}, classes=classes)
    if sum(_f(t.get("amount")) for t in rows) >= REDEPLOY_SHARE * target:
        return _evidence(rows, today)
    return None


def auto_done(action: dict, txns: list[dict] | None, port: dict | None, tax: dict | None, today: date | None = None,
              *, adherence: dict | None = None, settings: dict | None = None, sips: list[dict] | None = None) -> dict | None:
    """The evidence that closes `action` per §8.3 'Closes when' and P1.10, or None.

    * sip:missed / sip:due: the plans engine says done or skipped, or BUYs in [due − 3, due + 20] on the plan's
      instrument (or segment) sum to ≥ 80% of the instalment.
    * fd:maturing: BUYs on anything but this FD (a new FD counts; EPF payroll does not), dated from maturity − 3
      for 45 days, sum to ≥ 80% of the maturity value.
    * cash:p2p-principal: BUYs within 45 days of the principal coming back sum to ≥ 80% of it.
    * fd:matured-unrecorded: a MATURITY row exists.
    * tax:ltcg-harvest: remaining_exemption < HARVEST_FLOOR (A12). tax:loss-harvest: offsettable fell ≥ 80%.
    * data:missing-prices: nothing is missing. p2p:defaulted / p2p:overdue: nothing at risk / overdue.
      cash:usd: the wallet holds under $50. review:due: lastReviewDate falls inside the quarter.

    Evidence is {txn_ids, amount, date} for ledger evidence, or {condition, date, ...} for a cleared state.
    """
    today = today or date.today()
    aid = action.get("id") or ""
    meta = action.get("meta") or {}
    positions = (port or {}).get("positions") or []
    classes = {p["id"]: p.get("asset_class") for p in positions if p.get("id") is not None}
    impact = _f((action.get("impact") or {}).get("amount"))
    due = _d(action.get("due"))

    def cleared(condition: str, **extra) -> dict:
        return {"condition": condition, "date": today.isoformat(), **extra}

    if aid.startswith(("sip:missed:", "sip:due:")):
        parts = aid.split(":")
        sid, due = parts[2], _d(parts[3]) if len(parts) > 3 else due
        if due is None:
            return None
        for plan_row in (adherence or {}).get("plans") or []:
            if str(plan_row.get("id")) != sid:
                continue
            for m in plan_row.get("months") or []:
                if m.get("due") == due.isoformat() and m.get("status") in ("done", "skipped"):
                    return cleared(f"instalment {m['status']}")
        plan = next((s for s in sips or [] if str(s.get("id")) == sid), {})
        inst = action.get("instrument_id") or plan.get("instrument_id")
        amount = _f(meta.get("amount")) or impact or _f(plan.get("amount"))
        if amount <= 0:
            return None
        if inst:
            only = {inst}
        else:
            seg = meta.get("segment") or plan.get("segment")
            only = {p["id"] for p in positions if seg and p.get("segment") == seg}
        rows = _buys(txns, due - timedelta(days=SIP_WINDOW_BEFORE), due + timedelta(days=SIP_WINDOW_AFTER), only=only)
        if sum(_f(t.get("amount")) for t in rows) >= SIP_MATCH_SHARE * amount:
            return _evidence(rows, today)
        return None
    if aid.startswith("fd:maturing:"):
        if due is None:
            return None
        target = _f(meta.get("maturity_value")) or impact
        return _redeployed(txns, due - timedelta(days=3), today, target, {action.get("instrument_id")}, classes)
    if aid.startswith("cash:p2p-principal:"):
        since = _d(meta.get("since")) or (_d(action.get("first_seen")) or today) - timedelta(days=P2P_PRINCIPAL_WINDOW)
        return _redeployed(txns, since, today, impact, set(), classes)
    if aid.startswith("fd:matured-unrecorded:"):
        iid = action.get("instrument_id")
        rows = [t for t in txns or [] if t.get("instrument_id") == iid and t.get("type") == d.MATURITY]
        return _evidence(rows, today) if rows else None
    if aid.startswith("tax:ltcg-harvest:"):
        if not tax or (tax.get("fy") and tax["fy"] != aid.split(":", 2)[2]):
            return None
        rem = ((tax.get("opportunities") or {}).get("ltcg_harvest") or {}).get("remaining_exemption")
        if rem is not None and _f(rem) < HARVEST_FLOOR:
            return cleared("exemption used", remaining_exemption=round(_f(rem), 2))
        return None
    if aid.startswith("tax:loss-harvest:"):
        if not tax or (tax.get("fy") and tax["fy"] != aid.split(":", 2)[2]):
            return None
        # the basis is the offsettable when the action was first seen: given directly, or recovered from the
        # impact stored at first sight (impact = loss_harvest_saving(offsettable), inverted over today's lines)
        basis = _f(meta.get("first_offsettable"))
        if basis <= 0:
            first_impact = _f(meta.get("first_impact")) or impact
            basis = _offset_for_saving(tax, first_impact) if first_impact else 0.0
        now = (tax.get("opportunities") or {}).get("loss_harvest_offsettable")
        if basis > 0 and now is not None and _f(now) <= LOSS_HARVEST_DONE_SHARE * basis:
            return cleared("losses harvested", offsettable=round(_f(now), 2))
        if basis <= 0 and now is not None and _f(now) <= LOSS_HARVEST_MIN:
            # A full harvest cancels every taxable gain, so no tax line is left to recover the rate from. The
            # offsettable is gone: credit it when losses were booked since the action was first seen (losers that
            # simply recovered leave no such sale, and the action expires).
            since = _d(action.get("first_seen")) or date.fromisoformat(d.fy_bounds(aid.split(":", 2)[2])[0])
            lots = [r for r in (port or {}).get("realized_lots") or []
                    if _f(r.get("gain")) < 0 and (_d(r.get("sell_date")) or date.min) >= since]
            if lots:
                return cleared("losses harvested", offsettable=round(_f(now), 2),
                               booked_loss=round(-sum(_f(r.get("gain")) for r in lots), 2))
        return None
    if aid == "data:missing-prices":
        if port is not None and not (port.get("totals") or {}).get("missing_prices"):
            return cleared("every holding is priced")
        return None
    if aid == "p2p:defaulted":
        if port is not None and sum(_f(p.get("at_risk")) for p in positions if p.get("asset_class") == d.P2P) <= 0:
            return cleared("nothing at risk")
        return None
    if aid == "p2p:overdue":
        if port is not None and not any(_f(p.get("overdue_days")) > 7 for p in positions if p.get("asset_class") == d.P2P):
            return cleared("nothing overdue")
        return None
    if aid == "cash:usd":
        if port is not None and all(_f(p.get("balance_usd")) < USD_MIN for p in positions if p.get("asset_class") == d.CASH):
            return cleared("wallet invested")
        return None
    if aid.startswith("review:due:"):
        last = _d((settings or {}).get("lastReviewDate"))
        if last:
            y, q = aid.split(":")[2].split("-Q")
            if last.year == int(y) and (last.month - 1) // 3 + 1 == int(q):
                return cleared("review recorded", last_review=last.isoformat())
        return None
    return None


# ── the log overlay ──

def _log_row(log: dict, owner: str | None, aid: str, today: date) -> dict | None:
    row = log.get((owner, aid))
    if row is not None:
        return row
    old = legacy_id(aid)
    if old:
        row = log.get((owner, old))
        # A8: a migrated period-free row counts only while it is a live snooze
        if row and row.get("status") == "snoozed" and (_d(row.get("snooze_until")) or date.min) >= today:
            return row
    return None


def _skipped_sibling(log: dict, owner: str | None, aid: str) -> bool:
    """A11: a dismissed 'skipped' row on sip:due:<sid>:<due> or sip:missed:<sid>:<due> covers both."""
    for a, b in (("sip:due:", "sip:missed:"), ("sip:missed:", "sip:due:")):
        if aid.startswith(a):
            row = log.get((owner, b + aid[len(a):]))
            return bool(row and row.get("status") == "dismissed" and row.get("reason") == "skipped")
    return False


def _parse_iid(aid: str) -> int | None:
    parts = aid.split(":")
    for prefix in ("fd:maturing", "fd:matured-unrecorded", "concentration", "elss:unlocked", "sip:gap", "loser",
                   "winner", "nps:nav-stale"):
        n = prefix.count(":") + 1
        if ":".join(parts[:n]) == prefix and len(parts) > n and parts[n].isdigit():
            return int(parts[n])
    if aid.startswith("tax:wait-lt:") and len(parts) > 2 and parts[2].isdigit():
        return int(parts[2])
    return None


def _source_present(aid: str, src: ActionSources) -> bool:
    """Whether the rule that emits `aid` ran in this build (a stale row is closed only then)."""
    has = lambda k: src.get(k) is not None  # noqa: E731
    if aid.startswith(("fd:maturing:", "fd:matured-unrecorded:")):
        return has("port")
    if aid.startswith("cash:p2p-principal:"):
        return has("port") and has("txns")
    if aid == "deploy:idle":
        return has("deploy")
    if aid == "cushion:low":
        return has("cushion")
    if aid == "risk:above-profile":
        return has("risk_est")
    if aid.startswith("stress:"):
        return has("stress") and has("risk_est")
    if aid.startswith("tax:"):
        return has("tax") or (has("insights") and not aid.startswith("tax:wait-lt:"))
    if aid.startswith(("sip:missed:", "sip:due:")):
        return bool(src.get("adherence")) or (aid.startswith("sip:missed:") and has("insights"))
    if aid.startswith("sip:ended:"):
        return has("sips")
    if aid.startswith("goal:"):
        return has("plan") or has("insights")
    if aid.startswith(("retirement:", "plan:")):
        return has("plan")
    if aid.startswith(("onboard:", "notice:", "market:", "data:import-due:")):
        return False
    return has("insights") and aid.startswith(ACTION_PREFIXES)


def _stale_action(row: dict, c: _Ctx) -> dict:
    """An action rebuilt from a log row whose rule no longer fires, so its close rule can be checked."""
    aid = row["id"]
    meta: dict = {}
    inst = _parse_iid(aid)
    if aid.startswith(("sip:missed:", "sip:due:", "sip:ended:")):
        sid = aid.split(":")[2]
        plan = c.sip(sid) or {}
        meta = {"sip_id": plan.get("id", sid), "segment": plan.get("segment"), "amount": row.get("impact")}
        inst = plan.get("instrument_id")
    kind = row.get("impact_kind") or "lump"
    impact = {"amount": _f(row["impact"]), "kind": kind, "label": None} if row.get("impact") else None
    due = _d(row.get("due"))
    a = _new(aid, category=row.get("category") or aid.split(":")[0], severity="info", confidence="fact",
             title=row.get("title") or aid, cta=None, link=None, impact=impact, due=due, instrument_id=inst, meta=meta)
    a.pop("_expires", None)
    a.update(first_seen=row.get("first_seen"), days=(due - c.today).days if due else None,
             planned_for=row.get("planned_for"), snooze_until=row.get("snooze_until"))
    return a


def action_from_row(row: dict, src: ActionSources | None = None, today: date | None = None) -> dict:
    """An action-log row in the Action shape (E5), for the Actions page's Done and Snoozed lists.

    The public form of ``_stale_action`` plus the row's own ``status``, ``done_at``, ``done_via``, ``evidence``,
    ``reason`` and ``note``. ``tier`` is the row's ``tier_first``, or ``consider`` when it was never seen ranked;
    ``owner`` is the row's owner. ``src`` (optional) lets an SIP id find its plan and instrument; ``today`` sets
    ``days``. The title is the one first seen (or the id), and there is no CTA: these rows are history."""
    c = _Ctx(src or {}, today or date.today())
    a = _stale_action({**row, "id": row.get("id") or ""}, c)
    a.update(status=row.get("status") or "open", tier=row.get("tier_first") or "consider", owner=row.get("owner"),
             done_at=row.get("done_at"), done_via=row.get("done_via"), evidence=row.get("evidence"),
             reason=row.get("reason"), note=row.get("note"))
    return a


def _stale_in_scope(owner: str | None, aid: str, c: _Ctx) -> bool:
    """Whether this build is the one that would raise `aid` for `owner`: the instrument (or plan) is in scope and
    belongs to that owner, or the action is the settings owner's. Rows of other scopes are never closed here."""
    if aid.startswith(("sip:missed:", "sip:due:", "sip:ended:")):
        plan = c.sip(aid.split(":")[2])
        if not plan:
            return False
        return c.owner_of({"meta": {"sip_id": plan["id"]}, "instrument_id": plan.get("instrument_id")}) == owner
    iid = _parse_iid(aid)
    if iid is not None:
        p = c.pos.get(iid)
        return bool(p) and p.get("owner") == owner
    return owner == c.owner


def _activity_evidence(a: dict, c: _Ctx) -> dict | None:
    """Why a mix action (drift, concentration, risk above profile) stopped firing, when the user caused it (§8.4,
    A24): the risk profile named at first sight is no longer the one set, or BUY/SELL rows (EPF payroll aside)
    since first sight. Read only once the rule has stopped firing; with neither, a price move did it and the
    action expires."""
    today = c.today
    if a["id"] == "risk:above-profile":
        prof = (c.src.get("risk_est") or {}).get("profile") or c.settings.get("riskProfile")
        title = a.get("title") or ""
        if prof and title.startswith("Your mix swings more than your ") and f" {prof} profile" not in title:
            return {"condition": "risk profile changed", "date": today.isoformat(), "profile": prof}
    first = _d(a.get("first_seen"))
    if first is None or "txns" not in c.src:
        return None
    classes = {iid: p.get("asset_class") for iid, p in c.pos.items()}
    rows = [t for t in c.txns if t.get("type") in (d.BUY, d.SELL) and classes.get(t.get("instrument_id")) != d.EPF
            and (dt := _d(t.get("date"))) and first <= dt <= today]
    return _evidence(rows, today) if rows else None


def _closure(a: dict, status: str, evidence: dict | None, today: date) -> dict:
    a = dict(a)
    a.update(status=status, evidence=evidence, done_via="auto" if status == "done" else None,
             done_at=today.isoformat() if status == "done" else None)
    return a


def build_actions(src: ActionSources | None, log: dict | None = None, today: date | None = None, *,
                  include_closed: bool = False, vitals=None) -> list[dict]:
    """Every action the sources raise, overlaid with the action log, ranked (§8.1–§8.4).

    `log` is {(owner, id): row} as ``Ledger.action_log`` returns it. Overlay (§8.4, A8, A11):
    * done and dismissed rows hide the action. An auto-done *state* action that fires again reopens, because its
      condition came back (a manual done stays hidden);
    * a snoozed row hides it while snooze_until ≥ today and reopens it after;
    * a planned row keeps it visible; planned_for < today ranks it `now` with `days_late`;
    * an expired row reopens when the rule fires again (expired is computed, not a decision);
    * without a row for (owner, id), the legacy period-free id is honoured only as a live snooze (A8);
    * a dismissed 'skipped' row on either SIP id of an instalment hides both (A11).
    Close rules (``auto_done``) and event windows run on read: an action with evidence is done (auto), an event
    whose window passed is expired, and neither is visible.

    With `include_closed=True` the closed ones follow the visible list with status 'done' or 'expired' (plus
    evidence, done_via and done_at), and so do open, planned or lapsed-snooze log rows whose rule ran but no
    longer fires (done with evidence, else expired), and expired rows that now have evidence (done), so the
    caller can persist the transitions with ``upsert_action_seen``.
    """
    today = today or date.today()
    src = src or {}
    log = log or {}
    c = _Ctx(src, today)
    c.log = log

    fired: dict[str, dict] = {}
    fd_keys: set[tuple] = set()

    def take(a: dict | None):
        if not a or a["id"] in fired:
            return
        if a["id"].startswith("fd:maturing:"):
            key = (a["instrument_id"], a["due"])
            if key in fd_keys:
                return
            fd_keys.add(key)
        fired[a["id"]] = a

    for rule in (_rules_port, _rules_cashflow, _rules_adherence, _rules_sips, _rules_tax, _rules_cushion,
                 _rules_deploy, _rules_risk, _rules_stress, _rules_plan, _rules_p2p_principal):
        for a in rule(c):
            take(a)
    for a in _rules_insights(c, set(fired)):
        take(a)

    then_ids = set(_snap_data(src.get("snapshot_then")).get("action_ids") or [])
    has_snapshot = bool(src.get("snapshot_then"))
    visible, closed = [], []
    seen_keys: set[tuple] = set()
    for a in fired.values():
        a["owner"] = c.owner_of(a)
        due = _d(a["due"])
        a["days"] = (due - today).days if due else None
        a["is_new"] = has_snapshot and a["id"] not in then_ids
        expires = a.pop("_expires", None)
        seen_keys.add((a["owner"], a["id"]))
        row = _log_row(log, a["owner"], a["id"], today)
        if row:
            a["first_seen"] = row.get("first_seen")
            if row.get("impact") is not None:
                a["meta"]["first_impact"] = _f(row["impact"])
        status = (row or {}).get("status") or "open"
        if status == "dismissed" or (status == "done" and not (row.get("done_via") == "auto" and a["kind"] == "state")):
            continue
        if _skipped_sibling(log, a["owner"], a["id"]):
            continue
        if status == "snoozed" and (_d(row.get("snooze_until")) or date.min) >= today:
            continue
        ev = auto_done(a, c.txns, c.port, src.get("tax"), today, adherence=src.get("adherence"),
                       settings=c.settings, sips=src.get("sips"))
        if ev is not None:
            closed.append(_closure(a, "done", ev, today))
            continue
        if expires and today > expires:
            closed.append(_closure(a, "expired", None, today))
            continue
        a["status"] = "planned" if status == "planned" else "open"
        if row:
            a["snooze_until"] = row.get("snooze_until")
            if status == "planned":
                a["planned_for"] = row.get("planned_for")
                pf = _d(row.get("planned_for"))
                if pf and pf < today:
                    a["days_late"] = (today - pf).days
        visible.append(a)

    out = rank(visible, vitals)
    if not include_closed:
        return out
    for (owner, aid), row in log.items():
        st = row.get("status")
        lapsed = st == "snoozed" and (_d(row.get("snooze_until")) or date.min) < today
        if (owner, aid) in seen_keys or not (st in OPEN_STATUSES or lapsed or st == "expired"):
            continue
        if not _source_present(aid, src) or not _stale_in_scope(owner, aid, c):
            continue
        a = _stale_action({**row, "id": aid}, c)
        a["owner"] = owner
        ev = auto_done(a, c.txns, c.port, src.get("tax"), today, adherence=src.get("adherence"),
                       settings=c.settings, sips=src.get("sips"))
        if st == "expired":
            # already closed: only fresh evidence moves it (to done); it is never re-expired
            if ev is not None:
                closed.append(_closure(a, "done", ev, today))
            continue
        if ev is None and aid.startswith(CLEARED_IS_DONE):
            ev = {"condition": "cleared", "date": today.isoformat()}
        if ev is None and aid.startswith(ACTIVITY_IS_DONE):
            ev = _activity_evidence(a, c)
        closed.append(_closure(a, "done" if ev is not None else "expired", ev, today))
    return out + rank(closed, vitals)


# ── follow-through ──

def _sold_instead_of_waiting(row: dict) -> bool:
    """A tax:wait-lt row marked done with transaction evidence: the user sold before the lot turned long-term,
    the opposite of "Hold N more days", so its tax saving was not realised (W4 review). The advice is followed
    when the lot clears (CLEARED_IS_DONE), which leaves no txn_ids."""
    ev = row.get("evidence")
    return (str(row.get("id") or "").startswith("tax:wait-lt:")
            and isinstance(ev, dict) and bool(ev.get("txn_ids")))


def follow_through(log: dict | list | None, adherence: dict | None, today: date | None = None) -> dict:
    """§8.5 over the action log ({(owner, id): row} or a list of rows).

    * acted_90d: rows first seen in the last 90 days whose first tier was now or month: done / (done + expired).
      Dismissed, open, planned and snoozed rows are left out, and so is a tax:wait-lt row done by a sale
      (`_sold_instead_of_waiting`: the user did the opposite of "Hold N more days").
    * on_time_pct: of those done, the share done by the due date (undated: within 14 days of first sight).
    * impact_realised_fy: Σ impact of done tax actions (est.) + Σ evidence BUY amounts of done fd and cash actions,
      done in the current FY. A tax:wait-lt row done by a sale adds nothing: the saving was given up.
    * sip_adherence_12m: `adherence_6m_pct` of a 12-month sip_adherence run, as handed in.
    * median_days_to_act: median of done_at − first_seen over the done rows in the window.
    """
    today = today or date.today()
    rows = list(log.values()) if isinstance(log, dict) else list(log or [])
    since = today - timedelta(days=90)
    cohort = [r for r in rows if r.get("tier_first") in ("now", "month")
              and (_d(r.get("first_seen")) or date.min) >= since and not _sold_instead_of_waiting(r)]
    done = [r for r in cohort if r.get("status") == "done"]
    expired = [r for r in cohort if r.get("status") == "expired"]
    total = len(done) + len(expired)

    on_time = 0
    lags = []
    for r in done:
        at, first = _d(r.get("done_at")), _d(r.get("first_seen"))
        due = _d(r.get("due"))
        if at and (due and at <= due or not due and first and (at - first).days <= 14):
            on_time += 1
        if at and first:
            lags.append((at - first).days)

    fy_start, fy_end = (date.fromisoformat(x) for x in d.fy_bounds(d.fy_of(today.isoformat())))
    realised = 0.0
    for r in rows:
        at = _d(r.get("done_at"))
        if r.get("status") != "done" or not at or not (fy_start <= at <= fy_end) or r.get("tier_first") is None:
            continue
        cat = r.get("category") or ""
        if cat == "tax" or (r.get("id") or "").startswith("tax:"):
            if _sold_instead_of_waiting(r):
                continue
            realised += _f(r.get("impact"))
        elif cat in ("fd", "cash") or (r.get("id") or "").startswith(("fd:", "cash:")):
            ev = r.get("evidence") or {}
            realised += _f(ev.get("amount")) if isinstance(ev, dict) else 0.0

    return {
        "acted_90d": {"done": len(done), "total": total, "pct": round(len(done) / total * 100, 1) if total else None},
        "on_time_pct": round(on_time / len(done) * 100, 1) if done else None,
        "impact_realised_fy": round(realised, 2),
        "sip_adherence_12m": (adherence or {}).get("adherence_6m_pct"),
        "median_days_to_act": median(lags) if lags else None,
    }
