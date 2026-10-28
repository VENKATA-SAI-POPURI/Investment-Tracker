"""Goal projections and rebalancing plans."""
from __future__ import annotations

import json
import math
import random
from datetime import date

from .. import domain as d

# Long-run planning assumptions per segment: (expected annual return, annual volatility)
ASSUMPTIONS = {
    d.SEG_EQ_IN: (0.12, 0.18),
    d.SEG_EQ_US: (0.11, 0.17),
    d.SEG_MF: (0.11, 0.15),
    d.SEG_COMMODITY: (0.08, 0.15),
    d.SEG_P2P: (0.10, 0.06),
    d.SEG_FD: (0.07, 0.01),
}


def _months_between(a: date, b: date) -> int:
    return max((b.year - a.year) * 12 + (b.month - a.month), 0)


def parse_allocation(raw) -> dict[str, float]:
    if not raw:
        return {}
    alloc = json.loads(raw) if isinstance(raw, str) else raw
    return {k: float(v) for k, v in alloc.items() if float(v or 0) > 0}


def project_goal(goal: dict, segments: list[dict], today: date | None = None, sims: int = 1000) -> dict:
    today = today or date.today()
    alloc = parse_allocation(goal.get("allocation"))
    seg_val = {s["segment"]: float(s["value"] or 0) for s in segments}
    current = sum(seg_val.get(seg, 0.0) * pct / 100 for seg, pct in alloc.items())

    # Blend expected return/volatility from the linked segments (weighted by current value)
    weights = {seg: seg_val.get(seg, 0.0) * pct / 100 for seg, pct in alloc.items()}
    wsum = sum(weights.values()) or sum(alloc.values()) or 1.0
    if not sum(weights.values()):
        weights = {seg: pct for seg, pct in alloc.items()}
    mu = sum(ASSUMPTIONS.get(s, (0.10, 0.12))[0] * w for s, w in weights.items()) / wsum if weights else 0.10
    sigma = sum(ASSUMPTIONS.get(s, (0.10, 0.12))[1] * w for s, w in weights.items()) / wsum if weights else 0.12
    if goal.get("expected_return") not in (None, ""):
        mu = float(goal["expected_return"]) / 100

    target = float(goal["target_amount"])
    target_date = date.fromisoformat(str(goal["target_date"])[:10])
    months = _months_between(today, target_date)
    sip = float(goal.get("monthly_contribution") or 0)
    rm = (1 + mu) ** (1 / 12) - 1

    def fv(pv, pmt, n):
        if n <= 0:
            return pv
        growth = (1 + rm) ** n
        return pv * growth + (pmt * (growth - 1) / rm if rm else pmt * n)

    projected = fv(current, sip, months)
    gap = target - fv(current, 0, months)
    if months <= 0:
        required_sip = None
    elif gap <= 0:
        required_sip = 0.0
    else:
        required_sip = gap * rm / ((1 + rm) ** months - 1) if rm else gap / months

    # Monte Carlo: monthly log-normal returns
    rng = random.Random(goal.get("id") or 7)
    m_mu = math.log(1 + mu) / 12
    m_sd = sigma / math.sqrt(12)
    hits, finals = 0, []
    for _ in range(sims if months > 0 else 0):
        v = current
        for _ in range(months):
            v = v * math.exp(rng.gauss(m_mu - m_sd * m_sd / 2, m_sd)) + sip
        finals.append(v)
        hits += v >= target
    finals.sort()
    prob = hits / sims if months > 0 else (1.0 if current >= target else 0.0)

    path = []
    for y in range(0, months // 12 + 2):
        n = min(y * 12, months)
        path.append({"date": date(today.year + n // 12 + (today.month - 1 + n % 12) // 12,
                                  (today.month - 1 + n % 12) % 12 + 1, 1).isoformat(),
                     "projected": round(fv(current, sip, n), 2), "contributed": round(current + sip * n, 2)})
        if n == months:
            break

    progress = current / target * 100 if target else 0.0
    status = "achieved" if current >= target else ("on_track" if prob >= 0.75 else "at_risk" if prob >= 0.4 else "off_track")
    return {
        "current": round(current, 2), "progress_pct": round(min(progress, 100), 2), "months_left": months,
        "expected_return": round(mu * 100, 2), "volatility": round(sigma * 100, 2),
        "projected": round(projected, 2), "shortfall": round(max(target - projected, 0), 2),
        "required_sip": round(required_sip, 2) if required_sip is not None else None,
        "probability": round(prob * 100, 1), "status": status,
        "p10": round(finals[int(len(finals) * 0.1)], 2) if finals else None,
        "p50": round(finals[len(finals) // 2], 2) if finals else None,
        "p90": round(finals[int(len(finals) * 0.9)], 2) if finals else None,
        "path": path,
    }


def rebalance_plan(segments: list[dict], targets: dict, new_money: float = 0.0, allow_sell: bool = False) -> dict:
    """Amounts to add (and optionally trim) per segment to move toward target weights."""
    cur = {s["segment"]: float(s["value"] or 0) for s in segments}
    tsum = sum(float(v) for v in targets.values()) or 100.0
    tw = {k: float(v) / tsum for k, v in targets.items()}
    total = sum(cur.values())
    final_total = total + new_money
    ideal = {k: final_total * w for k, w in tw.items()}
    rows = []
    if allow_sell:
        for seg in sorted(set(cur) | set(tw)):
            diff = ideal.get(seg, 0.0) - cur.get(seg, 0.0)
            rows.append({"segment": seg, "current": round(cur.get(seg, 0.0), 2), "target_pct": round(tw.get(seg, 0) * 100, 2),
                         "action": "buy" if diff > 0 else "sell" if diff < 0 else "hold", "amount": round(abs(diff), 2)})
    else:
        # Distribute new money to the most under-weight segments only (no selling, no tax)
        deficits = {k: max(ideal.get(k, 0.0) - cur.get(k, 0.0), 0.0) for k in tw}
        dsum = sum(deficits.values())
        for seg in sorted(set(cur) | set(tw)):
            add = new_money * deficits.get(seg, 0.0) / dsum if dsum > 0 else new_money * tw.get(seg, 0.0)
            rows.append({"segment": seg, "current": round(cur.get(seg, 0.0), 2), "target_pct": round(tw.get(seg, 0) * 100, 2),
                         "action": "buy" if add > 0.5 else "hold", "amount": round(add, 2)})
    after = {r["segment"]: r["current"] + (r["amount"] if r["action"] == "buy" else -r["amount"] if r["action"] == "sell" else 0)
             for r in rows}
    atot = sum(after.values()) or 1.0
    for r in rows:
        r["current_pct"] = round(r["current"] / total * 100, 2) if total else 0.0
        r["after_pct"] = round(after[r["segment"]] / atot * 100, 2)
    needed = sum(max(ideal.get(k, 0) - cur.get(k, 0), 0) for k in tw)
    # New money that would fully fix allocation without selling
    worst = max(((cur.get(k, 0.0) / w) for k, w in tw.items() if w > 0), default=total)
    return {"rows": rows, "total": round(total, 2), "new_money": round(new_money, 2), "allow_sell": allow_sell,
            "shortfall_to_targets": round(needed, 2), "money_to_fix_without_selling": round(max(worst - total, 0), 2)}
