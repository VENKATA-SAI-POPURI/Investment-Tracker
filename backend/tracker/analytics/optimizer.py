"""Allocation lab: an efficient frontier over the asset-class segments and a suggested mix per risk profile.

Mean-variance over the eight segments using the Assumption Book (assumptions.py): its μ/σ rows, the
9×9 CORR and `mu_sigma`. The `Mutual Funds` weight of any mix is split into `Mutual Funds` and
`MF_DEBT` by the portfolio's current debt-MF share, and FD/EPF/P2P use the holdings' own rates
(`rated_book`), so `current.vol_pct` is the same number the brief's Risk vital shows. EPF and NPS are
locked money, so they stay at their current weight and the optimiser works on the rest. Pure Python:
random search over the simplex plus a local refinement, which is plenty for eight variables.

P2 (SPEC §6.13, AMENDMENTS K14): an asset class you hold keeps at least a quarter of its weight; FD and
P2P are never sold (a row that would shrink says `let_mature`); every trim row carries `tax_if_sold`,
costed lowest tax first by `tax.plan_sales` when the ledger is passed. The optimiser has no separate
MF_DEBT variable: targets are by segment, so MF_DEBT only enters through the E16 split in `_stats`.
"""
from __future__ import annotations

import random

from .. import domain as d
from . import tax as tax_mod
from .assumptions import MF_DEBT, RISK_FREE, book_key, effective_book, mu_sigma, rated_book, weights_from_positions

__all__ = ["suggest", "efficient_frontier", "floors_for", "PROFILES", "CAPS", "LOCKED", "MATURITY_ONLY", "KEEP_SHARE",
           "RISK_FREE"]

LOCKED = (d.SEG_EPF, d.SEG_NPS)
# Caps on the liquid mix, as a share of the whole portfolio: credit and single-commodity risk stay bounded
CAPS = {d.SEG_P2P: 0.10, d.SEG_COMMODITY: 0.20, d.SEG_EQ_US: 0.35}
KEEP_SHARE = 0.25  # an asset class you already hold keeps at least a quarter of its current weight (K14)
MATURITY_ONLY = (d.SEG_FD, d.SEG_P2P)  # never sold: a shrinking row is 'let_mature' (K14)

_DEFAULT_BOOK = effective_book(None)   # the base Book when `suggest(book=None)` (R4)
PROFILES = [
    {"key": "conservative", "label": "Conservative", "target_vol": 0.06, "note": "Capital first; FDs and EPF carry the weight."},
    {"key": "balanced", "label": "Balanced", "target_vol": 0.09, "note": "Half growth, half ballast."},
    {"key": "growth", "label": "Growth", "target_vol": 0.12, "note": "Mostly equity, with some cushion."},
    {"key": "aggressive", "label": "Aggressive", "target_vol": 0.15, "note": "Equity-heavy; large swings accepted."},
]


def _split_mf(w: dict[str, float], debt_share: float) -> dict[str, float]:
    """Segment weights → Book keys: the `Mutual Funds` weight is split by the current debt-MF share."""
    mf = w.get(d.SEG_MF, 0.0)
    if mf <= 0 or debt_share <= 0:
        return dict(w)
    out = {k: v for k, v in w.items() if k != d.SEG_MF}
    out[MF_DEBT] = out.get(MF_DEBT, 0.0) + mf * debt_share
    if debt_share < 1:
        out[d.SEG_MF] = mf * (1 - debt_share)
    return out


def _stats(w: dict[str, float], book: dict | None = None, debt_share: float = 0.0) -> tuple[float, float]:
    """(return, volatility) of a segment mix from the Book (`mu_sigma`), positive weights only."""
    return mu_sigma(_split_mf({k: x for k, x in w.items() if x > 0}, debt_share), book or _DEFAULT_BOOK)


def _debt_share(positions) -> float:
    """Share of the open mutual-fund value that the Book counts as `MF_DEBT` (0 without positions)."""
    mf = debt = 0.0
    for p in positions or []:
        v = float(p.get("value") or 0)
        if not p.get("is_open", True) or v <= 0:
            continue
        k = book_key(p)
        if k == MF_DEBT:
            debt += v
            mf += v
        elif k == d.SEG_MF:
            mf += v
    return debt / mf if mf > 0 else 0.0


def _ok(w: dict[str, float], floors: dict[str, float] | None = None) -> bool:
    if not all(w.get(k, 0.0) <= cap + 1e-9 for k, cap in CAPS.items()):
        return False
    return all(w.get(k, 0.0) >= f - 1e-9 for k, f in (floors or {}).items())


def floors_for(current: dict[str, float], liquid: list[str], free: float) -> dict[str, float]:
    """No existing asset class drops below a quarter of its current weight (KEEP_SHARE): the lab nudges, it
    does not liquidate. Scaled down if the floors would not leave room to move."""
    floors = {k: current.get(k, 0.0) * KEEP_SHARE for k in liquid if current.get(k, 0.0) > 0.005}
    tot = sum(floors.values())
    if tot > free * 0.8 and tot > 0:
        floors = {k: v * free * 0.8 / tot for k, v in floors.items()}
    return floors


def efficient_frontier(current: dict[str, float], liquid: list[str], free: float, rng: random.Random, samples: int = 3000,
                       floors: dict[str, float] | None = None, *, book: dict | None = None, debt_share: float = 0.0) -> list[dict]:
    """Candidate mixes of the liquid segments summing to `free`, with the locked ones held; returns the
    Pareto frontier (highest return at each level of risk), low risk first. `book` and `debt_share`
    are passed to `_stats` (the default Book and no debt MF when omitted)."""
    locked = {k: v for k, v in current.items() if k in LOCKED and v > 0}
    floors = floors or {}
    room = free - sum(floors.values())
    cands = []

    def add(parts: dict[str, float]):
        w = {**locked, **{k: v for k, v in parts.items() if v > 1e-6}}
        if not _ok(w, floors):
            return
        r, s = _stats(w, book, debt_share)
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
            floors: dict[str, float] | None = None, *, book: dict | None = None, debt_share: float = 0.0) -> dict[str, float]:
    """Hill-climb: move weight between two liquid segments while return rises and risk stays under target."""
    best = dict(w)
    best_ret, best_vol = _stats(best, book, debt_share)
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
        r, s = _stats(cand, book, debt_share)
        if s <= target_vol + 1e-9 and r > best_ret + 1e-9:
            best, best_ret, best_vol = cand, r, s
    return best


def _tax_trims(rows: list[dict], port: dict, txns, instruments, slab_rate, today) -> float | None:
    """K14: every trim row gains `tax_if_sold`. With `txns` and `instruments` it is the marginal tax of that
    row's leg in one `tax.plan_sales` run (legs largest first) and the row also gains `sells`; the return is
    the combined `tax_total`. Without them, `tax_if_sold` is None and the return is None."""
    trims = [r for r in rows if r["action"] == "trim"]
    if txns is None or instruments is None:
        for r in trims:
            r["tax_if_sold"] = None
        return None
    legs = [{"segment": r["segment"], "amount": -r["delta_amount"]}
            for r in sorted(trims, key=lambda r: (r["delta_amount"], r["segment"]))]
    res = tax_mod.plan_sales(port, txns, instruments, legs, slab_rate=0.30 if slab_rate is None else slab_rate,
                             today=today)
    by_seg = {l["segment"]: l for l in res["legs"]}
    for r in trims:
        leg = by_seg[r["segment"]]
        r.update(tax_if_sold=leg["tax"], sells=leg["sells"])
    return res["tax_total"]


def suggest(port: dict, profile: str = "balanced", seed: int = 11, *, txns: list[dict] | None = None,
            instruments: list[dict] | None = None, slab_rate: float | None = None, today=None,
            book: dict | None = None) -> dict:
    """Suggested allocation for a risk profile, the frontier it sits on and the trades to get there.

    `current` return and volatility are `mu_sigma(weights_from_positions(positions), rated_book(positions, book))`
    when `port` carries positions; otherwise the segment weights on the base Book. Frontier and
    profile mixes are segment weights scored by `_stats` with the same Book and debt-MF share (E16), so
    `MF_DEBT` never appears in a row or a profile.

    Rows (K14): EPF and NPS are locked ('hold'); an FD or P2P row whose suggested weight is below current
    is 'let_mature', never 'trim', and is left out of `turnover`. Every 'trim' row carries `tax_if_sold`:
    with `txns` and `instruments` it is costed by `tax.plan_sales` (at `slab_rate`, default 30%, on
    `today`), the row gains `sells` and the result `tax_total`; without them it is None.

    `book` (AMENDMENTS R4) is the base Book, the caller's `effective_book(settings)`; every μ and σ here reads
    `rated_book(positions, book)`. None = the default Book (`_DEFAULT_BOOK`), so existing calls are unchanged."""
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
    positions = port.get("positions") or []
    base = book if book else _DEFAULT_BOOK
    book = rated_book(positions, base) if positions else base
    debt_share = _debt_share(positions)
    frontier = efficient_frontier(current, liquid, free, rng, floors=floors, book=book, debt_share=debt_share)
    pos_w = weights_from_positions(positions)
    cur_ret, cur_vol = mu_sigma(pos_w, book) if pos_w else _stats(current, book, debt_share)

    def pick(target_vol: float) -> dict[str, float]:
        under = [f for f in frontier if f["vol"] <= target_vol]
        base = max(under, key=lambda f: f["ret"]) if under else min(frontier, key=lambda f: f["vol"])
        return _refine(base["weights"], liquid, max(target_vol, base["vol"]), rng, locked, floors=floors, book=book,
                       debt_share=debt_share)

    profiles_out = []
    for p in PROFILES:
        w = pick(p["target_vol"])
        r, s = _stats(w, book, debt_share)
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
                     "action": "hold" if abs(s - c) < 0.015 or seg in LOCKED else "add" if s > c
                     else "let_mature" if seg in MATURITY_ONLY else "trim"})
    rows.sort(key=lambda r: -abs(r["delta_amount"]))
    tax_total = _tax_trims(rows, port, txns, instruments, slab_rate, today)
    sug_ret, sug_vol = _stats({**locked, **{k: v for k, v in sug.items() if k not in LOCKED}}, book, debt_share)
    step = max(1, len(frontier) // 25)
    fr = [{"vol_pct": round(f["vol"] * 100, 2), "ret_pct": round(f["ret"] * 100, 2)} for f in frontier[::step]]
    if frontier and (not fr or fr[-1]["vol_pct"] != round(frontier[-1]["vol"] * 100, 2)):
        fr.append({"vol_pct": round(frontier[-1]["vol"] * 100, 2), "ret_pct": round(frontier[-1]["ret"] * 100, 2)})
    turnover = sum(abs(r["delta_amount"]) for r in rows if not r["locked"] and r["action"] != "let_mature") / 2
    taxed = tax_total is not None
    out = {
        "total": round(total, 2), "profile": prof["key"], "profiles": profiles_out,
        "current": {"return_pct": round(cur_ret * 100, 2), "vol_pct": round(cur_vol * 100, 2),
                    "sharpe": round((cur_ret - RISK_FREE) / cur_vol, 2) if cur_vol > 0 else None,
                    "weights": {k: round(v * 100, 1) for k, v in sorted(current.items(), key=lambda kv: -kv[1])},
                    "closest_profile": min(PROFILES, key=lambda p: abs(p["target_vol"] - cur_vol))["key"]},
        "suggested": {"return_pct": round(sug_ret * 100, 2), "vol_pct": round(sug_vol * 100, 2),
                      "sharpe": round((sug_ret - RISK_FREE) / sug_vol, 2) if sug_vol > 0 else None},
        "rows": rows, "turnover": round(turnover, 2), "locked_pct": round(sum(locked.values()) * 100, 1), "frontier": fr,
        "caps": {k: round(v * 100) for k, v in CAPS.items()},
        "note": "Long-run assumptions per asset class (your own FD, EPF and P2P rates where you hold them; P2P net of a 3% "
                "expected loss and capped at 12%), a fixed correlation matrix and the caps above. EPF and NPS stay where they are, "
                "FD and P2P are left to mature, never sold, and no asset class you already hold is cut below a quarter of its "
                "weight. A suggestion to think with, not a trade list; "
                + ("trims carry an estimated tax if sold, lowest tax first; exit loads are not included." if taxed
                   else "taxes and exit loads are not included."),
    }
    if taxed:
        out["tax_total"] = tax_total
    return out
