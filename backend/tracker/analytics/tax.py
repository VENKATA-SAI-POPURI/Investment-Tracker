"""Indian capital-gains estimate per financial year, plus harvesting opportunities.

Rules encoded (resident individual, as amended by Finance (No.2) Act 2024):
  * Listed equity / equity MFs (s.111A/112A): long-term if held > 12 months.
    STCG 20% (15% for transfers before 23-Jul-2024); LTCG 12.5% (10% before) above an annual
    exemption of ₹1.25 lakh (₹1 lakh up to FY2023-24).
  * Foreign equity / overseas FoFs: long-term if held > 24 months, LTCG 12.5% (20% before
    23-Jul-2024); short-term gains at slab rate.
  * Other listed units (gold/silver ETFs): long-term if held > 12 months, LTCG 12.5%; STCG at slab.
  * Specified (debt) MFs: slab rate regardless of holding period.
  * Same-day equity round trips: speculative business income at slab rate.
  * Short-term losses set off against any capital gain; long-term losses only against LTCG.
  * Health & education cess 4% on the computed tax. Surcharge is not modelled.
This is an estimate for planning, not tax advice.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from .. import domain as d
from .portfolio import to_date, _f

CUTOFF = "2024-07-23"
CESS = 0.04
EQUITY_EXEMPTION_NEW = 125000.0
EQUITY_EXEMPTION_OLD = 100000.0


def rule_for(tax_class: str, sell_date: str) -> dict:
    post = sell_date >= CUTOFF
    if tax_class == d.TAX_EQUITY:
        return {"lt_days": 365, "st_rate": 0.20 if post else 0.15, "lt_rate": 0.125 if post else 0.10, "exempt": True}
    if tax_class == d.TAX_FOREIGN:
        return {"lt_days": 730, "st_rate": None, "lt_rate": 0.125 if post else 0.20, "exempt": False}
    if tax_class == d.TAX_LISTED_OTHER:
        return {"lt_days": 365 if post else 1095, "st_rate": None, "lt_rate": 0.125 if post else 0.20, "exempt": False}
    return {"lt_days": None, "st_rate": None, "lt_rate": None, "exempt": False}  # debt / other: slab


def exemption_for(fy: str) -> float:
    return EQUITY_EXEMPTION_NEW if int(fy[2:6]) >= 2024 else EQUITY_EXEMPTION_OLD


def classify(tax_class: str, buy_date: str, sell_date: str, intraday: bool) -> tuple[str, float | None, bool]:
    """-> (term, rate or None for slab, eligible for equity exemption)"""
    if intraday and tax_class == d.TAX_EQUITY:
        return "Intraday", None, False
    r = rule_for(tax_class, sell_date)
    held = (to_date(sell_date) - to_date(buy_date)).days
    if r["lt_days"] is not None and held > r["lt_days"]:
        return "LTCG", r["lt_rate"], r["exempt"]
    return "STCG", r["st_rate"], False


def compute_tax(portfolio: dict, txns: list[dict], instruments: list[dict], fy: str, slab_rate: float,
                today: date | None = None) -> dict:
    today = today or date.today()
    inst = {i["id"]: i for i in instruments}
    start, end = d.fy_bounds(fy)

    # ── realized gains in FY ──
    lots = []
    for r in portfolio["realized_lots"]:
        if not (start <= r["sell_date"] <= end):
            continue
        i = inst.get(r["instrument_id"]) or {}
        tc = i.get("tax_class") or d.default_tax_class(i.get("asset_class", ""), i.get("market"), i.get("category"), i.get("name"))
        term, rate, exempt = classify(tc, r["buy_date"], r["sell_date"], r["intraday"])
        lots.append({
            "instrument_id": r["instrument_id"], "name": i.get("name"), "asset_class": i.get("asset_class"),
            "tax_class": tc, "buy_date": r["buy_date"], "sell_date": r["sell_date"], "holding_days": r["holding_days"],
            "qty": round(r["qty"], 6), "cost": round(r["cost"], 2), "proceeds": round(r["proceeds"], 2),
            "gain": round(r["gain"], 2), "term": term, "rate": rate, "exempt_eligible": exempt,
        })

    # buckets keyed by (term_group, rate, exempt) — slab buckets use rate=slab
    buckets: dict[tuple, float] = defaultdict(float)
    for l in lots:
        group = "LT" if l["term"] == "LTCG" else "ST"
        rate = l["rate"] if l["rate"] is not None else slab_rate
        buckets[(group, rate, l["exempt_eligible"])] += l["gain"]

    st_loss = -sum(v for (g, _, _), v in buckets.items() if g == "ST" and v < 0)
    lt_loss = -sum(v for (g, _, _), v in buckets.items() if g == "LT" and v < 0)
    gains = {k: v for k, v in buckets.items() if v > 0}

    def offset(loss: float, keys: list[tuple]) -> float:
        # highest-rate gains first; within LT, non-exempt before exempt (the exemption shields the rest)
        for k in sorted(keys, key=lambda k: (-k[1], k[2])):
            if loss <= 0:
                break
            used = min(gains[k], loss)
            gains[k] -= used
            loss -= used
        return loss

    lt_loss_left = offset(lt_loss, [k for k in gains if k[0] == "LT"])
    st_loss_left = offset(st_loss, list(gains))
    exemption = exemption_for(fy)
    exempt_gain = sum(v for k, v in gains.items() if k[2])
    exemption_used = min(exemption, exempt_gain)
    remaining_exemption = exemption - exemption_used
    exempt_left = exemption_used
    tax = 0.0
    lines = []
    for k in sorted(gains, key=lambda k: (k[0], -k[1])):
        group, rate, exempt = k
        taxable = gains[k]
        if exempt and exempt_left > 0:
            cut = min(taxable, exempt_left)
            taxable -= cut
            exempt_left -= cut
        if taxable <= 0:
            continue
        tax += taxable * rate
        lines.append({"group": group, "rate": round(rate * 100, 2), "taxable": round(taxable, 2),
                      "tax": round(taxable * rate, 2), "slab": rate == slab_rate and not exempt})

    summary = defaultdict(float)
    for l in lots:
        cls = {d.TAX_EQUITY: "equity", d.TAX_FOREIGN: "foreign", d.TAX_LISTED_OTHER: "other", d.TAX_DEBT: "debt"}.get(l["tax_class"], "other")
        summary[f"{cls}_{l['term'].lower()}"] += l["gain"]

    # ── income in FY (taxed at slab) ──
    income = defaultdict(float)
    for t in txns:
        ds = str(t["date"])[:10]
        if not (start <= ds <= end):
            continue
        i = inst.get(t["instrument_id"]) or {}
        if t["type"] == d.DIVIDEND:
            income["dividends"] += _f(t["amount"])
        elif t["type"] == d.REPAYMENT:
            income["p2p_interest"] += _f(t["amount"]) - _f(t["principal"])
        elif t["type"] == d.INTEREST:
            income["fd_interest"] += _f(t["amount"])
        elif t["type"] == d.MATURITY:
            income["fd_interest"] += _f(t["amount"]) - _f(t["principal"])
    income_total = sum(income.values())
    income_tax = income_total * slab_rate
    cg_tax = tax
    total_tax = (cg_tax + income_tax) * (1 + CESS)

    return {
        "fy": fy, "start": start, "end": end, "slab_rate": round(slab_rate * 100, 2),
        "realized": sorted(lots, key=lambda l: l["sell_date"]),
        "summary": {k: round(v, 2) for k, v in summary.items()},
        "total_realized": round(sum(l["gain"] for l in lots), 2),
        "set_off": {"st_loss": round(st_loss, 2), "lt_loss": round(lt_loss, 2),
                    "carry_forward_st": round(st_loss_left, 2), "carry_forward_lt": round(lt_loss_left, 2)},
        "equity_exemption": {"limit": exemption, "used": round(exemption_used, 2), "remaining": round(remaining_exemption, 2)},
        "tax_lines": lines,
        "income": {k: round(v, 2) for k, v in income.items()}, "income_total": round(income_total, 2),
        "estimate": {"capital_gains_tax": round(cg_tax, 2), "income_tax": round(income_tax, 2),
                     "cess": round((cg_tax + income_tax) * CESS, 2), "total": round(total_tax, 2)},
        "opportunities": harvesting(portfolio, instruments, remaining_exemption, slab_rate, today,
                                    realized_gain=sum(v for v in buckets.values() if v > 0),
                                    is_current_fy=start <= today.isoformat() <= end),
    }


def open_lot_view(portfolio: dict, instruments: list[dict], today: date) -> list[dict]:
    """Per open lot: market value at the current price, gain, term today and date it turns long-term."""
    inst = {i["id"]: i for i in instruments}
    fx = portfolio.get("usd_inr") or 0.0
    out = []
    for p in portfolio["positions"]:
        if p["asset_class"] not in d.TRADABLE or not p.get("is_open") or not p.get("has_price"):
            continue
        i = inst[p["id"]]
        mult = fx if p.get("currency") == "USD" else 1.0
        tc = i.get("tax_class") or d.TAX_EQUITY
        r = rule_for(tc, today.isoformat())
        for lot in p["open_lots"]:
            value = lot["qty"] * p["price"] * mult
            gain = value - lot["cost"]
            held = (today - to_date(lot["date"])).days
            lt_on = to_date(lot["date"]) + timedelta(days=r["lt_days"] + 1) if r["lt_days"] is not None else None
            out.append({
                "instrument_id": p["id"], "name": p["name"], "tax_class": tc, "date": lot["date"], "qty": lot["qty"],
                "cost": lot["cost"], "value": round(value, 2), "gain": round(gain, 2), "held_days": held,
                "term": "LTCG" if lt_on and today >= lt_on else "STCG", "lt_on": lt_on.isoformat() if lt_on else None,
                "days_to_lt": (lt_on - today).days if lt_on and today < lt_on else 0,
                "st_rate": r["st_rate"], "lt_rate": r["lt_rate"],
                "locked_until": (to_date(lot["date"]).replace(year=to_date(lot["date"]).year + 3).isoformat()
                                 if (i.get("category") or "").upper() == "ELSS" else None),
            })
    return out


def harvesting(portfolio: dict, instruments: list[dict], remaining_exemption: float, slab_rate: float,
               today: date, realized_gain: float, is_current_fy: bool) -> dict:
    lots = open_lot_view(portfolio, instruments, today)
    sellable = [l for l in lots if not l["locked_until"] or l["locked_until"] <= today.isoformat()]

    # Loss harvesting: book losses to offset realized gains this year
    loss_by_inst: dict[int, dict] = {}
    for l in sellable:
        if l["gain"] >= 0:
            continue
        e = loss_by_inst.setdefault(l["instrument_id"], {"instrument_id": l["instrument_id"], "name": l["name"],
                                                          "st_loss": 0.0, "lt_loss": 0.0, "qty": 0.0})
        e["st_loss" if l["term"] == "STCG" else "lt_loss"] += -l["gain"]
        e["qty"] += l["qty"]
    loss_list = sorted(loss_by_inst.values(), key=lambda e: -(e["st_loss"] + e["lt_loss"]))
    for e in loss_list:
        e["st_loss"], e["lt_loss"], e["qty"] = round(e["st_loss"], 2), round(e["lt_loss"], 2), round(e["qty"], 6)
    total_loss = sum(e["st_loss"] + e["lt_loss"] for e in loss_list)

    # LTCG harvesting: realise long-term equity gains inside the tax-free limit and rebuy
    lt_equity = [l for l in sellable if l["tax_class"] == d.TAX_EQUITY and l["term"] == "LTCG" and l["gain"] > 0]
    lt_equity_gain = sum(l["gain"] for l in lt_equity)
    harvestable = min(lt_equity_gain, remaining_exemption) if is_current_fy else 0.0

    # Lots about to turn long-term: waiting avoids the short-term rate
    upcoming = []
    for l in lots:
        if l["gain"] > 0 and 0 < l["days_to_lt"] <= 90:
            st = l["st_rate"] if l["st_rate"] is not None else slab_rate
            saving = l["gain"] * (st - (l["lt_rate"] or 0))
            if saving > 0:
                upcoming.append({**l, "tax_saving": round(saving, 2)})
    upcoming.sort(key=lambda l: l["days_to_lt"])

    return {
        "loss_harvest": loss_list, "loss_harvest_total": round(total_loss, 2),
        "loss_harvest_offsettable": round(min(total_loss, realized_gain), 2),
        "ltcg_harvest": {"unrealized_lt_equity_gain": round(lt_equity_gain, 2), "remaining_exemption": round(remaining_exemption, 2),
                         "suggested_booking": round(harvestable, 2), "future_tax_saved": round(harvestable * 0.125, 2),
                         "lots": sorted(lt_equity, key=lambda l: -l["gain"])[:20]},
        "upcoming_long_term": upcoming[:20],
        "open_lots": lots,
    }
