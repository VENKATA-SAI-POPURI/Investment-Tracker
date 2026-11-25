"""The question-led app: each question the owner asks, answered in one line from numbers the app already has.

Every answer is built from the group overview (`overview.group_view`), the goal projections, this year's tax and
the data checks, so it can never disagree with the page it links to. Nothing here computes a new figure.

- `questions`: {id, q, answer, detail, tone, badge, link}. tone: good | warn | bad | muted.
- `todo`: the jobs worth doing now, each with one button (`cta`, `link`); `flow` names a guided flow.
- `dragging`: what holds the portfolio back (groups behind their market, holdings down, late P2P loans).
- `goals`: one row per goal (and the retirement plan when one is saved), on track or short by ₹ a month.
"""
from __future__ import annotations

from datetime import date

from .. import domain as d
from .overview import EQUIVALENT_PP, _money, suggestions

MIX_BAND = 2.0          # a group within ±2 points of its target counts as on target
LOSS_PCT = -10.0        # a holding down 10% or more is worth a look
MIN_RUPEES = 1000.0     # smaller amounts are noise
ON_TRACK = ("on_track", "achieved")


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _pts(v: float) -> str:
    return f"{abs(v):.1f}".rstrip("0").rstrip(".") + " pts"


def _names(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def round_up(v: float, step: float = 100) -> float:
    return float(-(-v // step) * step) if v > 0 else 0.0


# ── the pieces ──

def dragging(view: dict, port: dict) -> list[dict]:
    out: list[dict] = []
    for g in view["groups"]:
        b = g.get("bench") or {}
        if b.get("verdict") != "behind" or b.get("end_value") is None:
            continue
        gap = _f(b["end_value"]) - _f(g["value"])
        if gap >= MIN_RUPEES:
            out.append({"kind": "group", "key": g["key"], "group": g["key"], "name": g["label"], "amount": round(gap, 2),
                        "text": f"{g['xirr']:.1f}% a year · {b['label']} did {b['xirr']:.1f}%",
                        "why": "less than the same money in its market",
                        "cta": "Compare", "link": "/analysis?q=market"})
    for p in port["positions"]:
        if not p.get("is_open"):
            continue
        if p["asset_class"] in d.TRADABLE and (p.get("unrealized_pct") or 0) <= LOSS_PCT and _f(p.get("unrealized")) <= -MIN_RUPEES:
            out.append({"kind": "holding", "id": p["id"], "group": p["group"], "name": p["name"],
                        "amount": round(-_f(p["unrealized"]), 2),
                        "text": f"Down {abs(p['unrealized_pct']):.1f}% on what you paid", "why": "below what you paid",
                        "cta": "Decide", "link": f"/portfolio?holding={p['id']}"})
        elif p["asset_class"] == d.P2P and (p.get("overdue_days") or 0) > 30:
            out.append({"kind": "p2p", "id": p["id"], "group": p["group"], "name": p["name"],
                        "amount": round(_f(p.get("outstanding")), 2),
                        "text": f"{p['overdue_days']} days late", "why": "at risk",
                        "cta": "Review", "link": f"/portfolio?holding={p['id']}"})
    out.sort(key=lambda x: -x["amount"])
    return out[:6]


def goal_rows(goals: list[dict], retirement: dict | None) -> list[dict]:
    rows = []
    for g in goals:
        pr = g.get("projection") or {}
        now = _f(pr.get("linked_monthly")) or _f(g.get("monthly_contribution"))
        need = pr.get("required_sip")
        status = pr.get("status")
        extra = round_up(_f(need) - now) if need is not None and status not in ON_TRACK else 0.0
        rows.append({"id": g["id"], "kind": "goal", "name": g["name"], "target": _f(g["target_amount"]),
                     "date": str(g["target_date"])[:10], "current": _f(pr.get("current")),
                     "projected": _f(pr.get("p50") if pr.get("p50") is not None else pr.get("projected")),
                     "status": status, "probability": pr.get("probability"), "monthly_now": now,
                     "monthly_needed": need, "extra": extra, "progress_pct": pr.get("progress_pct")})
    if retirement and retirement.get("corpus_needed"):
        r = retirement
        inp = r.get("inputs") or {}
        now = _f(inp.get("monthly_sip"))
        need = r.get("required_sip")
        status = r.get("status")
        extra = round_up(_f(need) - now) if need is not None and status not in ON_TRACK else 0.0
        years = int(r.get("years_to_retire") or 0)
        today = date.today()
        rows.append({"id": "retirement", "kind": "retirement", "name": f"Retire at {inp.get('retire_age')}",
                     "target": _f(r["corpus_needed"]), "date": date(today.year + years, today.month, 1).isoformat(),
                     "current": _f(r.get("current")), "projected": _f(r.get("projected")), "status": status,
                     "probability": r.get("probability"), "monthly_now": now, "monthly_needed": need, "extra": extra,
                     "progress_pct": round(min(_f(r.get("current")) / _f(r["corpus_needed"]) * 100, 100), 1)})
    order = {"off_track": 0, "at_risk": 1, None: 2, "on_track": 3, "achieved": 4}
    rows.sort(key=lambda x: (order.get(x["status"], 2), x["date"]))
    return rows


def todo(view: dict, port: dict, tax: dict | None, checks: list[dict], today: date, slab: float) -> list[dict]:
    items: list[dict] = []
    groups = view["groups"]
    short = [g for g in groups if g.get("gap") is not None and g["gap"] <= -MIX_BAND and g["key"] != d.GRP_EPF]
    monthly = _f(view["totals"].get("monthly_in"))
    if short:
        amt = max(round(monthly / 1000) * 1000, 5000.0) if monthly > 0 else 25000.0
        items.append({"id": "flow:invest", "flow": "invest", "tone": "primary", "icon": "target",
                      "title": f"Put {_money(amt)} to work",
                      "detail": "Fills " + _names([g["label"] for g in sorted(short, key=lambda g: g["gap"])][:2]),
                      "cta": "Start", "link": f"/flow/invest?amount={amt:.0f}", "steps": 4, "value": amt})
    for s in suggestions(view, port, tax, today, slab, limit=12):
        if s["id"].startswith("mix:under:"):
            continue          # the invest flow above covers every group under target
        s = dict(s)
        if s["id"].startswith("fd:maturing:"):
            pid = int(s["id"].rsplit(":", 1)[1])
            p = next((x for x in port["positions"] if x["id"] == pid), None)
            mv = (_f(p.get("maturity_value")) or _f(p["value"])) if p else _f(s.get("value"))
            s.update(flow="invest", cta="Plan it", detail=f"{_money(mv)} to place",
                     link=f"/flow/invest?amount={mv:.0f}&from={pid}")
        elif s["id"] == "p2p:overdue":
            late = [p for p in port["positions"] if p.get("is_open") and p["asset_class"] == d.P2P and (p.get("overdue_days") or 0) > 30]
            if len(late) == 1:
                s.update(title=f"{late[0]['name']} is {late[0]['overdue_days']} days late", detail=s["impact"],
                         link=f"/portfolio?holding={late[0]['id']}")
            else:
                s.update(link="/analysis?q=dragging")
            s.update(cta="Review")
        elif s["id"].startswith("tax:"):
            s.update(cta="Show me")
        elif s["id"].startswith("review:"):
            s.update(cta="Decide")
        items.append(s)
    shown = {"p2p-overdue"}        # already a to-do of its own above
    bad = [c for c in checks if c.get("severity") in ("bad", "warn") and c.get("id") not in shown]
    if bad:
        n = sum(int(c.get("count") or 1) for c in bad)
        items.append({"id": "data:checks", "tone": "warn", "icon": "alert", "rank": 5,
                      "title": f"Fix {n} data problem{'s' if n != 1 else ''}",
                      "detail": bad[0]["title"], "cta": "Fix", "link": "/activity?tab=checks", "value": 0.0})
    return items


# ── the questions ──

def questions(view: dict, drag: list[dict], goals: list[dict], tax: dict | None) -> list[dict]:
    t, m = view["totals"], view["market"]
    out = []

    gain, x = _f(t.get("gain")), t.get("xirr")
    out.append({"id": "money", "q": "Am I making money?",
                "answer": (f"Yes · {_money(gain)} gain" if gain > 0 else f"Not yet · {_money(gain)}"),
                "detail": f"{x:.1f}% a year on what you put in" if x is not None else "Not enough history for a yearly return",
                "tone": "good" if gain > 0 else "bad", "icon": "trendingUp", "link": "/analysis?q=returns"})

    diff = m.get("diff")
    if diff is None:
        ans, tone, det = "Not enough data yet", "muted", "Needs market prices for the dates you invested"
    else:
        det = f"Same money in the market: {m['xirr']:.1f}% a year"
        if abs(diff) <= EQUIVALENT_PP:
            ans, tone = "About level with it", "good"
        elif diff > 0:
            ans, tone = f"Ahead by {_pts(diff)}", "good"
        else:
            ans, tone = f"Behind by {_pts(diff)}", "warn"
    out.append({"id": "market", "q": "Am I beating the market?", "answer": ans, "detail": det, "tone": tone,
                "icon": "scale", "link": "/analysis?q=market",
                "badge": None if diff is None else f"{'+' if diff > 0 else '−'}{abs(diff):.1f}"})

    groups = view["groups"]
    if not view["targets"]["has_mine"]:
        out.append({"id": "mix", "q": "Is my mix on target?", "answer": "No targets set yet",
                    "detail": "Set your own, or use the suggested mix", "tone": "muted", "icon": "pie",
                    "link": "/analysis?q=mix"})
    else:
        off = sorted((g for g in groups if g.get("gap") is not None and abs(g["gap"]) >= MIX_BAND), key=lambda g: -abs(g["gap"]))
        if not off:
            ans, det, tone = "Yes", f"Every group is within {MIX_BAND:g} pts of its target", "good"
        else:
            top = off[0]
            ans = f"{top['label']} is {_pts(top['gap'])} {'over' if top['gap'] > 0 else 'short'}"
            rest = [g["label"] for g in off[1:] if (g["gap"] < 0) == (top["gap"] > 0)][:2] or [g["label"] for g in off[1:3]]
            det = (f"{_names(rest)} {'are' if len(rest) > 1 else 'is'} {'short' if top['gap'] > 0 else 'over'}" if rest
                   else "The only group off target")
            tone = "warn"
        out.append({"id": "mix", "q": "Is my mix on target?", "answer": ans, "detail": det, "tone": tone, "icon": "pie",
                    "link": "/analysis?q=mix", "badge": f"{len(off)} off" if off else None})

    if not goals:
        out.append({"id": "goals", "q": "Am I on track for my goals?", "answer": "No goals yet",
                    "detail": "Add one to see if you're on track", "tone": "muted", "icon": "flag", "link": "/analysis?q=goals"})
    else:
        on = sum(1 for g in goals if g["status"] in ON_TRACK)
        worst = next((g for g in goals if g["status"] not in ON_TRACK and g["extra"] > 0), None)
        out.append({"id": "goals", "q": "Am I on track for my goals?",
                    "answer": f"All {len(goals)} on track" if on == len(goals) else f"{on} of {len(goals)} on track",
                    "detail": (f"{worst['name']} needs {_money(worst['extra'])} more a month" if worst
                               else "Nothing to change" if on == len(goals) else "Open to see what's short"),
                    "tone": "good" if on == len(goals) else "warn", "icon": "flag", "link": "/analysis?q=goals",
                    "badge": None if on == len(goals) else str(len(goals) - on)})

    if drag:
        names = []
        for x in drag:
            if x["name"] not in names:
                names.append(x["name"])
        first = drag[0]
        out.append({"id": "dragging", "q": "What's dragging me down?", "answer": _names(names[:2]),
                    "detail": f"{first['name']}: {_money(first['amount'])} {first['why']}", "tone": "bad", "icon": "arrowDown",
                    "link": "/analysis?q=dragging", "badge": str(len(drag))})
    else:
        out.append({"id": "dragging", "q": "What's dragging me down?", "answer": "Nothing stands out",
                    "detail": "No group behind its market, no holding down 10%", "tone": "good", "icon": "arrowDown",
                    "link": "/analysis?q=dragging"})

    winners = sorted((g for g in groups if _f(g.get("gain")) > 0), key=lambda g: -_f(g["gain"]))
    out.append({"id": "returns", "q": "Where did my returns come from?",
                "answer": ", then ".join(g["label"] for g in winners[:2]) if winners else "No gains yet",
                "detail": f"{_money(gain)} gain in total" if gain else "Nothing gained or lost yet",
                "tone": "good" if winners else "muted", "icon": "chart", "link": "/analysis?q=returns",
                "badge": f"+{_money(gain)}" if gain > 0 else None})

    if tax:
        est = _f((tax.get("estimate") or {}).get("total"))
        left = _f((tax.get("equity_exemption") or {}).get("remaining"))
        out.append({"id": "tax", "q": "How much tax will I pay?",
                    "answer": f"≈ {_money(est)} this year" if est > 0 else "Nothing so far this year",
                    "detail": f"{_money(left)} of tax-free equity gains still unused" if left > 0 else "Tax-free limit used up",
                    "tone": "muted", "icon": "receipt", "link": "/tax", "badge": str(tax.get("fy") or "").replace("FY", "FY ").strip() or None})
    return out


def build(view: dict, port: dict, tax: dict | None, checks: list[dict], goals: list[dict], retirement: dict | None,
          today: date, slab: float) -> dict:
    drag = dragging(view, port)
    rows = goal_rows(goals, retirement)
    return {"as_of": view["as_of"], "questions": questions(view, drag, rows, tax), "todo": todo(view, port, tax, checks, today, slab),
            "dragging": drag, "goals": rows, "monthly_in": view["totals"].get("monthly_in")}
