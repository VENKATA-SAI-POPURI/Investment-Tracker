"""Rule-based insights & suggestions. Every insight is explainable and links to where to act."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timezone

from .. import domain as d
from .portfolio import to_date

SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2, "positive": 3}


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
                   today: date | None = None) -> list[dict]:
    today = today or date.today()
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

    # ── Allocation drift ──
    for s in segments:
        if s.get("target") is None or s.get("drift") is None:
            continue
        drift = s["drift"]
        if abs(drift) >= 2.5:
            amt = abs(drift) / 100 * total
            over = drift > 0
            add(f"drift:{s['segment']}", "warning" if abs(drift) >= 5 else "info", "allocation",
                f"{s['segment']} is {abs(drift):.1f} pts {'above' if over else 'below'} target",
                f"Now {s['pct']:.1f}% vs target {s['target']}% — about {_inr(amt)} {'too much' if over else 'short'}.",
                "Route new investments to under-weight segments, or trim this one." if over
                else f"Direct your next {_inr(amt)} of investments here.", "/insights#rebalance", amt)
    if not any(s.get("target") is not None for s in segments):
        add("targets:missing", "info", "allocation", "Set target allocation",
            "Targets let the app flag drift and plan rebalancing for you.", link="/settings")

    open_pos = [p for p in positions if p.get("is_open") and p["asset_class"] != d.CASH]

    # ── Concentration ──
    for p in open_pos:
        limit_w, limit_i = (25, 15) if p["asset_class"] == d.MUTUAL_FUND else (15, 10)
        if p["asset_class"] in (d.P2P, d.FIXED_DEPOSIT):
            continue
        if p["weight"] >= limit_i:
            add(f"concentration:{p['id']}", "warning" if p["weight"] >= limit_w else "info", "risk",
                f"{p['name']} is {p['weight']:.1f}% of your portfolio",
                "A single position this large can dominate your returns.",
                "Consider capping any one holding near 10% of the portfolio.", f"/holdings/{p['id']}", p["value"])
    equity_val = sum(p["value"] for p in open_pos if p["asset_class"] == d.EQUITY)
    by_sector = defaultdict(float)
    for p in open_pos:
        if p["asset_class"] == d.EQUITY:
            by_sector[p.get("sector") or "Unclassified"] += p["value"]
    for sector, v in by_sector.items():
        share = v / equity_val * 100 if equity_val else 0
        if share >= 30 and sector != "Unclassified":
            add(f"sector:{sector}", "warning" if share >= 40 else "info", "risk",
                f"{sector} is {share:.0f}% of your stocks", f"{_inr(v)} of {_inr(equity_val)} in direct equity sits in one sector.",
                "Spread new stock purchases across other sectors.", "/analytics#risk", v)
    stocks = [p for p in open_pos if p["asset_class"] == d.EQUITY]
    if 0 < len(stocks) < 5:
        add("diversification:stocks", "info", "risk", f"Only {len(stocks)} direct stocks",
            "With few stocks, one bad result moves the whole equity book.", "Index funds can add breadth cheaply.")

    # ── Winners & losers ──
    for p in open_pos:
        up, held = p.get("unrealized_pct"), (today - to_date(p["first_date"])).days if p.get("first_date") else 0
        if up is None:
            continue
        if up <= -20 and held >= 180:
            add(f"loser:{p['id']}", "warning", "performance", f"{p['name']} is down {abs(up):.0f}%",
                f"Unrealized loss of {_inr(-p['unrealized'])} after {held // 30} months.",
                "Re-check the reason you bought it; selling also books a tax loss.", f"/holdings/{p['id']}", -p["unrealized"])
        elif up >= 50 and p["weight"] >= 5:
            add(f"winner:{p['id']}", "info", "performance", f"{p['name']} is up {up:.0f}%",
                f"It has grown to {p['weight']:.1f}% of the portfolio.",
                "Consider booking partial profits to stay near your targets.", f"/holdings/{p['id']}", p["unrealized"])

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
        if lt["suggested_booking"] > 1000:
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
                "Use unlocked units for LTCG harvesting or rebalancing.", f"/holdings/{p['id']}", e["unlocked_value"])

    # ── Data quality ──
    if totals.get("missing_prices"):
        names = totals["missing_prices"]
        add("data:missing-prices", "warning", "data", f"{len(names)} holdings have no live price",
            ", ".join(names[:5]) + (" …" if len(names) > 5 else "") + " are valued at cost.",
            "Add a ticker so returns and allocation are accurate.", "/settings#prices")
    stale = []
    for p in open_pos:
        if p.get("price_at"):
            try:
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(p["price_at"].replace("Z", "+00:00"))).days
                if age > 4:
                    stale.append(p["name"])
            except ValueError:
                pass
    if stale:
        add("data:stale-prices", "info", "data", f"Prices for {len(stale)} holdings are over 4 days old",
            "Refresh prices to see current values.", link="/")

    # ── Habits ──
    for p in open_pos:
        if p["asset_class"] == d.MUTUAL_FUND and (p.get("sub_category") or "").upper() == "SIP" and p.get("last_date"):
            gap = (today - to_date(p["last_date"])).days
            if 40 <= gap <= 400:
                add(f"sip:gap:{p['id']}", "info", "habit", f"No SIP in {p['name']} for {gap} days",
                    "If the SIP is still running, record the missing instalments.", None, f"/holdings/{p['id']}")
    last_review = settings.get("lastReviewDate")
    days_since = (today - to_date(last_review)).days if last_review else None
    if days_since is None or days_since > 90:
        add("review:due", "info", "habit", "Time for a portfolio review",
            "A quarterly check of allocation, losers and goals keeps the plan on track."
            + (f" Last review was {days_since} days ago." if days_since else ""),
            "Open the rebalancing planner.", "/insights#rebalance")

    # ── Goals ──
    for g in goals:
        pr = g.get("projection") or {}
        if pr.get("status") in ("at_risk", "off_track"):
            extra = (pr.get("required_sip") or 0) - float(g.get("monthly_contribution") or 0)
            add(f"goal:{g['id']}", "warning" if pr["status"] == "off_track" else "info", "goals",
                f"Goal '{g['name']}' is {pr['status'].replace('_', ' ')}",
                f"{pr['probability']:.0f}% chance of reaching {_inr(g['target_amount'])} by {g['target_date']}.",
                f"Raise the monthly contribution by about {_inr(extra)}." if extra > 0 else "Extend the date or adjust the target.",
                "/goals", extra if extra > 0 else None)

    # ── Performance ──
    if benchmarks:
        nifty = next((b for b in benchmarks if b["key"] == "NIFTY50"), None)
        if nifty and nifty.get("excess_xirr") is not None and (history_metrics or {}).get("days", 0) >= 180:
            ex = nifty["excess_xirr"]
            if ex <= -3:
                add("perf:vs-nifty", "warning", "performance", f"Trailing Nifty 50 by {abs(ex):.1f}% a year",
                    "The same cash flows invested in a Nifty 50 index fund would be worth "
                    f"{_inr(nifty['end_value'])} today.", "Consider an index core for part of the equity allocation.",
                    "/analytics")
            elif ex >= 3:
                add("perf:vs-nifty", "positive", "performance", f"Beating Nifty 50 by {ex:.1f}% a year",
                    "Your money-weighted return is ahead of the same flows invested in the index.", link="/analytics")
    if history_metrics and (history_metrics.get("current_drawdown") or 0) <= -10:
        add("perf:drawdown", "info", "performance", f"Portfolio is {abs(history_metrics['current_drawdown']):.1f}% below its peak",
            "Drawdowns are normal; check that allocation still matches your plan.", link="/analytics")
    if (totals.get("xirr") or 0) >= 12:
        add("perf:xirr", "positive", "performance", f"Portfolio XIRR is {totals['xirr']:.1f}%",
            "Your money-weighted return is above a typical long-run equity expectation.", link="/analytics")

    dismissed = settings.get("dismissedInsights") or {}
    today_s = today.isoformat()
    out = [i for i in out if not (i["id"] in dismissed and dismissed[i["id"]] >= today_s)]
    out.sort(key=lambda i: (SEVERITY_ORDER[i["severity"]], -(i["amount"] or 0)))
    return out
