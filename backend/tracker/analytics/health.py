"""Portfolio health score (0-100): an explainable roll-up of diversification, discipline, risk,
tax efficiency and returns."""
from __future__ import annotations

from collections import defaultdict

from .. import domain as d


def _clamp(v: float) -> float:
    return max(0.0, min(100.0, v))


def health_score(port: dict, tax: dict | None, perf: dict | None) -> dict:
    total = float(port["totals"]["value"] or 0)
    positions = [p for p in port["positions"] if p.get("is_open") and p["asset_class"] != d.CASH]
    comps = []

    # 1. Diversification: largest single holding, top-5 share, number of meaningful segments
    market = [p for p in positions if p["asset_class"] in d.TRADABLE]
    weights = sorted((p["weight"] for p in market), reverse=True)
    top1, top5 = (weights[0] if weights else 0), sum(weights[:5])
    segs = sum(1 for s in port["segments"] if s["pct"] >= 5)
    div = 100 - max(top1 - 8, 0) * 4 - max(top5 - 35, 0) * 1.2 - max(4 - segs, 0) * 10
    comps.append({"key": "diversification", "label": "Diversification", "weight": 25, "score": _clamp(div),
                  "note": f"Largest holding {top1:.1f}%, top five {top5:.0f}%, {segs} asset classes above 5%."})

    # 2. Allocation discipline: distance from targets
    drifts = [abs(s["drift"]) for s in port["segments"] if s.get("drift") is not None]
    if drifts:
        total_drift = sum(drifts)
        disc = 100 - total_drift * 4
        note = f"Total drift from your targets is {total_drift:.1f} points."
    else:
        disc, note = 50, "No target allocation set yet."
    comps.append({"key": "discipline", "label": "Sticking to plan", "weight": 20, "score": _clamp(disc), "note": note})

    # 3. Risk control: concentration in one sector, defaulted lending, unpriced holdings
    eq_val = sum(p["value"] for p in market if p["asset_class"] == d.EQUITY) or 1
    sectors = defaultdict(float)
    for p in market:
        if p["asset_class"] == d.EQUITY:
            sectors[p.get("sector") or "Other"] += p["value"]
    top_sector = max(sectors.values(), default=0) / eq_val * 100
    at_risk = sum(p.get("at_risk") or 0 for p in port["positions"] if p["asset_class"] == d.P2P)
    unpriced = len(port["totals"].get("missing_prices") or [])
    risk = 100 - max(top_sector - 30, 0) * 1.5 - (at_risk / total * 100 if total else 0) * 10 - unpriced * 4
    comps.append({"key": "risk", "label": "Risk control", "weight": 20, "score": _clamp(risk),
                  "note": f"Top stock sector {top_sector:.0f}% of stocks; ₹{at_risk:,.0f} in defaulted loans; {unpriced} unpriced holding(s)."})

    # 4. Tax efficiency: unused harvesting opportunities this year
    if tax:
        opp = tax["opportunities"]
        missed = opp.get("loss_harvest_offsettable", 0) + (opp.get("ltcg_harvest") or {}).get("suggested_booking", 0)
        base = max(total * 0.02, 1)
        tx = 100 - min(missed / base, 1) * 40
        note = (f"About ₹{missed:,.0f} of gains could still be offset or booked tax-free this year."
                if missed > 0 else "No open tax-saving opportunities right now.")
    else:
        tx, note = 70, "Tax data unavailable."
    comps.append({"key": "tax", "label": "Tax efficiency", "weight": 15, "score": _clamp(tx), "note": note})

    # 5. Returns: money-weighted return vs the same flows in Nifty 50 (or absolute XIRR)
    bench = next((b for b in (perf or {}).get("benchmarks", []) if b["key"] == "NIFTY50"), None)
    if bench and bench.get("excess_xirr") is not None:
        ex = bench["excess_xirr"]
        ret = 60 + ex * 4
        note = f"{'Ahead of' if ex >= 0 else 'Behind'} Nifty 50 by {abs(ex):.1f}% a year on the same cash flows."
    else:
        x = port["totals"].get("xirr")
        ret = 50 + (x or 0) * 3
        note = f"Annual return (XIRR) {x if x is not None else '—'}%."
    comps.append({"key": "returns", "label": "Returns", "weight": 20, "score": _clamp(ret), "note": note})

    score = sum(c["score"] * c["weight"] for c in comps) / sum(c["weight"] for c in comps)
    for c in comps:
        c["score"] = round(c["score"])
    grade = "Excellent" if score >= 85 else "Good" if score >= 70 else "Fair" if score >= 55 else "Needs care"
    weakest = min(comps, key=lambda c: c["score"])
    return {"score": round(score), "grade": grade, "components": comps,
            "focus": {"key": weakest["key"], "label": weakest["label"], "note": weakest["note"]}}
