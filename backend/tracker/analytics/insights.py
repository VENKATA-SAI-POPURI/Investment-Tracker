"""Rule-based insights & suggestions. Every insight is explainable and links to where to act.

Insight ids are frozen (AMENDMENTS A8): never rename an existing id, because snoozes, dismissals and
the action ids derived from them key on it. Links follow the page list in SPEC Part 1 §3.4 and the
remap in §3.6; ``tests/test_links.py`` pins both, and ``tests/test_insights.py`` pins the P1 thresholds
(SPEC Part 2 §8.3, AMENDMENTS G10).
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from datetime import date, datetime, timezone

from .. import domain as d
from .actions import HARVEST_FLOOR  # A12, G10: actions imports nothing from insights, so no cycle
from .portfolio import to_date

SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2, "positive": 3}

# §8.3 / G10 thresholds. A row opens at the first number; while the action log holds it open or planned
# (``open_ids``) it keeps firing down to the second, so it does not flap around the line.
CONCENTRATION_LIMIT = 15.0       # % of the portfolio in one holding (not MF)
CONCENTRATION_LIMIT_MF = 25.0    # ... in one mutual fund, which is already diversified inside
CONCENTRATION_HYSTERESIS = 3.0   # closes below limit − 3: 12 (MF 22)
SECTOR_LIMIT = 30.0              # % of direct equity in one sector: fires above this
SECTOR_CLOSE = 28.0              # an open sector row keeps firing while share ≥ 28
DRIFT_WARN, DRIFT_INFO = 5.0, 2.5
NPS_NAV_STALE_DAYS = 30          # a hand-priced NPS NAV older than this is flagged


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


def build_insights(portfolio: dict, tax: dict | None, goals: list[dict], settings: dict,
                   history_metrics: dict | None = None, benchmarks: list[dict] | None = None,
                   today: date | None = None, sips: list[dict] | None = None, txns: list[dict] | None = None,
                   *, cushion: dict | None = None, risk_est: dict | None = None, stress: dict | None = None,
                   snapshot_then: dict | None = None, adherence: dict | None = None,
                   book: dict | None = None, open_ids: Iterable[str] | None = None) -> list[dict]:
    """Build the ranked list of insights for one portfolio.

    Each insight is ``{id, severity, category, title, detail, action, link, amount}``. Ids are stable
    across releases; ``link`` is always a route from the SPEC §3.4 page list.

    ``open_ids`` (keyword-only, G10) holds the ids of the ``concentration:``/``sector:`` rows that the action
    log has open or planned. Such a row keeps firing down to its close line (weight ≥ limit − 3, sector
    share ≥ 28) instead of its open line, so it does not flap. ``None`` means no hysteresis.

    The keyword-only ``cushion``, ``risk_est``, ``stress``, ``snapshot_then``, ``adherence`` and ``book``
    arguments are accepted so callers can pass them without another signature change. They default to
    None and are ignored: every §8.3 row that reads them is an ``actions.py`` source (G10).
    """
    del cushion, risk_est, stress, snapshot_then, adherence, book  # accepted and ignored (G10)
    today = today or date.today()
    held_open = set(open_ids or ())
    out: list[dict] = []

    def add(id_, severity, category, title, detail, action=None, link=None, amount=None):
        out.append({"id": id_, "severity": severity, "category": category, "title": title, "detail": detail,
                    "action": action, "link": link, "amount": round(amount, 2) if amount is not None else None})

    totals, segments, positions = portfolio["totals"], portfolio["segments"], portfolio["positions"]
    total = float(totals["value"] or 0)
    if total <= 0:
        add("empty", "info", "data", "Add your first investment",
            "Record a purchase to start tracking returns, allocation and tax.", link="/transactions")
        return out

    # ── Allocation drift (within the classes that have a target) ──
    mix_total = sum(float(s["value"] or 0) for s in segments if s.get("target") is not None)
    for s in segments:
        if s.get("target") is None or s.get("drift") is None:
            continue
        drift = s["drift"]
        if abs(drift) >= DRIFT_INFO:
            amt = abs(drift) / 100 * mix_total
            over = drift > 0
            add(f"drift:{s['segment']}", "warning" if abs(drift) >= DRIFT_WARN else "info", "allocation",
                f"{s['segment']} is {abs(drift):.1f} pts {'above' if over else 'below'} target",
                f"Now {s['mix_pct']:.1f}% vs target {s['target']}% — about {_inr(amt)} {'too much' if over else 'short'}.",
                "Route new investments to under-weight segments, or trim this one." if over
                else f"Direct your next {_inr(amt)} of investments here.", "/risk#rebalance", amt)
    if not any(s.get("target") is not None for s in segments):
        add("targets:missing", "info", "allocation", "Set target allocation",
            "Targets let the app flag drift and plan rebalancing for you.", link="/risk#mix")  # D11

    open_pos = [p for p in positions if p.get("is_open") and p["asset_class"] != d.CASH]

    # ── Concentration (G10: warning only; an open row closes below limit − 3) ──
    for p in open_pos:
        if p["asset_class"] in (d.P2P, d.FIXED_DEPOSIT):
            continue
        cid = f"concentration:{p['id']}"
        limit = CONCENTRATION_LIMIT_MF if p["asset_class"] == d.MUTUAL_FUND else CONCENTRATION_LIMIT
        line = limit - CONCENTRATION_HYSTERESIS if cid in held_open else limit
        if (p.get("weight") or 0) >= line:
            add(cid, "warning", "risk",
                f"{p['name']} is {p['weight']:.1f}% of your portfolio",
                "A single position this large can dominate your returns.",
                "Consider capping any one holding near 10% of the portfolio.", f"/holding/{p['id']}", p["value"])
    equity_val = sum(p["value"] for p in open_pos if p["asset_class"] == d.EQUITY)
    by_sector = defaultdict(float)
    for p in open_pos:
        if p["asset_class"] == d.EQUITY:
            by_sector[p.get("sector") or "Unclassified"] += p["value"]
    for sector, v in by_sector.items():
        share = round(v / equity_val * 100, 6) if equity_val else 0  # so 300/1000 is 30, not 30.000000000000004
        sid = f"sector:{sector}"
        fires = share >= SECTOR_CLOSE if sid in held_open else share > SECTOR_LIMIT
        if fires and sector != "Unclassified":
            add(sid, "warning", "risk",
                f"{sector} is {share:.0f}% of your stocks", f"{_inr(v)} of {_inr(equity_val)} in direct equity sits in one sector.",
                "Spread new stock purchases across other sectors.", "/risk#concentration", v)
    stocks = [p for p in open_pos if p["asset_class"] == d.EQUITY]
    if 0 < len(stocks) < 5:
        add("diversification:stocks", "info", "risk", f"Only {len(stocks)} direct stocks",
            "With few stocks, one bad result moves the whole equity book.", "Index funds can add breadth cheaply.",
            "/holdings/equity")

    # ── Winners & losers ──
    for p in open_pos:
        up, held = p.get("unrealized_pct"), (today - to_date(p["first_date"])).days if p.get("first_date") else 0
        if up is None:
            continue
        if up <= -20 and held >= 180:
            add(f"loser:{p['id']}", "warning", "performance", f"{p['name']} is down {abs(up):.0f}%",
                f"Unrealized loss of {_inr(-p['unrealized'])} after {held // 30} months.",
                "Re-check the reason you bought it; selling also books a tax loss.", f"/holding/{p['id']}", -p["unrealized"])
        elif up >= 50 and p["weight"] >= 5:
            add(f"winner:{p['id']}", "info", "performance", f"{p['name']} is up {up:.0f}%",
                f"It has grown to {p['weight']:.1f}% of the portfolio.",
                "Consider booking partial profits to stay near your targets.", f"/holding/{p['id']}", p["unrealized"])

    # ── P2P ──
    p2p = [p for p in positions if p["asset_class"] == d.P2P]
    overdue = [p for p in p2p if p.get("overdue_days", 0) > 7]
    if overdue:
        amt = sum(p["outstanding"] for p in overdue)
        add("p2p:overdue", "warning", "p2p", f"{len(overdue)} P2P loans are past maturity",
            f"{_inr(amt)} principal is still outstanding on loans past their expected end date.",
            "Import the latest LenDen statement or mark the loans' status.", "/p2p", amt)
    risk = sum(p.get("at_risk") or 0 for p in p2p)
    if risk > 0:
        n = sum(1 for p in p2p if p.get("at_risk"))
        add("p2p:defaulted", "warning", "p2p", f"{_inr(risk)} in defaulted P2P loans",
            f"{n} loan(s) are marked defaulted; recoveries are uncertain.",
            "Treat this as at-risk capital when sizing new P2P lending.", "/p2p", risk)
    p2p_seg = next((s for s in segments if s["segment"] == d.SEG_P2P), None)
    rates = [p["rate"] for p in p2p if p.get("rate")]
    if p2p_seg and p2p_seg.get("xirr") is not None and rates:
        stated = sum(rates) / len(rates)
        x = p2p_seg["xirr"]
        if x < stated * 0.5:
            add("p2p:yield", "warning", "p2p", f"P2P is returning {x:.1f}% vs {stated:.1f}% stated",
                "Defaults and fees are eating most of the advertised rate.", "Compare with safer debt options.", "/p2p")

    # ── Fixed deposits ──
    for p in positions:
        if p["asset_class"] == d.FIXED_DEPOSIT and p.get("days_to_maturity") is not None and 0 <= p["days_to_maturity"] <= 30:
            add(f"fd:maturing:{p['id']}", "info", "fd", f"FD at {p['name']} matures in {p['days_to_maturity']} days",
                f"About {_inr(p.get('maturity_value') or p['value'])} will be credited.",
                "Decide in advance whether to renew or redeploy it.", "/fixed-deposits", p.get("maturity_value"))

    # ── Cash ──
    for p in positions:
        if p["asset_class"] == d.CASH and (p.get("balance_usd") or 0) > 50:
            add("cash:usd", "info", "allocation", f"${p['balance_usd']:,.0f} uninvested in your US account",
                f"About {_inr(p['value'])} is sitting idle.", "Invest it or bring it back.", "/forex", p["value"])

    # ── Tax ──
    if tax:
        opp = tax["opportunities"]
        q4 = today.month in (1, 2, 3)
        lt = opp["ltcg_harvest"]
        # A12: the same floor closes the action, so the insight never fires below it
        if lt["suggested_booking"] > 1000 and (lt.get("remaining_exemption") or 0) >= HARVEST_FLOOR:
            add("tax:ltcg-harvest", "warning" if q4 else "info", "tax",
                f"Book up to {_inr(lt['suggested_booking'])} of long-term gains tax-free",
                f"{_inr(lt['remaining_exemption'])} of this year's ₹1.25L equity LTCG exemption is unused.",
                "Sell and rebuy the same units before 31 March to reset your cost basis.", "/tax", lt["suggested_booking"])
        if opp["loss_harvest_offsettable"] > 500:
            add("tax:loss-harvest", "warning" if q4 else "info", "tax",
                f"Harvest losses to offset {_inr(opp['loss_harvest_offsettable'])} of gains",
                "Holdings below cost can be sold to cancel out capital gains already booked this year.",
                "Review the loss-harvesting list on the Tax page.", "/tax", opp["loss_harvest_offsettable"])
        for l in opp["upcoming_long_term"][:3]:
            if l["days_to_lt"] <= 45 and l["tax_saving"] >= 200:
                add(f"tax:wait-lt:{l['instrument_id']}:{l['date']}", "info", "tax",
                    f"Hold {l['name']} {l['days_to_lt']} more days",
                    f"The lot bought on {l['date']} turns long-term on {l['lt_on']}; selling after that saves about {_inr(l['tax_saving'])}.",
                    None, "/tax", l["tax_saving"])
    for p in positions:
        e = p.get("elss")
        if e and (e.get("unlocked_value") or 0) > 0:
            add(f"elss:unlocked:{p['id']}", "info", "tax", f"{_inr(e['unlocked_value'])} of {p['name']} is out of lock-in",
                f"{e['unlocked_qty']:.2f} units have completed 3 years and can be redeemed or switched.",
                "Use unlocked units for LTCG harvesting or rebalancing.", f"/holding/{p['id']}", e["unlocked_value"])

    # ── Data quality ──
    if totals.get("missing_prices"):
        names = totals["missing_prices"]
        add("data:missing-prices", "warning", "data",
            f"{len(names)} holding{'s have' if len(names) > 1 else ' has'} no live price",
            ", ".join(names[:5]) + (" …" if len(names) > 5 else "") + (" are" if len(names) > 1 else " is") + " valued at cost.",
            "Add a ticker so returns and allocation are accurate.", "/settings#prices")
    stale = []
    for p in open_pos:
        if p["asset_class"] == d.NPS and not p.get("symbol"):
            # A hand-priced NPS NAV gets its own nps:nav-stale row and never counts toward data:stale-prices (G10)
            if (p.get("value") or 0) > 0 and p.get("price_at"):
                try:
                    nav_age = (today - to_date(p["price_at"])).days
                except ValueError:
                    nav_age = None
                if nav_age is not None and nav_age > NPS_NAV_STALE_DAYS:
                    add(f"nps:nav-stale:{p['id']}", "info", "data", f"{p['name']} NAV is {nav_age} days old",
                        "NPS units here are valued at a NAV you entered by hand, so the value may be out of date.",
                        "Update the NAV from your latest NPS statement.", "/nps", p["value"])
            continue
        if p.get("price_at"):
            try:
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(p["price_at"].replace("Z", "+00:00"))).days
                if age > 4:
                    stale.append(p["name"])
            except ValueError:
                pass
    if stale:
        add("data:stale-prices", "info", "data", f"Prices for {len(stale)} holdings are over 4 days old",
            "Refresh prices to see current values.", link="/settings#prices")

    # ── Habits ──
    for p in open_pos:
        if p["asset_class"] == d.MUTUAL_FUND and (p.get("sub_category") or "").upper() == "SIP" and p.get("last_date"):
            gap = (today - to_date(p["last_date"])).days
            if 40 <= gap <= 400:
                add(f"sip:gap:{p['id']}", "info", "habit", f"No SIP in {p['name']} for {gap} days",
                    "If the SIP is still running, record the missing instalments.", None, f"/holding/{p['id']}")
    # SIP plans: an instalment is "missed" when its day has passed by a few days and nothing was bought
    month_start = today.replace(day=1).isoformat()
    bought_inst = {t["instrument_id"] for t in (txns or []) if t["type"] == d.BUY and str(t["date"])[:10] >= month_start}
    seg_of_inst = {p["id"]: p["segment"] for p in positions}
    bought_seg = {seg_of_inst.get(i) for i in bought_inst}
    for s in sips or []:
        if not s.get("active", 1) or (s.get("frequency") or "monthly") != "monthly":
            continue
        if s.get("end_date") and s["end_date"] < today.isoformat():
            continue
        due = int(s.get("day_of_month") or 1)
        if today.day < due + 4:
            continue
        done = (s["instrument_id"] in bought_inst) if s.get("instrument_id") else (s.get("segment") in bought_seg)
        if not done:
            add(f"sip:missed:{s['id']}", "warning", "habit", f"SIP of {_inr(float(s['amount']))} in {s['name']} looks missed",
                f"It was due on the {due}{'st' if due == 1 else 'nd' if due == 2 else 'rd' if due == 3 else 'th'} and no purchase is recorded this month.",
                "Record the instalment if it went through, or pause the plan.", "/recurring", float(s["amount"]))
    last_review = settings.get("lastReviewDate")
    days_since = (today - to_date(last_review)).days if last_review else None
    if days_since is None or days_since > 90:
        add("review:due", "info", "habit", "Time for a portfolio review",
            "A quarterly check of allocation, losers and goals keeps the plan on track."
            + (f" Last review was {days_since} days ago." if days_since else ""),
            "Walk through the quarterly review: what changed, mix, laggards, plan and commitments.",
            "/actions?tab=review")

    # ── Goals ──
    for g in goals:
        pr = g.get("projection") or {}
        if pr.get("status") in ("at_risk", "off_track"):
            extra = (pr.get("required_sip") or 0) - float(g.get("monthly_contribution") or 0)
            add(f"goal:{g['id']}", "warning" if pr["status"] == "off_track" else "info", "goals",
                f"Goal '{g['name']}' is {pr['status'].replace('_', ' ')}",
                f"{pr['probability']:.0f}% chance of reaching {_inr(g['target_amount'])} by {g['target_date']}.",
                f"Raise the monthly contribution by about {_inr(extra)}." if extra > 0 else "Extend the date or adjust the target.",
                f"/plan?tab=goals#goal-{g['id']}", extra if extra > 0 else None)

    # ── Performance ──
    if benchmarks:
        nifty = next((b for b in benchmarks if b["key"] == "NIFTY50"), None)
        if nifty and nifty.get("excess_xirr") is not None and (history_metrics or {}).get("days", 0) >= 180:
            ex = nifty["excess_xirr"]
            if ex <= -3:
                add("perf:vs-nifty", "warning", "performance", f"Trailing Nifty 50 by {abs(ex):.1f}% a year",
                    "The same cash flows invested in a Nifty 50 index fund would be worth "
                    f"{_inr(nifty['end_value'])} today.", "Consider an index core for part of the equity allocation.",
                    "/performance")
            elif ex >= 3:
                add("perf:vs-nifty", "positive", "performance", f"Beating Nifty 50 by {ex:.1f}% a year",
                    "Your money-weighted return is ahead of the same flows invested in the index.", link="/performance")
    if history_metrics and (history_metrics.get("current_drawdown") or 0) <= -10:
        add("perf:drawdown", "info", "performance", f"Portfolio is {abs(history_metrics['current_drawdown']):.1f}% below its peak",
            "Drawdowns are normal; check that allocation still matches your plan.", link="/performance")
    if (totals.get("xirr") or 0) >= 12:
        add("perf:xirr", "positive", "performance", f"Portfolio XIRR is {totals['xirr']:.1f}%",
            "Your money-weighted return is above a typical long-run equity expectation.", link="/performance")

    dismissed = settings.get("dismissedInsights") or {}
    today_s = today.isoformat()
    out = [i for i in out if not (i["id"] in dismissed and dismissed[i["id"]] >= today_s)]
    out.sort(key=lambda i: (SEVERITY_ORDER[i["severity"]], -(i["amount"] or 0)))
    return out
