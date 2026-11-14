"""Indian money calendar: festivals that matter for investing, tax deadlines and personal events,
each with a nudge computed from the portfolio."""
from __future__ import annotations

import json
import os
from datetime import date, timedelta

from .. import domain as d
from .portfolio import to_date

# Lunar-calendar festivals live in data/festivals.json (AMENDMENTS K17): exact dates per year, each with its
# panchang source. Extend that file each year; test_calendar.py fails when no date is more than 180 days ahead.
FESTIVALS_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "festivals.json")


def load_festivals(path: str = FESTIVALS_FILE) -> list[tuple[str, str, str, str]]:
    """Read the festivals file into `(date, key, name, kind)` tuples sorted by date.

    A missing or malformed file (bad JSON, wrong shape, or any entry without an ISO date and non-empty
    key, name and kind strings) gives `[]` and a printed warning, never an exception: the calendar then
    simply shows no festivals.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        rows = doc["festivals"]
        if not isinstance(rows, list):
            raise ValueError("'festivals' is not a list")
        out = []
        for i, r in enumerate(rows):
            vals = tuple(r.get(f) if isinstance(r, dict) else None for f in ("date", "key", "name", "kind"))
            if not all(isinstance(v, str) and v.strip() for v in vals):
                raise ValueError(f"entry {i} needs non-empty date, key, name and kind strings")
            date.fromisoformat(vals[0])
            out.append(vals)
        return sorted(out, key=lambda t: t[0])
    except FileNotFoundError:
        print(f"Warning: festivals file not found at {path}; the calendar shows no festivals.")
    except Exception as e:  # noqa: BLE001 - any malformed content falls back to no festivals
        print(f"Warning: festivals file {path} is malformed ({type(e).__name__}: {e}); "
              "the calendar shows no festivals.")
    return []


FESTIVALS = load_festivals()
# Fixed-date national days and financial deadlines (every year)
RECURRING = [
    (1, 26, "republic_day", "Republic Day", "national"),
    (8, 15, "independence_day", "Independence Day", "national"),
    (6, 15, "advance_tax_1", "Advance tax · 1st instalment", "advance_tax"),
    (9, 15, "advance_tax_2", "Advance tax · 2nd instalment", "advance_tax"),
    (12, 15, "advance_tax_3", "Advance tax · 3rd instalment", "advance_tax"),
    (3, 15, "advance_tax_4", "Advance tax · final instalment", "advance_tax"),
    (3, 31, "fy_end", "Financial year ends", "fy_end"),
    (4, 1, "fy_start", "New financial year", "fy_start"),
    (7, 31, "itr_due", "Income-tax return due", "itr"),
]
FESTIVE_WINDOWS = {  # theme key: (festival key, days before, days after)
    "diwali": [("dhanteras", 6, 0), ("diwali", 0, 3)],
    "akshaya_tritiya": [("akshaya_tritiya", 3, 0)],
}


def _inr(v: float) -> str:
    from .insights import _inr as fmt
    return fmt(v)


def _segment(port: dict, name: str) -> dict | None:
    return next((s for s in port["segments"] if s["segment"] == name), None)


def _gold_nudge(port: dict) -> str:
    seg = _segment(port, d.SEG_COMMODITY)
    total = sum(float(s["value"] or 0) for s in port["segments"] if s.get("target") is not None)
    if not seg or seg.get("mix_pct") is None or total <= 0:
        return "Traditionally an auspicious day to buy gold. Gold ETFs or sovereign gold bonds avoid making charges and storage."
    gap = (float(seg["target"]) - float(seg["mix_pct"])) / 100 * total
    if gap > 500:
        return (f"Traditionally an auspicious day to buy gold — and your gold & silver is {seg['mix_pct']:.1f}% vs a "
                f"{seg['target']:g}% target. About {_inr(gap)} would bring it to target.")
    return (f"Traditionally an auspicious day to buy gold. Your gold & silver is already at {seg['mix_pct']:.1f}% "
            f"(target {seg['target']:g}%), so there's no need to add more just for the occasion.")


def build_calendar(port: dict, tax: dict | None, goals: list[dict], today: date | None = None,
                   horizon_days: int = 75) -> dict:
    today = today or date.today()
    end = today + timedelta(days=horizon_days)
    events: list[dict] = []

    def add(day: date, key: str, title: str, kind: str, note: str, link: str | None = None):
        if today <= day <= end:
            events.append({"date": day.isoformat(), "key": key, "title": title, "kind": kind, "note": note,
                           "link": link, "days": (day - today).days})

    est_tax = (tax or {}).get("estimate", {}).get("total") or 0
    for ds, key, name, kind in FESTIVALS:
        day = to_date(ds)
        if kind == "gold":
            add(day, key, name, "festival", _gold_nudge(port), "/holdings/commodity")
        elif kind == "muhurat":
            add(day, key, name, "festival",
                "Stock exchanges hold a one-hour Muhurat trading session on Diwali (timing is announced by NSE/BSE). "
                "A good day to start or step up a SIP for the new Samvat year.", "/risk#rebalance")

    for year in (today.year, today.year + 1):
        for month, dom, key, name, kind in RECURRING:
            day = date(year, month, dom)
            if kind == "national":
                india = sum(float(s["value"]) for s in port["segments"] if s["segment"] != d.SEG_EQ_US)
                total = float(port["totals"]["value"] or 0) or 1
                add(day, key, name, "national", f"{india / total * 100:.0f}% of your portfolio is invested in India.")
            elif kind == "advance_tax":
                note = "Due if your tax for the year, after TDS, is over ₹10,000."
                if est_tax > 10000:
                    note = f"Your estimated tax on investment gains and income this year is {_inr(est_tax)} — check whether an instalment is due."
                add(day, key, name, "tax", note, "/tax")
            elif kind == "fy_end":
                opp = (tax or {}).get("opportunities", {})
                bits = []
                if (opp.get("ltcg_harvest") or {}).get("suggested_booking", 0) > 1000:
                    bits.append(f"book up to {_inr(opp['ltcg_harvest']['suggested_booking'])} of tax-free long-term gains")
                if opp.get("loss_harvest_offsettable", 0) > 500:
                    bits.append(f"harvest losses to offset {_inr(opp['loss_harvest_offsettable'])}")
                note = ("Last day to " + " and ".join(bits) + " for this year.") if bits else "Last day for this year's tax-saving moves (80C, harvesting)."
                add(day, key, name, "tax", note, "/tax")
            elif kind == "fy_start":
                add(day, key, name, "fy", "A fresh ₹1.25L tax-free equity LTCG limit starts, and a good moment for the yearly review.", "/risk#rebalance")
            elif kind == "itr":
                add(day, key, name, "tax", "Export your capital-gains report from the Tax page for Schedule CG.", "/tax")

    # Personal events
    for p in port["positions"]:
        if p["asset_class"] == d.FIXED_DEPOSIT and p.get("is_open") and p.get("maturity_date"):
            add(to_date(p["maturity_date"]), f"fd:{p['id']}", f"FD matures · {p['name']}", "personal",
                f"About {_inr(p.get('maturity_value') or p['value'])} will be credited.", "/fixed-deposits")
        e = p.get("elss") or {}
        if e.get("next_unlock"):
            add(to_date(e["next_unlock"]), f"elss:{p['id']}", f"ELSS units unlock · {p['name']}", "personal",
                "Another SIP instalment completes its 3-year lock-in.", f"/holding/{p['id']}")
    for l in ((tax or {}).get("opportunities", {}).get("upcoming_long_term") or [])[:3]:
        add(to_date(l["lt_on"]), f"lt:{l['instrument_id']}:{l['date']}", f"{l['name']} turns long-term", "personal",
            f"Selling after this date saves about {_inr(l['tax_saving'])} in tax.", "/tax")
    for g in goals:
        add(to_date(g["target_date"]), f"goal:{g['id']}", f"Goal date · {g['name']}", "personal",
            f"Target {_inr(g['target_amount'])}.", "/plan?tab=goals")

    events.sort(key=lambda e: e["date"])
    theme = None
    for key, windows in FESTIVE_WINDOWS.items():
        for fkey, before, after in windows:
            # every year's occurrence counts, not only the first listed (festivals.json holds several years)
            if any(to_date(ds) - timedelta(days=before) <= today <= to_date(ds) + timedelta(days=after)
                   for ds, k, _, _ in FESTIVALS if k == fkey):
                theme = key
    if (today.month, today.day) in ((1, 26), (8, 15)):
        theme = "national"
    festive = next((e for e in events if e["kind"] == "festival"), None)
    return {"events": events, "theme": theme, "next_festival": festive}


# ── upcoming money (SPEC Part 1 P1.5, §7.1; AMENDMENTS G2, G13) ──

UPCOMING_DAYS = 90
UPCOMING_CAP = 30
# Same-day events are ordered by kind: deadlines first, then money, then the softer reminders.
UPCOMING_KIND_ORDER = ("tax", "fy", "fd_maturity", "p2p_close", "sip", "ipo", "festival", "personal")
IPO_FIELDS = (("open_date", "opens"), ("close_date", "closes"), ("allotment_date", "allotment"), ("listing_date", "lists"))


def _iso_day(v) -> date | None:
    """A date from an ISO date or timestamp string (or a date); None when it is missing or unreadable."""
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _month_days(year: int, month: int) -> int:
    nxt = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    return (nxt - date(year, month, 1)).days


def _p2p_close_text(e: dict) -> tuple[str, str]:
    """Title and note for a cash-flow `p2p_close` event. `cash_flow_forecast` folds every close into one
    event a month ({name: '<n> P2P loan(s)', count: n, instrument_id: None}); an event with an
    instrument_id is one named loan."""
    one = "Its last EMI is due; its repayments are counted in the money coming in, month by month."
    if e.get("instrument_id") is not None:
        return f"{e.get('name') or 'A P2P loan'} is fully repaid", one
    n = e.get("count")
    if n is None:  # a payload without `count`: read it from the folded name
        head = str(e.get("name") or "").split(" ", 1)[0]
        n = int(head) if head.isdigit() else None
    if n == 1:
        return "1 P2P loan finishes repaying", one
    title = f"{n} P2P loans finish repaying" if n is not None else "P2P loans finish repaying"
    return title, "Their last EMIs are due; repayments are counted in the money coming in, month by month."


def _window_totals(cashflow: dict | None, today: date, end: date) -> tuple[float | None, float | None]:
    """Σ inflow and Σ outflow of the cash-flow month rows inside [today, end].

    Rows from today's month up to the month before `end` count in full (the cash-flow engine already drops
    anything on or before today, and does not project again a dividend or EPF contribution already
    recorded this month). The row for `end`'s month counts pro rata by its days inside the window,
    end.day / days in that month. Rows outside the window are ignored; a window the rows do not reach just
    sums what is there. No cash-flow payload gives (None, None): unknown, not zero.
    """
    if cashflow is None:
        return None, None
    first_key, end_key = today.isoformat()[:7], end.isoformat()[:7]
    inflow = outflow = 0.0
    for row in cashflow.get("months") or []:
        key = str(row.get("month") or "")[:7]
        if not key or key < first_key or key > end_key:
            continue
        share = end.day / _month_days(end.year, end.month) if key == end_key else 1.0
        inflow += float(row.get("inflow") or 0) * share
        outflow += float(row.get("outflow") or 0) * share
    return round(inflow, 2), round(outflow, 2)


def upcoming(calendar: dict | None, cashflow: dict | None, sip_next_due: list[dict] | None,
             ipos: list[dict] | None, today: date | None = None) -> dict:
    """Coming up over the next 90 days, with the money that arrives and leaves (Home "Coming up").

    Inputs (AMENDMENTS G2): `calendar` is `build_calendar(..., horizon_days=90)`, `cashflow` the full
    `forecast.cash_flow_forecast` payload (W4-B1 passes `cashflow(4)` so its rows cover the window),
    `sip_next_due` the `plans.next_due(sips, today, 90)` list and `ipos` the scope's `ipos` table rows.

    Returns {inflow_90d, outflow_90d, theme, next_festival, events}. Each event is
    {date, days, kind, title, amount, direction ('in' | 'out' | None), link, key} plus an optional `note`
    (rules in AMENDMENTS G13):
    - only dates in [today, today + 90]; calendar `national` days and cash-flow `p2p_overdue` alerts are dropped;
    - SIP instalments: kind `sip`, out, `/recurring`, key `sip:<plan_id>:<date>`;
    - cash-flow FD maturities: kind `fd_maturity`, in, with the amount, `/fixed-deposits`, key `fd:<iid>`;
    - cash-flow P2P closes (folded per month, no instrument): kind `p2p_close`, in, `/p2p`, amount None
      (the principal comes back as EMIs before that date, already in `inflow_90d`), key `p2p:<iid>` or,
      when folded, `p2p:<YYYY-MM>`; titled "1 P2P loan finishes repaying" / "<n> P2P loans finish repaying";
    - IPO open, close, allotment and listing dates: kind `ipo`, no amount, `/markets?tab=watchlist`,
      key `ipo:<id>:<field>`;
    - calendar `fd:<id>` events become `fd_maturity` (in, amount None); an FD maturity that both sources list
      on the same (instrument_id, date) is kept once, from the cash flow, because it carries the amount;
    - every other calendar event keeps its kind, title, note, link and key, with no amount or direction.
    Events are sorted by date, then by UPCOMING_KIND_ORDER, then key, and capped at 30.

    `inflow_90d` / `outflow_90d` come from the cash-flow month rows, not from the events, so they include
    EMIs, dividends and interest that have no event of their own (see `_window_totals`); they are expected
    amounts, not commitments. `theme` and `next_festival` pass through from the calendar.
    """
    today = today or date.today()
    end = today + timedelta(days=UPCOMING_DAYS)
    calendar = calendar or {}
    events: list[dict] = []

    def add(day, kind: str, title: str, key: str, link: str | None, amount=None, direction=None, note=None):
        when = _iso_day(day)
        if when is None or not (today <= when <= end):
            return
        ev = {"date": when.isoformat(), "days": (when - today).days, "kind": kind, "title": title,
              "amount": round(float(amount), 2) if amount is not None else None, "direction": direction,
              "link": link, "key": key}
        if note:
            ev["note"] = note
        events.append(ev)

    # cash-flow events first: they carry the amounts, so they win the FD dedupe below
    fd_seen: set[tuple] = set()
    for e in (cashflow or {}).get("events") or []:
        kind, iid = e.get("kind"), e.get("instrument_id")
        if kind == "fd_maturity":
            when = _iso_day(e.get("date"))
            before = len(events)
            add(when, "fd_maturity", f"FD matures · {e.get('name') or 'Fixed deposit'}", f"fd:{iid}", "/fixed-deposits",
                e.get("amount"), "in", e.get("note"))
            if len(events) > before:
                fd_seen.add((str(iid), when.isoformat()))
        elif kind == "p2p_close":
            # A date, not a payment: the outstanding principal comes back as EMIs over the months before it,
            # and those EMIs are already in inflow_90d. So no amount (wave-3 review, AMENDMENTS).
            key = f"p2p:{iid}" if iid is not None else f"p2p:{str(e.get('date') or '')[:7]}"
            title, note = _p2p_close_text(e)
            add(e.get("date"), "p2p_close", title, key, "/p2p", None, "in", note)
        # p2p_overdue is an alert about the past, never upcoming money

    for s in sip_next_due or []:
        add(s.get("date"), "sip", f"SIP · {s.get('name') or 'Plan'}", f"sip:{s.get('plan_id')}:{s.get('date')}",
            "/recurring", s.get("amount"), "out")

    for r in ipos or []:
        for field, what in IPO_FIELDS:
            note = None
            if field == "close_date" and not r.get("applied"):
                note = "Last day to apply."
            elif field == "allotment_date" and r.get("applied"):
                note = "You applied: check whether you were allotted shares."
            add(r.get(field), "ipo", f"{r.get('name') or 'IPO'} IPO {what}", f"ipo:{r.get('id')}:{field}",
                "/markets?tab=watchlist", note=note)

    for e in calendar.get("events") or []:
        kind, key = e.get("kind"), str(e.get("key") or "")
        if kind == "national":
            continue
        if kind == "personal" and key.startswith("fd:"):
            when = _iso_day(e.get("date"))
            if when is None or (key[3:], when.isoformat()) in fd_seen:
                continue
            add(when, "fd_maturity", e.get("title"), key, e.get("link") or "/fixed-deposits", None, "in", e.get("note"))
            continue
        add(e.get("date"), kind, e.get("title"), key, e.get("link"), note=e.get("note"))

    rank = {k: i for i, k in enumerate(UPCOMING_KIND_ORDER)}
    events.sort(key=lambda ev: (ev["date"], rank.get(ev["kind"], len(rank)), ev["key"]))
    inflow, outflow = _window_totals(cashflow, today, end)
    return {"inflow_90d": inflow, "outflow_90d": outflow, "theme": calendar.get("theme"),
            "next_festival": calendar.get("next_festival"), "events": events[:UPCOMING_CAP]}
