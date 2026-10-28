"""Indian money calendar: festivals that matter for investing, tax deadlines and personal events,
each with a nudge computed from the portfolio."""
from __future__ import annotations

from datetime import date, timedelta

from .. import domain as d
from .portfolio import to_date

# Lunar-calendar festivals: exact dates must be listed per year (verified against panchang sources).
# Extend this list each year.
FESTIVALS = [
    ("2026-11-06", "dhanteras", "Dhanteras", "gold"),
    ("2026-11-08", "diwali", "Diwali · Lakshmi Puja", "muhurat"),
    ("2027-05-09", "akshaya_tritiya", "Akshaya Tritiya", "gold"),
]
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
    total = float(port["totals"]["value"] or 0)
    if not seg or seg.get("target") is None or total <= 0:
        return "Traditionally an auspicious day to buy gold. Gold ETFs or sovereign gold bonds avoid making charges and storage."
    gap = (float(seg["target"]) - float(seg["pct"])) / 100 * total
    if gap > 500:
        return (f"Traditionally an auspicious day to buy gold — and your gold & silver is {seg['pct']:.1f}% vs a "
                f"{seg['target']:g}% target. About {_inr(gap)} would bring it to target.")
    return (f"Traditionally an auspicious day to buy gold. Your gold & silver is already at {seg['pct']:.1f}% "
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
                "A good day to start or step up a SIP for the new Samvat year.", "/insights#rebalance")

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
                add(day, key, name, "fy", "A fresh ₹1.25L tax-free equity LTCG limit starts, and a good moment for the yearly review.", "/insights#rebalance")
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
            f"Target {_inr(g['target_amount'])}.", "/goals")

    events.sort(key=lambda e: e["date"])
    theme = None
    for key, windows in FESTIVE_WINDOWS.items():
        for fkey, before, after in windows:
            fday = next((to_date(ds) for ds, k, _, _ in FESTIVALS if k == fkey), None)
            if fday and fday - timedelta(days=before) <= today <= fday + timedelta(days=after):
                theme = key
    if (today.month, today.day) in ((1, 26), (8, 15)):
        theme = "national"
    festive = next((e for e in events if e["kind"] == "festival"), None)
    return {"events": events, "theme": theme, "next_festival": festive}
