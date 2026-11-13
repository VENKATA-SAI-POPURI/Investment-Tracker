"""Allocation lab: an efficient frontier over the asset-class segments and a suggested mix per risk profile.

Mean-variance over the eight segments using the long-run return/volatility assumptions in
goals.ASSUMPTIONS and a fixed correlation matrix. EPF and NPS are locked money, so they stay at
their current weight and the optimiser works on the rest. Pure Python: random search over the
simplex plus a local refinement, which is plenty for eight variables.
"""
from __future__ import annotations

import math
import random

from .. import domain as d
from .goals import ASSUMPTIONS

LOCKED = (d.SEG_EPF, d.SEG_NPS)
# Caps on the liquid mix, as a share of the whole portfolio: credit and single-commodity risk stay bounded
CAPS = {d.SEG_P2P: 0.10, d.SEG_COMMODITY: 0.20, d.SEG_EQ_US: 0.35}
KEEP_SHARE = 0.5  # an asset class you already hold keeps at least this share of its current weight
RISK_FREE = 0.065

_ORDER = list(d.SEGMENTS)
_CORR_ROWS = {
    #                 EQ_IN EQ_US  MF   COMM  P2P   FD   EPF   NPS
    d.SEG_EQ_IN:     (1.00, 0.55, 0.90, -0.05, 0.05, 0.00, 0.00, 0.70),
    d.SEG_EQ_US:     (0.55, 1.00, 0.55, 0.00, 0.05, 0.00, 0.00, 0.40),
    d.SEG_MF:        (0.90, 0.55, 1.00, -0.05, 0.05, 0.05, 0.00, 0.75),
    d.SEG_COMMODITY: (-0.05, 0.00, -0.05, 1.00, 0.00, 0.00, 0.00, 0.00),
    d.SEG_P2P:       (0.05, 0.05, 0.05, 0.00, 1.00, 0.10, 0.00, 0.05),
    d.SEG_FD:        (0.00, 0.00, 0.05, 0.00, 0.10, 1.00, 0.20, 0.10),
    d.SEG_EPF:       (0.00, 0.00, 0.00, 0.00, 0.00, 0.20, 1.00, 0.10),
    d.SEG_NPS:       (0.70, 0.40, 0.75, 0.00, 0.05, 0.10, 0.10, 1.00),
}
PROFILES = [
    {"key": "conservative", "label": "Conservative", "target_vol": 0.06, "note": "Capital first; FDs and EPF carry the weight."},
    {"key": "balanced", "label": "Balanced", "target_vol": 0.09, "note": "Half growth, half ballast."},
    {"key": "growth", "label": "Growth", "target_vol": 0.12, "note": "Mostly equity, with some cushion."},
    {"key": "aggressive", "label": "Aggressive", "target_vol": 0.15, "note": "Equity-heavy; large swings accepted."},
]


def _stats(w: dict[str, float]) -> tuple[float, float]:
    ret = sum(ASSUMPTIONS.get(k, (0.10, 0.12))[0] * x for k, x in w.items())
    var = 0.0
    for a, xa in w.items():
        if xa <= 0:
            continue
        sa = ASSUMPTIONS.get(a, (0.10, 0.12))[1]
        ia = _ORDER.index(a) if a in _ORDER else None
        for b, xb in w.items():
            if xb <= 0:
                continue
            sb = ASSUMPTIONS.get(b, (0.10, 0.12))[1]
            ib = _ORDER.index(b) if b in _ORDER else None
            rho = 1.0 if a == b else (_CORR_ROWS[a][ib] if ia is not None and ib is not None else 0.2)
            var += xa * xb * sa * sb * rho
    return ret, math.sqrt(max(var, 0.0))


def _ok(w: dict[str, float], floors: dict[str, float] | None = None) -> bool:
    if not all(w.get(k, 0.0) <= cap + 1e-9 for k, cap in CAPS.items()):
        return False
    return all(w.get(k, 0.0) >= f - 1e-9 for k, f in (floors or {}).items())


def floors_for(current: dict[str, float], liquid: list[str], free: float) -> dict[str, float]:
    """No existing asset class drops below half its current weight: the lab nudges, it does not liquidate.
    Scaled down if the floors would not leave room to move."""
    floors = {k: current.get(k, 0.0) * KEEP_SHARE for k in liquid if current.get(k, 0.0) > 0.005}
    tot = sum(floors.values())
    if tot > free * 0.8 and tot > 0:
        floors = {k: v * free * 0.8 / tot for k, v in floors.items()}
    return floors


def efficient_frontier(current: dict[str, float], liquid: list[str], free: float, rng: random.Random, samples: int = 3000,
                       floors: dict[str, float] | None = None) -> list[dict]:
    """Candidate mixes of the liquid segments summing to `free`, with the locked ones held; returns the
    Pareto frontier (highest return at each level of risk), low risk first."""
    locked = {k: v for k, v in current.items() if k in LOCKED and v > 0}
    floors = floors or {}
    room = free - sum(floors.values())
    cands = []

    def add(parts: dict[str, float]):
        w = {**locked, **{k: v for k, v in parts.items() if v > 1e-6}}
        if not _ok(w, floors):
            return
        r, s = _stats(w)
        cands.append((s, r, w))

    add({k: v for k, v in current.items() if k in liquid})
    for seg in liquid:
        add({**floors, seg: floors.get(seg, 0.0) + room})
    for _ in range(samples):
        g = [rng.gammavariate(0.7, 1.0) for _ in liquid]
        tot = sum(g) or 1.0
        add({k: floors.get(k, 0.0) + room * x / tot for k, x in zip(liquid, g)})
    cands.sort(key=lambda c: (c[0], -c[1]))
    frontier, best = [], -1e9
    for s, r, w in cands:
        if r > best + 1e-6:
            frontier.append({"vol": s, "ret": r, "weights": w})
            best = r
    return frontier


def _refine(w: dict[str, float], liquid: list[str], target_vol: float, rng: random.Random, locked: dict, steps: int = 300,
            floors: dict[str, float] | None = None) -> dict[str, float]:
    """Hill-climb: move weight between two liquid segments while return rises and risk stays under target."""
    best = dict(w)
    best_ret, best_vol = _stats(best)
    for _ in range(steps):
        a, b = rng.sample(liquid, 2) if len(liquid) >= 2 else (liquid[0], liquid[0])
        if a == b:
            break
        amt = min(best.get(a, 0.0) - (floors or {}).get(a, 0.0), rng.uniform(0.005, 0.05))
        if amt <= 0:
            continue
        cand = dict(best)
        cand[a] = cand.get(a, 0.0) - amt
        cand[b] = cand.get(b, 0.0) + amt
        cand = {k: v for k, v in {**cand, **locked}.items() if v > 1e-9}
        if not _ok(cand, floors):
            continue
        r, s = _stats(cand)
        if s <= target_vol + 1e-9 and r > best_ret + 1e-9:
            best, best_ret, best_vol = cand, r, s
    return best


def suggest(port: dict, profile: str = "balanced", seed: int = 11) -> dict:
    """Suggested allocation for a risk profile, the frontier it sits on and the trades to get there."""
    segs = {s["segment"]: float(s.get("value") or 0) for s in port["segments"]}
    total = sum(v for v in segs.values() if v > 0)
    prof = next((p for p in PROFILES if p["key"] == profile), PROFILES[1])
    if total <= 0:
        return {"total": 0.0, "profile": prof, "profiles": PROFILES, "current": None, "suggested": None, "rows": [], "frontier": [],
                "note": "Add investments first."}
    current = {k: v / total for k, v in segs.items() if v > 0}
    locked = {k: v for k, v in current.items() if k in LOCKED}
    free = 1.0 - sum(locked.values())
    liquid = [s for s in d.SEGMENTS if s not in LOCKED]
    rng = random.Random(seed)
    floors = floors_for(current, liquid, free)
    frontier = efficient_frontier(current, liquid, free, rng, floors=floors)
    cur_ret, cur_vol = _stats(current)

    def pick(target_vol: float) -> dict[str, float]:
        under = [f for f in frontier if f["vol"] <= target_vol]
        base = max(under, key=lambda f: f["ret"]) if under else min(frontier, key=lambda f: f["vol"])
        return _refine(base["weights"], liquid, max(target_vol, base["vol"]), rng, locked, floors=floors)

    profiles_out = []
    for p in PROFILES:
        w = pick(p["target_vol"])
        r, s = _stats(w)
        profiles_out.append({**p, "target_vol_pct": round(p["target_vol"] * 100, 1), "return_pct": round(r * 100, 2), "vol_pct": round(s * 100, 2),
                             "weights": {k: round(v * 100, 1) for k, v in sorted(w.items(), key=lambda kv: -kv[1])}})
    chosen = next(p for p in profiles_out if p["key"] == prof["key"])
    sug = {k: v / 100 for k, v in chosen["weights"].items()}
    rows = []
    for seg in d.SEGMENTS:
        c, s = current.get(seg, 0.0), sug.get(seg, 0.0)
        if c <= 0 and s <= 0:
            continue
        rows.append({"segment": seg, "locked": seg in LOCKED, "current_pct": round(c * 100, 1), "suggested_pct": round(s * 100, 1),
                     "delta_pct": round((s - c) * 100, 1), "delta_amount": round((s - c) * total, 2),
                     "action": "hold" if abs(s - c) < 0.015 or seg in LOCKED else "add" if s > c else "trim"})
    rows.sort(key=lambda r: -abs(r["delta_amount"]))
    sug_ret, sug_vol = _stats({**locked, **{k: v for k, v in sug.items() if k not in LOCKED}})
    step = max(1, len(frontier) // 25)
    fr = [{"vol_pct": round(f["vol"] * 100, 2), "ret_pct": round(f["ret"] * 100, 2)} for f in frontier[::step]]
    if frontier and (not fr or fr[-1]["vol_pct"] != round(frontier[-1]["vol"] * 100, 2)):
        fr.append({"vol_pct": round(frontier[-1]["vol"] * 100, 2), "ret_pct": round(frontier[-1]["ret"] * 100, 2)})
    turnover = sum(abs(r["delta_amount"]) for r in rows if not r["locked"]) / 2
    return {
        "total": round(total, 2), "profile": prof["key"], "profiles": profiles_out,
        "current": {"return_pct": round(cur_ret * 100, 2), "vol_pct": round(cur_vol * 100, 2),
                    "sharpe": round((cur_ret - RISK_FREE) / cur_vol, 2) if cur_vol > 0 else None,
                    "weights": {k: round(v * 100, 1) for k, v in sorted(current.items(), key=lambda kv: -kv[1])},
                    "closest_profile": min(PROFILES, key=lambda p: abs(p["target_vol"] - cur_vol))["key"]},
        "suggested": {"return_pct": round(sug_ret * 100, 2), "vol_pct": round(sug_vol * 100, 2),
                      "sharpe": round((sug_ret - RISK_FREE) / sug_vol, 2) if sug_vol > 0 else None},
        "rows": rows, "turnover": round(turnover, 2), "locked_pct": round(sum(locked.values()) * 100, 1), "frontier": fr,
        "caps": {k: round(v * 100) for k, v in CAPS.items()},
        "note": "Long-run assumptions per asset class, a fixed correlation matrix and the caps above. EPF and NPS stay where they are, "
                "and no asset class you already hold is cut below half its weight. A suggestion to think with, not a trade list; "
                "taxes and exit loads are not included.",
    }
