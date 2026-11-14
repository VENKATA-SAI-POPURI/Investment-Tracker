"""Goal projections, the funding summary and rebalancing plans (SPEC §6.4; AMENDMENTS G3–G7).

Goals read every return, volatility and correlation from the Assumption Book (`assumptions.py`, SPEC
§6.0 rule 1). A goal's μ and σ come from `assumptions.mu_sigma` over the Book keys of its allocation;
`required_sip` is the SIP that reaches the target in 75 of 100 futures (`mc.required_sip_for`), and the
status comes from `assumptions.status_for` (§6.0 rule 5). Every projection carries the forward block
{assumptions, honesty, note} (§6.0 rule 2, G5).

P2 (AMENDMENTS K13, K15): a goal funded by linked SIP plans uses their monthly total, and the rebalance
plan with selling never sells FD/P2P (they are left to mature) or EPF/NPS (locked), never spends money
it does not free, and costs its sells lowest tax first through `tax.plan_sales`.

Imports: `assumptions` is a leaf module, so it is imported at the top, and so are `plans` (domain only)
and `tax` (portfolio and domain only). `mc` is imported inside the functions that use it (G3): `mc`
imports `quant`, and a top-level `mc` import here would risk the cycle goals → mc → quant → goals.
"""
from __future__ import annotations

import json
import math
import random
from datetime import date

from .. import domain as d
from . import assumptions as A
from . import plans
from . import tax as tax_mod

# Re-export of the Book's 8 segment rows (G4): {segment: (mu, sigma)}, without the internal MF_DEBT row.
# `forecast` and `quant` read it at import time, so it must stay a module-level name.
ASSUMPTIONS = {k: A.ASSUMPTIONS[k] for k in d.SEGMENTS}

_DEFAULT_KEY = d.SEG_MF   # the mix assumed when a goal has no allocation and there is no portfolio


def _months_between(a: date, b: date) -> int:
    return max((b.year - a.year) * 12 + (b.month - a.month), 0)


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def parse_allocation(raw) -> dict[str, float]:
    if not raw:
        return {}
    alloc = json.loads(raw) if isinstance(raw, str) else raw
    return {k: float(v) for k, v in alloc.items() if float(v or 0) > 0}


def _segment_of(p: dict) -> str | None:
    try:
        return p.get("segment") or d.segment_of(p)
    except (KeyError, TypeError):
        return None


def _open_positions(positions) -> list[tuple[dict, float]]:
    """(position, value) for open positions with value > 0."""
    out = []
    for p in positions or []:
        v = _f(p.get("value"))
        if p.get("is_open", True) and v > 0:
            out.append((p, v))
    return out


def _goal_weights(alloc: dict[str, float], seg_val: dict[str, float], positions) -> tuple[dict[str, float], str]:
    """({Book key: weight} normalised to 1, basis) for a goal's allocation (G6).

    Each allocated segment's share is its value × pct, or the pct alone when every allocated segment is
    worth 0. With `positions`, a segment's share is split over Book keys by its open positions' value
    (a debt fund lands on MF_DEBT); a segment with no open position keeps its own key. Keys the Book does
    not know are dropped. With no allocation the goal is assumed to be invested like the whole portfolio
    (positions, else segment values), and like a diversified mutual fund when the portfolio is empty."""
    if not alloc:
        if positions:
            w = A.weights_from_positions(positions)
            if w:
                return w, "no allocation set: your portfolio's mix"
        tot = sum(v for v in seg_val.values() if v > 0)
        if tot > 0:
            return {k: v / tot for k, v in seg_val.items() if v > 0 and k in A.CORR}, "no allocation set: your portfolio's mix"
        return {_DEFAULT_KEY: 1.0}, "no allocation set: a diversified mutual fund"

    share = {seg: seg_val.get(seg, 0.0) * pct / 100 for seg, pct in alloc.items()}
    basis = "the goal's allocation, by value"
    if not sum(share.values()):
        share = dict(alloc)
        basis = "the goal's allocation"

    by_seg: dict[str, dict[str, float]] = {}
    if positions:
        for p, v in _open_positions(positions):
            seg = _segment_of(p)
            if seg in share:
                k = A.book_key(p)
                by_seg.setdefault(seg, {})
                by_seg[seg][k] = by_seg[seg].get(k, 0.0) + v
        if by_seg:
            basis += ", split by your holdings"

    w: dict[str, float] = {}
    for seg, s in share.items():
        if s <= 0:
            continue
        parts = by_seg.get(seg)
        tot = sum(parts.values()) if parts else 0.0
        if tot > 0:
            for k, v in parts.items():
                w[k] = w.get(k, 0.0) + s * v / tot
        else:
            w[seg] = w.get(seg, 0.0) + s
    w = {k: v for k, v in w.items() if k in A.CORR}
    tot = sum(w.values())
    if tot <= 0:
        return {_DEFAULT_KEY: 1.0}, "no known asset class in the allocation: a diversified mutual fund"
    return {k: v / tot for k, v in w.items()}, basis


def _forward_block(mu: float, sigma: float, book: dict, basis: str, sims: int) -> tuple[dict, dict]:
    """(assumptions, honesty) per G5: the numbers the projection used and the copy that labels them."""
    block = {
        "return_pct": round(mu * 100, 2),
        "typical_pct": round(A.typical(mu, sigma) * 100, 2),
        "volatility_pct": round(sigma * 100, 2),
        "inflation_pct": round(_f(book.get("inflation_pct", A.INFLATION * 100)), 2),
        "basis": basis,
        "hash": A.book_hash(book),
    }
    honesty = {**A.HONESTY, "p50": A.HONESTY["p50"].format(sims=f"{sims:,}")}
    return block, honesty


def linked_contribution(linked_sips: list[dict] | None, today: date) -> tuple[list[dict], float]:
    """([{id, name, amount, frequency, monthly_equiv}], monthly total) for the SIP plans linked to a goal
    (K15). A plan counts when it is active, started (start_date ≤ today) and not ended, at amount ×
    `plans.SIP_PER_MONTH[frequency]` with no step-up: the `monthly_sip_total` rule. Plans that are not
    running are listed with monthly_equiv 0."""
    rows = []
    for s in linked_sips or []:
        rows.append({"id": s.get("id"), "name": s.get("name"), "amount": round(_f(s.get("amount")), 2),
                     "frequency": plans._freq(s), "monthly_equiv": plans._monthly_equiv(s, today)})
    return rows, round(sum(r["monthly_equiv"] for r in rows), 2)


def project_goal(goal: dict, segments: list[dict], today: date | None = None, sims: int = 1000, *,
                 positions: list[dict] | None = None, linked_sips: list[dict] | None = None,
                 book: dict | None = None) -> dict:
    """Project one goal on the Assumption Book (SPEC §6.4; AMENDMENTS G5, G6).

    - `current` = Σ segment value × allocation pct.
    - μ and σ = `mu_sigma(weights, book)` with `book = rated_book(positions, base)` (FD/EPF/P2P at the
      holdings' own rates) or the base Book without positions; `goal.expected_return` overrides μ only.
    - `probability`, `p10`/`p50`/`p90` come from a monthly log-normal Monte Carlo of `sims` paths, seeded
      with the goal id (§6.0 rule 4); `projected`, `shortfall` and `path` are deterministic at μ.
    - `required_sip` is the monthly SIP that reaches the target in 75 of 100 futures and
      `required_sip_typical` the one that reaches it at the typical return (`mc.required_sip_for`); both
      are None with no months left.
    - `status` = `assumptions.status_for(probability, achieved=current ≥ target)`.
    - The forward block: `assumptions` {return_pct, typical_pct, volatility_pct, inflation_pct, basis,
      hash}, `honesty` and `note`.
    - `linked_sips` (K15) are the SIP plans with `goal_id == goal.id`. When their monthly total
      (`linked_contribution`) is > 0 it replaces `goal.monthly_contribution`; the projection carries
      `linked_sips`, `linked_monthly` and `contribution_source` ('linked' | 'goal').
    - `book` (AMENDMENTS R4) is the base Book, the caller's `effective_book(settings)`: μ and σ read
      `rated_book(positions, book)` (or `book` itself without positions). None = the default Book, so every
      existing call gives today's numbers.
    """
    from . import mc   # inside the function, never at module top: see AMENDMENTS G3 (import cycle)

    today = today or date.today()
    alloc = parse_allocation(goal.get("allocation"))
    seg_val = {s["segment"]: _f(s.get("value")) for s in segments or []}
    current = sum(seg_val.get(seg, 0.0) * pct / 100 for seg, pct in alloc.items())

    weights, basis = _goal_weights(alloc, seg_val, positions)
    base = book if book else A.effective_book(None)
    book = A.rated_book(positions, base) if positions else base
    notes: list[str] = []
    mu, sigma = A.mu_sigma(weights, book, notes=notes)
    if goal.get("expected_return") not in (None, ""):
        mu = float(goal["expected_return"]) / 100
        basis = f"your expected return of {mu * 100:g}%; volatility from {basis}"

    target = float(goal["target_amount"])
    target_date = date.fromisoformat(str(goal["target_date"])[:10])
    months = _months_between(today, target_date)
    linked, linked_monthly = linked_contribution(linked_sips, today)
    source = "linked" if linked_monthly > 0 else "goal"
    sip = linked_monthly if source == "linked" else _f(goal.get("monthly_contribution"))
    rm = (1 + mu) ** (1 / 12) - 1

    def fv(pv, pmt, n):
        if n <= 0:
            return pv
        growth = (1 + rm) ** n
        return pv * growth + (pmt * (growth - 1) / rm if rm else pmt * n)

    projected = fv(current, sip, months)
    seed = goal.get("id") or 7
    if months > 0:
        req = mc.required_sip_for(current, months, mu, sigma, target, 0.75, seed=seed)
        required_sip, required_typ = req["sip_75"], req["sip_typical"]
    else:
        required_sip = required_typ = None

    # Monte Carlo: monthly log-normal returns, contributions at month end
    rng = random.Random(seed)
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
    prob = hits / sims if months > 0 and sims > 0 else (1.0 if current >= target else 0.0)

    path = []
    for y in range(0, months // 12 + 2):
        n = min(y * 12, months)
        path.append({"date": date(today.year + n // 12 + (today.month - 1 + n % 12) // 12,
                                  (today.month - 1 + n % 12) % 12 + 1, 1).isoformat(),
                     "projected": round(fv(current, sip, n), 2), "contributed": round(current + sip * n, 2)})
        if n == months:
            break

    progress = current / target * 100 if target else 0.0
    probability = round(prob * 100, 1)
    status = A.status_for(probability, achieved=current >= target)
    block, honesty = _forward_block(mu, sigma, book, basis, sims)
    note = ("Simulated over {sims} futures of monthly returns at the goal's mix. \"Needs\" is the monthly SIP "
            "that reaches the target in 75 of 100 futures; the typical SIP reaches it in about half. "
            .format(sims=f"{sims:,}") + A.HONESTY["disclaimer"])
    if notes:
        note += " " + " ".join(notes)
    return {
        "current": round(current, 2), "progress_pct": round(min(progress, 100), 2), "months_left": months,
        "expected_return": round(mu * 100, 2), "volatility": round(sigma * 100, 2),
        "projected": round(projected, 2), "shortfall": round(max(target - projected, 0), 2),
        "required_sip": round(float(required_sip), 2) if required_sip is not None else None,
        "required_sip_typical": round(float(required_typ), 2) if required_typ is not None else None,
        "probability": probability, "status": status,
        "p10": round(finals[int(len(finals) * 0.1)], 2) if finals else None,
        "p50": round(finals[len(finals) // 2], 2) if finals else None,
        "p90": round(finals[int(len(finals) * 0.9)], 2) if finals else None,
        "path": path,
        "assumptions": block, "honesty": honesty, "note": note,
        "linked_sips": linked, "linked_monthly": linked_monthly, "contribution_source": source,
    }


def _cushion_ids(emergency) -> list[int]:
    if not isinstance(emergency, dict):
        return []
    out = []
    for i in emergency.get("instrument_ids") or []:
        try:
            out.append(int(i))
        except (TypeError, ValueError):
            continue
    return out


def funding_summary(goals: list[dict], segments: list[dict], positions: list[dict] | None, emergency: dict | None) -> dict:
    """Where the portfolio's money is spoken for (SPEC §6.4; AMENDMENTS G7).

    - `cushion`: the open positions whose id is in `emergency.instrument_ids`; `amount` = Σ their value.
      `emergency.cash_amount` (bank money outside the tracker, A25) is reported as `cash_amount` and never
      subtracted. `emergency` may be the `emergencyFund` setting or the brief's Cushion; None → no cushion.
    - Each segment's cushion-free value = max(0, segment value − Σ cushion value in that segment).
    - `earmarked[].amount` = Σ over the goal's segments of cushion-free value × pct/100. In a segment whose
      goals claim more than 100%, every claim is scaled by 100/claimed_pct so no rupee counts twice; such
      a goal's row also carries `unscaled`.
    - `total` = Σ segment values; `free` = max(0, total − Σ earmarked − cushion.amount).
    - `over_allocated` = [{segment, claimed_pct, goals[{goal_id, name, pct}]}] where claimed_pct > 100.
    """
    seg_val: dict[str, float] = {}
    for s in segments or []:
        seg_val[s["segment"]] = seg_val.get(s["segment"], 0.0) + _f(s.get("value"))
    total = sum(seg_val.values())

    ids = set(_cushion_ids(emergency))
    cushion_ids: list[int] = []
    cushion_by_seg: dict[str, float] = {}
    for p, v in _open_positions(positions):
        if p.get("id") in ids:
            cushion_ids.append(p["id"])
            seg = _segment_of(p)
            cushion_by_seg[seg] = cushion_by_seg.get(seg, 0.0) + v
    cushion_amount = sum(cushion_by_seg.values())
    cash = max(_f((emergency or {}).get("cash_amount")) if isinstance(emergency, dict) else 0.0, 0.0)
    free_val = {seg: max(0.0, v - cushion_by_seg.get(seg, 0.0)) for seg, v in seg_val.items()}

    allocs = [(g, parse_allocation(g.get("allocation"))) for g in goals or []]
    claimed: dict[str, float] = {}
    claims: dict[str, list[dict]] = {}
    for g, alloc in allocs:
        for seg, pct in alloc.items():
            claimed[seg] = claimed.get(seg, 0.0) + pct
            claims.setdefault(seg, []).append({"goal_id": g.get("id"), "name": g.get("name"), "pct": round(pct, 2)})
    scale = {seg: (100.0 / c if c > 100 + 1e-9 else 1.0) for seg, c in claimed.items()}

    earmarked = []
    for g, alloc in allocs:
        unscaled = sum(free_val.get(seg, 0.0) * pct / 100 for seg, pct in alloc.items())
        amount = sum(free_val.get(seg, 0.0) * pct / 100 * scale[seg] for seg, pct in alloc.items())
        row = {"goal_id": g.get("id"), "name": g.get("name"), "amount": round(amount, 2)}
        if any(scale[seg] < 1.0 for seg in alloc):
            row["unscaled"] = round(unscaled, 2)
        earmarked.append(row)

    order = {s: i for i, s in enumerate(d.SEGMENTS)}
    over = [{"segment": seg, "claimed_pct": round(c, 2), "goals": claims[seg]}
            for seg, c in sorted(claimed.items(), key=lambda kv: (order.get(kv[0], len(order)), kv[0])) if c > 100 + 1e-9]
    earmarked_total = sum(r["amount"] for r in earmarked)
    return {
        "total": round(total, 2),
        "cushion": {"amount": round(cushion_amount, 2), "cash_amount": round(cash, 2), "instrument_ids": cushion_ids},
        "earmarked": earmarked,
        "free": round(max(0.0, total - earmarked_total - cushion_amount), 2),
        "over_allocated": over,
    }


MATURITY_ONLY = (d.SEG_FD, d.SEG_P2P)   # never sold: left to mature, the money redirected (K13)
LOCKED = (d.SEG_EPF, d.SEG_NPS)         # cannot be sold at all (K13)


def _sell_side(rows: list[dict], new_money: float, *, port, txns, instruments, slab_rate, today) -> dict:
    """K13: the allow_sell plan's P2 rules, applied to `rows` in place. Returns the extra plan keys.

    - An FD or P2P row that would sell becomes hold with `let_mature` = the amount it is over; an EPF or
      NPS row that would sell becomes hold with `locked: true`. `not_sold` = Σ both excesses.
    - With `port`, `txns` and `instruments`, the remaining sell rows become `tax.plan_sales` legs, largest
      first; each gains `sells`, `covered` and `tax_if_sold` (the leg's marginal tax), and the plan gains
      `tax_total` and `tax_note`.
    - Buys are scaled by (money freed + new_money) / Σ buys when that is below 1, where the money freed
      is Σ allowed sells (Σ `covered` when the sells were planned), so the plan never spends money it
      does not free."""
    not_sold = 0.0
    for r in rows:
        if r["action"] != "sell":
            continue
        if r["segment"] in MATURITY_ONLY:
            not_sold += r["amount"]
            r.update(action="hold", let_mature=r["amount"], amount=0.0)
        elif r["segment"] in LOCKED:
            not_sold += r["amount"]
            r.update(action="hold", amount=0.0, locked=True)
    extra: dict = {"not_sold": round(not_sold, 2)}

    sell_rows = [r for r in rows if r["action"] == "sell"]
    if port is not None and txns is not None and instruments is not None:
        legs = [{"segment": r["segment"], "amount": r["amount"]}
                for r in sorted(sell_rows, key=lambda r: (-r["amount"], r["segment"]))]
        res = tax_mod.plan_sales(port, txns, instruments, legs, slab_rate=0.30 if slab_rate is None else slab_rate,
                                 today=today)
        by_seg = {l["segment"]: l for l in res["legs"]}
        for r in sell_rows:
            leg = by_seg[r["segment"]]
            r.update(sells=leg["sells"], covered=leg["covered"], tax_if_sold=leg["tax"])
        extra.update(tax_total=res["tax_total"], tax_note=res["note"])

    freed = sum(r.get("covered", r["amount"]) for r in sell_rows)
    buys = sum(r["amount"] for r in rows if r["action"] == "buy")
    if buys > 0 and freed + new_money < buys - 0.005:
        f = max(freed + new_money, 0.0) / buys
        for r in rows:
            if r["action"] == "buy":
                r["amount"] = round(r["amount"] * f, 2)
                if r["amount"] <= 0.5:
                    r["action"] = "hold"
    return extra


def rebalance_plan(segments: list[dict], targets: dict, new_money: float = 0.0, allow_sell: bool = False, *,
                   port: dict | None = None, txns: list[dict] | None = None, instruments: list[dict] | None = None,
                   slab_rate: float | None = None, today: date | None = None) -> dict:
    """Amounts to add (and optionally trim) per segment to move toward target weights.

    Without `allow_sell`, new money goes to the most under-weight segments only (unchanged since P0).
    With it, every segment moves to its target, under the P2 rules in `_sell_side` (AMENDMENTS K13): FD
    and P2P are left to mature, EPF and NPS are locked, buys never exceed the money freed plus
    `new_money`, and with `port`/`txns`/`instruments` the sells are planned lowest tax first
    (`tax.plan_sales`, at `slab_rate`, default 30%). `after_pct` is computed on the final plan."""
    # Only the classes with a target take part (see _segments: others sit outside the target mix)
    cur = {s["segment"]: float(s["value"] or 0) for s in segments if s["segment"] in targets}
    tsum = sum(float(v) for v in targets.values()) or 100.0
    tw = {k: float(v) / tsum for k, v in targets.items()}
    total = sum(cur.values())
    final_total = total + new_money
    ideal = {k: final_total * w for k, w in tw.items()}
    rows = []
    extra: dict = {}
    if allow_sell:
        for seg in sorted(set(cur) | set(tw)):
            diff = ideal.get(seg, 0.0) - cur.get(seg, 0.0)
            rows.append({"segment": seg, "current": round(cur.get(seg, 0.0), 2), "target_pct": round(tw.get(seg, 0) * 100, 2),
                         "action": "buy" if diff > 0 else "sell" if diff < 0 else "hold", "amount": round(abs(diff), 2)})
        extra = _sell_side(rows, new_money, port=port, txns=txns, instruments=instruments, slab_rate=slab_rate,
                           today=today)
    else:
        # Distribute new money to the most under-weight segments only (no selling, no tax)
        deficits = {k: max(ideal.get(k, 0.0) - cur.get(k, 0.0), 0.0) for k in tw}
        dsum = sum(deficits.values())
        for seg in sorted(set(cur) | set(tw)):
            add = new_money * deficits.get(seg, 0.0) / dsum if dsum > 0 else new_money * tw.get(seg, 0.0)
            rows.append({"segment": seg, "current": round(cur.get(seg, 0.0), 2), "target_pct": round(tw.get(seg, 0) * 100, 2),
                         "action": "buy" if add > 0.5 else "hold", "amount": round(add, 2)})
    after = {r["segment"]: r["current"] + (r["amount"] if r["action"] == "buy"
                                           else -r.get("covered", r["amount"]) if r["action"] == "sell" else 0)
             for r in rows}
    atot = sum(after.values()) or 1.0
    for r in rows:
        r["current_pct"] = round(r["current"] / total * 100, 2) if total else 0.0
        r["after_pct"] = round(after[r["segment"]] / atot * 100, 2)
    needed = sum(max(ideal.get(k, 0) - cur.get(k, 0), 0) for k in tw)
    # New money that would fully fix allocation without selling
    worst = max(((cur.get(k, 0.0) / w) for k, w in tw.items() if w > 0), default=total)
    return {"rows": rows, "total": round(total, 2), "new_money": round(new_money, 2), "allow_sell": allow_sell,
            "shortfall_to_targets": round(needed, 2), "money_to_fix_without_selling": round(max(worst - total, 0), 2),
            **extra}
