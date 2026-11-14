"""SIP plans: the instalment schedule, adherence and what is due next.

Implements SPEC Part 1 §2 P1.6 (engine) and Part 2 §7.6, as amended by AMENDMENTS A11 and E18.
A pure module: it reads the plans, transactions and instruments it is handed and never touches the
database or services. It imports only ``domain`` and the standard library; ``forecast`` will import it
(W3-B5), so it must never import ``forecast``.

* ``due_dates(plan, start, end)`` lists a plan's instalment dates inside [start, end].
* ``sip_adherence(sips, txns, instruments, today, months=6, *, skipped=None)`` matches BUYs to instalments
  and scores each plan (the shape ``actions._rules_adherence`` and ``auto_done`` read).
* ``next_due(sips, today, horizon=90)`` lists the instalments due from today for `horizon` days.

Schedule rules (E18):

* monthly: ``day_of_month`` of every month, clamped to the month's last day (31 → 28 Feb).
* quarterly: every 3 months counted from the anchor's month, on ``day_of_month``.
* weekly: every 7 days from the anchor (``day_of_month`` is not used).
* yearly: once a year in the anchor's month, on ``day_of_month``.

The anchor is ``start_date``, or ``created_at[:10]`` when the plan has none. The anchor is also the first
day an instalment can fall on (see AMENDMENTS W2-B3 decisions), ``end_date`` is the last, and an inactive
plan (``active = 0``) has no instalments at all.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta

from .. import domain as d

# Instalments per month by frequency. A local copy of forecast.SIP_PER_MONTH (E18); a test keeps them equal.
SIP_PER_MONTH = {"monthly": 1, "quarterly": 1 / 3, "weekly": 52 / 12, "yearly": 1 / 12}

MATCH_BEFORE = 3     # a BUY up to 3 days before the due date counts
MATCH_AFTER = 20     # ... and up to 20 days after, but never on or past the next instalment
GRACE_DAYS = 4       # an unmatched instalment stays 'upcoming' for 4 days after it falls due
DONE_SHARE = 0.95    # matched ≥ 95% of the planned amount is 'done'
DUE_AHEAD = 7        # the window reaches at least a week past today, across a month boundary (E18)

STATUSES = ("done", "partial", "upcoming", "missed", "skipped")
_SCORE = {"done": 1.0, "partial": 0.5, "missed": 0.0}   # the statuses that count toward adherence


# ── small helpers ──

def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _date(v) -> date | None:
    """A date from a date, or the first 10 characters of an ISO string; None when unparseable."""
    if isinstance(v, date):
        return v
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _is_active(plan: dict) -> bool:
    a = plan.get("active", 1)
    if a is None:
        return True
    if isinstance(a, str):
        return a.strip().lower() not in ("0", "false", "no", "")
    return bool(a)


def _freq(plan: dict) -> str:
    f = str(plan.get("frequency") or "monthly").strip().lower()
    return f if f in SIP_PER_MONTH else "monthly"


def _dom(plan: dict) -> int:
    try:
        return min(max(int(plan.get("day_of_month") or 1), 1), 31)
    except (TypeError, ValueError):
        return 1


def _anchor(plan: dict) -> date | None:
    """start_date, or created_at's date when the plan has no start_date (E18)."""
    return _date(plan.get("start_date")) or _date(plan.get("created_at"))


def _on_day(y: int, m: int, dom: int) -> date:
    return date(y, m, min(dom, calendar.monthrange(y, m)[1]))


def _months_between(lo: date, hi: date):
    """(year, month) for every calendar month that overlaps [lo, hi]."""
    y, m = lo.year, lo.month
    while (y, m) <= (hi.year, hi.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def _month_start_back(today: date, k: int) -> date:
    t = today.year * 12 + (today.month - 1) - k
    return date(t // 12, t % 12 + 1, 1)


def _whole_years(a: date, b: date) -> int:
    """Whole years from a to b (0 when b is before a)."""
    if b <= a:
        return 0
    return b.year - a.year - ((b.month, b.day) < (a.month, a.day))


def step_up_factor(plan: dict, due: date) -> float:
    """(1 + step_up_pct/100) ^ whole years from the anchor to `due` (E18)."""
    step = _f(plan.get("step_up_pct"))
    anchor = _anchor(plan)
    if not step or anchor is None:
        return 1.0
    return (1 + step / 100) ** _whole_years(anchor, due)


def planned_amount(plan: dict, due: date) -> float:
    """The instalment due on `due`: amount × the step-up factor."""
    return _f(plan.get("amount")) * step_up_factor(plan, due)


def _id_key(pid):
    try:
        return (0, int(pid), "")
    except (TypeError, ValueError):
        return (1, 0, str(pid))


# ── schedule ──

def due_dates(plan: dict, start: date, end: date) -> list[date]:
    """The plan's instalment dates inside [start, end], ascending.

    Respects ``active`` (an inactive plan has none), the anchor (``start_date``, else ``created_at``) as the
    first possible date and ``end_date`` as the last. See the module docstring for the cadence rules.
    """
    if not _is_active(plan):
        return []
    anchor = _anchor(plan)
    lo = max(start, anchor) if anchor else start
    stop = _date(plan.get("end_date"))
    hi = min(end, stop) if stop else end
    if lo > hi:
        return []
    freq, dom = _freq(plan), _dom(plan)
    out: list[date] = []
    if freq == "weekly":
        base = anchor or start
        k = max(0, -(-(lo - base).days // 7))   # first k with base + 7k ≥ lo
        day = base + timedelta(days=7 * k)
        while day <= hi:
            out.append(day)
            day += timedelta(days=7)
        return out
    anchor_month = anchor.month if anchor else 1
    for y, m in _months_between(lo, hi):
        if freq == "quarterly" and (m - anchor_month) % 3:
            continue
        if freq == "yearly" and m != anchor_month:
            continue
        day = _on_day(y, m, dom)
        if lo <= day <= hi:
            out.append(day)
    return out


def _next_after(plan: dict, day: date, limit_days: int = 400) -> date | None:
    """The plan's first instalment strictly after `day`, looking up to `limit_days` ahead."""
    nxt = due_dates(plan, day + timedelta(days=1), day + timedelta(days=limit_days))
    return nxt[0] if nxt else None


def next_due(sips: list[dict], today: date, horizon: int = 90) -> list[dict]:
    """Every instalment due in [today, today + horizon] across the plans, as
    {date (ISO), plan_id, name, amount (with the step-up)}, sorted by date, then plan_id."""
    out = []
    for s in sips or []:
        if _f(s.get("amount")) <= 0:
            continue
        for day in due_dates(s, today, today + timedelta(days=horizon)):
            out.append({"date": day.isoformat(), "plan_id": s.get("id"), "name": s.get("name"),
                        "amount": round(planned_amount(s, day), 2)})
    out.sort(key=lambda e: (e["date"], _id_key(e["plan_id"])))
    return out


# ── adherence ──

def _segment_map(instruments: list[dict]) -> dict:
    """instrument id → segment, from instrument rows or positions (either carries what segment_of needs)."""
    seg = {}
    for i in instruments or []:
        iid = i.get("id")
        if iid is None:
            continue
        s = i.get("segment")
        if not s and i.get("asset_class"):
            try:
                s = d.segment_of(i)
            except (KeyError, TypeError):
                s = None
        seg[iid] = s
    return seg


def _epf_imported(txns: list[dict], epf_ids: set) -> bool:
    """True when any BUY on an EPF instrument came from a passbook import (source 'import:epf…')."""
    return any(t.get("type") == d.BUY and t.get("instrument_id") in epf_ids
               and str(t.get("source") or "").startswith("import:epf") for t in txns or [])


def _monthly_equiv(plan: dict, today: date) -> float:
    """amount × SIP_PER_MONTH for a plan running today (the rule forecast.monthly_sip_total uses), else 0."""
    if not _is_active(plan):
        return 0.0
    start, stop = _date(plan.get("start_date")), _date(plan.get("end_date"))
    if (start and start > today) or (stop and stop < today):
        return 0.0
    return round(_f(plan.get("amount")) * SIP_PER_MONTH[_freq(plan)], 2)


def _pct(num: float, den: float) -> float | None:
    return round(100 * num / den, 1) if den > 0 else None


def sip_adherence(sips: list[dict], txns: list[dict], instruments: list[dict], today: date | None = None,
                  months: int = 6, *, skipped: set | None = None) -> dict:
    """Match BUYs to SIP instalments and score each plan (§7.6, A11, E18).

    Window: instalments due from the first day of the month ``months − 1`` months back to
    max(the end of this month, today + 7 days), so a plan due 5 days ahead across a month boundary is
    already listed as ``upcoming``.

    Matching: plans are taken by id and each plan's instalments oldest first. An instalment due on d takes
    BUY amounts dated in [d − 3, min(next due − 1, d + 20)] on the plan's instrument (or, for a segment
    plan, on any instrument in that segment), earliest BUY first, up to its planned amount. Every BUY's
    amount is consumed once across all plans, so one BUY cannot satisfy two plans. Instalments due up to
    24 days before the window are matched first (and not reported), so they keep the BUYs that are theirs.

    Status: ``done`` when matched ≥ 95% of planned; ``skipped`` when (plan id, due ISO) is in `skipped`;
    ``partial`` when matched > 0; ``upcoming`` when nothing matched and due ≥ today − 4; else ``missed``.

    Measures: per plan, adherence_pct = (done + 0.5·partial) / the instalments that are neither upcoming
    nor skipped (None when there are none). adherence_6m_pct is the same score weighted by each
    instalment's planned amount, over every plan (the name stays for a 12-month run). planned_this_month
    and invested_this_month sum the instalments due this calendar month (a skipped one adds nothing to
    planned). EPF plans are left out entirely when any EPF BUY came from a passbook import.

    Returns {plans[{id, name, active, monthly_equiv, months[{month, due, planned, invested, status}],
    adherence_pct, missed_count, next_due}], planned_this_month, invested_this_month, adherence_6m_pct,
    next_due[{date, plan_id, name, amount}], excluded_epf[ids], window{start, end}}.
    """
    today = today or date.today()
    months = max(int(months or 1), 1)
    win_lo = _month_start_back(today, months - 1)
    month_end = _on_day(today.year, today.month, 31)
    win_hi = max(month_end, today + timedelta(days=DUE_AHEAD))
    pre_lo = win_lo - timedelta(days=MATCH_BEFORE + MATCH_AFTER + 1)
    skip_keys = {(str(a), str(b)[:10]) for a, b in (skipped or set())}

    seg_of = _segment_map(instruments)
    epf_ids = {iid for iid, s in seg_of.items() if s == d.SEG_EPF}
    epf_ids |= {i.get("id") for i in instruments or [] if i.get("asset_class") == d.EPF and i.get("id") is not None}
    drop_epf = _epf_imported(txns, epf_ids)

    # BUYs as a pool: each keeps what is left of its amount
    buys = []
    for t in txns or []:
        if t.get("type") != d.BUY:
            continue
        day, amt = _date(t.get("date")), _f(t.get("amount"))
        if day is None or amt <= 0:
            continue
        buys.append({"date": day, "id": t.get("id"), "instrument_id": t.get("instrument_id"),
                     "segment": seg_of.get(t.get("instrument_id")), "left": amt})
    buys.sort(key=lambda b: (b["date"], _id_key(b["id"])))

    plans_out, excluded = [], []
    w_num = w_den = 0.0
    planned_month = invested_month = 0.0
    this_month = today.strftime("%Y-%m")
    kept: list[dict] = []
    done_keys: set[tuple] = set()

    for s in sorted(sips or [], key=lambda p: _id_key(p.get("id"))):
        sid, iid = s.get("id"), s.get("instrument_id")
        if drop_epf and (iid in epf_ids or s.get("segment") == d.SEG_EPF):
            excluded.append(sid)
            continue
        kept.append(s)
        dues = due_dates(s, pre_lo, win_hi) if _f(s.get("amount")) > 0 else []
        if iid not in (None, ""):
            mine = [b for b in buys if b["instrument_id"] == iid]
        else:
            seg = s.get("segment")
            mine = [b for b in buys if seg and b["segment"] == seg]

        rows = []
        for n, due in enumerate(dues):
            nxt = dues[n + 1] if n + 1 < len(dues) else _next_after(s, due)
            hi = due + timedelta(days=MATCH_AFTER)
            if nxt is not None:
                hi = min(hi, nxt - timedelta(days=1))
            lo = due - timedelta(days=MATCH_BEFORE)
            planned = planned_amount(s, due)
            matched = 0.0
            for b in mine:
                if b["date"] < lo:
                    continue
                if b["date"] > hi or matched >= planned:
                    break
                take = min(b["left"], planned - matched)
                if take > 0:
                    b["left"] -= take
                    matched += take
            if due < win_lo:
                continue   # matched only so it keeps its own BUYs
            due_iso = due.isoformat()
            if planned > 0 and matched >= DONE_SHARE * planned - 1e-9:
                status = "done"
            elif (str(sid), due_iso) in skip_keys:
                status = "skipped"
            elif matched > 0:
                status = "partial"
            elif due >= today - timedelta(days=GRACE_DAYS):
                status = "upcoming"
            else:
                status = "missed"
            rows.append({"month": due_iso[:7], "due": due_iso, "planned": round(planned, 2),
                         "invested": round(matched, 2), "status": status})

        num = den = 0.0
        for r in rows:
            score = _SCORE.get(r["status"])
            if score is not None:
                num += score
                den += 1
                w_num += score * r["planned"]
                w_den += r["planned"]
            if r["month"] == this_month:
                invested_month += r["invested"]
                if r["status"] != "skipped":
                    planned_month += r["planned"]
            if r["status"] in ("done", "skipped"):
                done_keys.add((str(sid), r["due"]))

        upcoming = next((r["due"] for r in rows if r["due"] >= today.isoformat()
                         and r["status"] in ("upcoming", "partial")), None)
        if upcoming is None:
            later = _next_after(s, max(win_hi, today - timedelta(days=1)))
            upcoming = later.isoformat() if later else None
        plans_out.append({
            "id": sid, "name": s.get("name"), "active": _is_active(s),
            "monthly_equiv": _monthly_equiv(s, today),
            "months": rows,
            "adherence_pct": _pct(num, den),
            "missed_count": sum(1 for r in rows if r["status"] == "missed"),
            "next_due": upcoming if _is_active(s) else None,
        })

    coming = [e for e in next_due(kept, today) if (str(e["plan_id"]), e["date"]) not in done_keys]
    return {
        "plans": plans_out,
        "planned_this_month": round(planned_month, 2),
        "invested_this_month": round(invested_month, 2),
        "adherence_6m_pct": _pct(w_num, w_den),
        "next_due": coming,
        "excluded_epf": excluded,
        "window": {"start": win_lo.isoformat(), "end": win_hi.isoformat()},
    }
