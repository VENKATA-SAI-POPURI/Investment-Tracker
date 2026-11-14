"""Plan engine v2: a per-segment correlated Monte Carlo with common random numbers (SPEC Part 1 P2.1, P2.3;
Part 2 §6.3 P2, §6.5 P2, §6.8 P2; AMENDMENTS K8, D18).

A pure module: no database, no network. It imports only `assumptions`, `plans` and `domain` (K8), never
`forecast`, `goals`, `quant` or `mc`; `forecast` imports it.

Entry points (K8)
- `build_state(positions, *, book, today, txns=None, instruments=None, targets=None)` turns positions into the
  simulation state: value and cost basis per stochastic Book key, plus the deterministic FD, P2P and EPF ladders.
- `flows_from_sips(sips, *, state, today, horizon_months, stop_month=None)` turns SIP plans into flows on their
  real due dates (`plans.due_dates`, `plans.planned_amount`), each routed to its instrument's Book key.
- `lump_flow(monthly, *, state, step_up_pct=0.0, today, horizon_months, stop_month=None, weights=None)` is one
  monthly amount with a yearly step-up, split pro rata over the current stochastic value (or `weights`).
- `run(state, flows, book, *, horizon_months, ...)` simulates and returns the percentile bands and the rest.

The model
- Six stochastic keys (`STOCH`): Equity (India), Equity (USA), Mutual Funds, MF_DEBT, Commodity and NPS. Over a
  step of dt years, g = exp((ln(1+μ) − σ²/2)·dt + σ·f·√dt) with f = L·z, where L is the Cholesky factor of the
  6×6 stochastic block of `assumptions.CORR` (positive definite: the smallest pivot is asserted > 0, N3).
- Every step draws the full 6-vector z, whichever keys are empty. Pair j draws from
  `random.Random(seed * 1_000_003 + j)`; simulation 2j uses z and 2j+1 uses −z (antithetic). So common random
  numbers hold across horizons, key sets and flows.
- Steps (D18 as amended by K8): monthly for 24 months, then quarterly; yearly once withdrawals have started.
  Flows inside a step are summed and added at mid-step (value += flow × √g, basis += flow).
- Ladders are deterministic: FDs accrue at their rate and release at maturity; P2P loans pay EMIs at their
  rate with each month × (1 − P2P_LOSS/12); EPF takes the per-calendar-month average contribution
  (`epf_monthly_average`, the one helper `forecast.cash_flow_forecast` uses too, H16), is credited each March
  and stays locked until withdrawals start.
- **Routing is decided once, on the deterministic no-shock path of the state** (K8): FD releases and P2P
  receipts not re-lent go to the segment furthest under target (else MF_DEBT). The glide's yearly trim is a
  fraction of each equity key, also fixed on the deterministic path, separately for the state and for the
  flows (each layer glides from its own starting equity share). Every simulation therefore moves the same
  rupees (or the same fraction) at the same step, and until withdrawals start each path is exactly linear in
  its flows: the state-only part (`no_flow_p50`) is tracked alongside, a doubled SIP adds exactly the same
  rupees again, and a required SIP is an order statistic (K10).

Honesty: every number here is an estimate under the stated assumptions; the median is "typical", p10/p90 the
1-in-10 bad and good cases, and `expected` the mean that the best cases pull up.
"""
from __future__ import annotations

import calendar
import math
import random
from datetime import date, timedelta

from .. import domain as d
from . import assumptions as A
from . import plans

# ── Keys ──
EQ_IN, EQ_US, MF, COMM, NPS = d.SEG_EQ_IN, d.SEG_EQ_US, d.SEG_MF, d.SEG_COMMODITY, d.SEG_NPS
MF_DEBT = A.MF_DEBT
FD, P2P, EPF = d.SEG_FD, d.SEG_P2P, d.SEG_EPF
STOCH = (EQ_IN, EQ_US, MF, MF_DEBT, COMM, NPS)        # the order of z and of the Cholesky rows
LADDERS = (FD, P2P, EPF)
EQUITY_KEYS = (EQ_IN, EQ_US, MF)                       # the glide's "equity share"
_IDX = {k: i for i, k in enumerate(STOCH)}

# ── Constants ──
MONTHLY_STEPS = 24        # D18: monthly for the first 24 months, then quarterly
QUARTER = 3
RELEND_CAP = 0.10         # P2P receipts are re-lent while P2P is under 10% of the deterministic total
CESS = 1.04
LTCG_RATE = 0.125
LTCG_EXEMPTION = 125000.0
ANNUITY_SHARE = 0.40      # NPS at retirement: 60% lump sum, 40% buys an annuity (K10)
ANNUITY_RATE = 0.06
GLIDE_DEFAULTS = {"start_age": 45, "floor": 0.30, "step": 0.01}
AFTER_TAX_NOTE = "at today's rules; surcharge not modelled"
SEED_STRIDE = 1_000_003
EPF_WINDOW_DAYS = 120     # H16: EPF BUYs of the last 120 days, averaged per calendar month
EPF_MONTHS = 3


# ── Small helpers ──
def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _date(v) -> date | None:
    if isinstance(v, date):
        return v
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def add_months(day: date, k: int) -> date:
    """`day` moved by k calendar months, the day clamped to the month's last day."""
    t = day.year * 12 + (day.month - 1) + k
    y, m = t // 12, t % 12 + 1
    return date(y, m, min(day.day, calendar.monthrange(y, m)[1]))


def month_index(today: date, day: date) -> int:
    """The simulation month m that contains `day`: add_months(today, m − 1) < day ≤ add_months(today, m).
    0 or less for a day on or before today."""
    k = (day.year - today.year) * 12 + (day.month - today.month)
    while day > add_months(today, k):
        k += 1
    while day <= add_months(today, k - 1):
        k -= 1
    return k


def _ms(book: dict | None, key: str) -> tuple[float, float]:
    """(μ, σ) of a key as fractions: the Book's row, else the default Book's."""
    segs = (book or {}).get("segments") or {}
    row = segs.get(key)
    if row is None:
        row = A.effective_book(None)["segments"].get(key) or A.effective_book(None)["segments"][MF]
    return float(row.get("return_pct") or 0) / 100, float(row.get("vol_pct", row.get("volatility_pct")) or 0) / 100


def cholesky(matrix) -> tuple[list[list[float]], float]:
    """(L, smallest pivot) with matrix = L·Lᵀ, pure Python. Raises ValueError when a pivot is not > 0."""
    n = len(matrix)
    low = [[0.0] * n for _ in range(n)]
    pivots = []
    for i in range(n):
        for j in range(i + 1):
            s = matrix[i][j] - sum(low[i][k] * low[j][k] for k in range(j))
            if i == j:
                if s <= 0:
                    raise ValueError("correlation block is not positive definite")
                low[i][i] = math.sqrt(s)
                pivots.append(low[i][i])
            else:
                low[i][j] = s / low[j][j]
    return low, min(pivots)


def stochastic_cholesky() -> tuple[list[list[float]], float]:
    """The Cholesky factor of the 6×6 stochastic block of `assumptions.CORR`, and its smallest pivot (N3)."""
    block = [[A.CORR[a][b] for b in STOCH] for a in STOCH]
    low, pivot = cholesky(block)
    if not pivot > 0:   # N3: the block is PD as specified, so no repair; assert it stays so
        raise ValueError("the stochastic correlation block lost positive definiteness")
    return low, pivot


def _pctl(sorted_xs: list[float], p: float) -> float:
    """Linear-interpolated percentile of an already sorted list (the old project_portfolio `q`)."""
    if not sorted_xs:
        return 0.0
    k = (len(sorted_xs) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return sorted_xs[lo] if lo == hi else sorted_xs[lo] * (hi - k) + sorted_xs[hi] * (k - lo)


def epf_monthly_average(txns: list[dict], today: date) -> float | None:
    """The EPF monthly contribution (AMENDMENTS H16): the BUYs dated in the last 120 days up to today, summed per
    calendar month, averaged over the last (up to) three months that have one, so the employee and employer
    rows of one month count once. None when there is no such BUY. `forecast.cash_flow_forecast` and
    `build_state` both use this one helper, so the cash-flow page and the plan engine never differ."""
    since = (today - timedelta(days=EPF_WINDOW_DAYS)).isoformat()
    today_s = today.isoformat()
    by_month: dict[str, float] = {}
    for t in txns or []:
        ds = str(t.get("date") or "")[:10]
        if t.get("type") == d.BUY and since <= ds <= today_s:
            by_month[ds[:7]] = by_month.get(ds[:7], 0.0) + _f(t.get("amount"))
    if not by_month:
        return None
    last = sorted(by_month)[-EPF_MONTHS:]
    return sum(by_month[k] for k in last) / len(last)


# ── State ──
def _position_key(p: dict) -> str | None:
    try:
        return A.book_key(p)
    except (KeyError, TypeError):
        return None


def build_state(positions, *, book, today, txns=None, instruments=None, targets=None) -> dict:
    """The simulation state from positions (K8).

    - Stochastic keys: value and cost basis (`cost`, else `invested`, else the value) per `assumptions.book_key`;
      the USD wallet lands on Equity (USA).
    - FD: each open FD with its `rate` (else the Book's), `maturity_date` and `maturity_value`. One whose maturity
      date has passed without a MATURITY row (A28) releases its value at step 0. One with no maturity date (a
      segment-only port) accrues at its rate until withdrawals start.
    - P2P: each open loan's `outstanding` amortised to `maturity_date` (else `first_date` + `tenure_months`) at
      its `rate`. A defaulted loan earns nothing and releases nothing. A P2P value with no schedule is a pool at
      the Book's P2P μ (net of the expected loss).
    - EPF: the balance at its value-weighted rate, and the monthly contribution from `epf_monthly_average` over
      each EPF instrument's transactions (0 without `txns`).
    - `inst_key` maps instrument ids to Book keys, for routing SIP plans; `targets` ({segment: pct}) steer the
      routing of FD and P2P money.
    """
    today = today or date.today()
    book = book or A.rated_book(positions)
    values = {k: 0.0 for k in STOCH}
    basis = {k: 0.0 for k in STOCH}
    fds: list[dict] = []
    loans: list[dict] = []
    p2p_pool = stuck = release0 = 0.0
    epf_bal = epf_rate_num = 0.0
    inst_key: dict = {}
    epf_ids: set = set()
    notes: list[str] = []
    fd_mu = _ms(book, FD)[0]
    for inst in instruments or []:
        try:
            k = A.book_key(inst) if (inst.get("segment") or inst.get("asset_class")) else None
        except (KeyError, TypeError):
            k = None
        if k is not None and inst.get("id") is not None:
            inst_key[inst["id"]] = k
        if inst.get("asset_class") == d.EPF and inst.get("id") is not None:
            epf_ids.add(inst["id"])
    for p in positions or []:
        key = _position_key(p)
        if key is None:
            continue
        if p.get("id") is not None:
            inst_key[p["id"]] = key
            if key == EPF:
                epf_ids.add(p["id"])
        v = _f(p.get("value"))
        if not p.get("is_open", True) or v <= 0:
            continue
        if key in _IDX:
            values[key] += v
            cost = p.get("cost") if p.get("cost") not in (None, "") else p.get("invested")
            basis[key] += _f(cost) if cost not in (None, "") and _f(cost) > 0 else v
        elif key == FD:
            rate = _f(p.get("rate")) / 100 if _f(p.get("rate")) else fd_mu
            mat = _date(p.get("maturity_date"))
            if mat is not None and mat <= today:
                release0 += v          # A28: matured, not recorded → its value moves at step 0
                continue
            m = month_index(today, mat) if mat else None
            mv = _f(p.get("maturity_value")) or None
            fds.append({"id": p.get("id"), "value": v, "rate": rate, "month": m, "maturity_value": mv})
        elif key == P2P:
            if (p.get("status") or "").lower() == "defaulted":
                stuck += v
                continue
            out = _f(p.get("outstanding")) or v
            mat = _date(p.get("maturity_date"))
            if mat is None and p.get("first_date") and _f(p.get("tenure_months")):
                mat = add_months(_date(p.get("first_date")), int(_f(p.get("tenure_months"))))
            if mat is None:
                p2p_pool += out
                continue
            n = max(month_index(today, mat), 1)
            loans.append({"id": p.get("id"), "outstanding": out, "rate": _f(p.get("rate")) / 100, "months": n})
        elif key == EPF:
            rate = _f(p.get("rate")) / 100 if _f(p.get("rate")) else _ms(book, EPF)[0]
            epf_bal += v
            epf_rate_num += v * rate
    epf_monthly = 0.0
    epf_from_ledger = False
    if txns and epf_ids:
        by_inst: dict = {}
        for t in txns:
            if t.get("instrument_id") in epf_ids:
                by_inst.setdefault(t["instrument_id"], []).append(t)
        for rows in by_inst.values():
            avg = epf_monthly_average(rows, today)
            if avg is not None:
                epf_from_ledger = True
                epf_monthly += avg
    total = (sum(values.values()) + sum(f["value"] for f in fds) + sum(ln["outstanding"] for ln in loans)
             + p2p_pool + stuck + release0 + epf_bal)
    return {
        "today": today, "book": book, "values": values, "basis": basis, "fds": fds, "loans": loans,
        "p2p_pool": p2p_pool, "stuck": stuck, "release0": release0,
        "epf": {"value": epf_bal, "rate": (epf_rate_num / epf_bal) if epf_bal > 0 else _ms(book, EPF)[0],
                "monthly": epf_monthly, "from_ledger": epf_from_ledger},
        "inst_key": inst_key, "targets": dict(targets) if targets else None, "total": total, "notes": notes,
    }


# ── Flows ──
_SEG_KEY = {EQ_IN: EQ_IN, EQ_US: EQ_US, MF: MF, COMM: COMM, NPS: NPS, FD: FD, P2P: P2P, EPF: EPF, MF_DEBT: MF_DEBT}


def plan_key(plan: dict, state: dict) -> str:
    """The Book key a SIP plan invests in: its instrument's key, else its segment's key (Mutual Funds by default)."""
    iid = plan.get("instrument_id")
    if iid is not None and iid in (state.get("inst_key") or {}):
        return state["inst_key"][iid]
    return _SEG_KEY.get(plan.get("segment") or "", MF)


def flows_from_sips(sips, *, state, today, horizon_months, stop_month=None) -> list[dict]:
    """One flow per SIP plan: {key, months {m: amount}, id, goal_id, label}.

    Instalments are the plan's real due dates from tomorrow (`plans.due_dates`), each at
    `plans.planned_amount` (the step-up counts whole years from the plan's anchor), so a quarterly plan lands on
    its months and a weekly one 4 or 5 times a month. The money goes to the plan instrument's Book key, or the
    plan segment's key. A plan stops at `end_date` or at `stop_month` (retirement). An EPF plan is skipped when
    the EPF contribution is averaged from the ledger (as `cash_flow_forecast` rule 7 does)."""
    today = today or date.today()
    horizon = max(int(horizon_months), 0)
    last = min(horizon, int(stop_month)) if stop_month is not None else horizon
    if last <= 0:
        return []
    first, end = today + timedelta(days=1), add_months(today, last)
    out = []
    for plan in sips or []:
        if _f(plan.get("amount")) <= 0:
            continue
        key = plan_key(plan, state)
        if key == EPF and (state.get("epf") or {}).get("from_ledger"):
            continue
        months: dict[int, float] = {}
        for due in plans.due_dates(plan, first, end):
            m = month_index(today, due)
            if 1 <= m <= last:
                months[m] = months.get(m, 0.0) + plans.planned_amount(plan, due)
        if months:
            out.append({"key": key, "months": months, "id": plan.get("id"), "goal_id": plan.get("goal_id"),
                        "label": plan.get("name")})
    return out


def adjust_flows(flows, *, scale=1.0, step_up_pct=0.0, weights=None) -> list[dict]:
    """Plan flows reshaped for a compare column whose SIP differs from today's plan (R5, W7 review fixes): every
    amount × `scale` and × (1 + step_up_pct/100) ^ whole years from today ((m − 1) // 12, as `lump_flow` steps;
    `step_up_pct` may be negative, a slower step than today's), so each plan keeps its own dates, step-ups and
    end. With `weights` ({key: share}) each month's total is then re-split over those keys, one flow per key."""
    k = max(_f(scale), 0.0)
    g = 1 + max(_f(step_up_pct), -99.0) / 100
    out = [{**fl, "months": {m: v * k * g ** ((m - 1) // 12) for m, v in fl["months"].items()}} for fl in flows or []]
    w = {key: float(x) for key, x in (weights or {}).items() if x and float(x) > 0}
    tot = sum(w.values())
    if tot <= 0:
        return out
    total: dict[int, float] = {}
    for fl in out:
        for m, v in fl["months"].items():
            total[m] = total.get(m, 0.0) + v
    months = sorted(total)
    return [{"key": key, "months": {m: total[m] * x / tot for m in months}, "id": None, "goal_id": None,
             "label": "monthly investing"} for key, x in w.items()]


def stochastic_weights(state: dict) -> dict[str, float]:
    """The current stochastic value mix, normalised; {'Mutual Funds': 1} when nothing stochastic is held."""
    vals = {k: v for k, v in (state.get("values") or {}).items() if v > 0}
    tot = sum(vals.values())
    return {k: v / tot for k, v in vals.items()} if tot > 0 else {MF: 1.0}


def lump_flow(monthly, *, state, step_up_pct=0.0, today, horizon_months, stop_month=None, weights=None) -> list[dict]:
    """One monthly amount, every month from 1 to the horizon (or `stop_month`), rising by `step_up_pct` percent
    every 12 months, split over `weights` ({key: share}) or pro rata over the current stochastic value
    (`Mutual Funds` when there is none). One flow per key."""
    amt = max(_f(monthly), 0.0)
    horizon = max(int(horizon_months), 0)
    last = min(horizon, int(stop_month)) if stop_month is not None else horizon
    if amt <= 0 or last <= 0:
        return []
    w = {k: float(x) for k, x in (weights or stochastic_weights(state)).items() if x and float(x) > 0}
    tot = sum(w.values())
    if tot <= 0:
        w, tot = {MF: 1.0}, 1.0
    step = max(_f(step_up_pct), 0.0) / 100
    out = []
    for k, x in w.items():
        share = amt * x / tot
        out.append({"key": k, "months": {m: share * (1 + step) ** ((m - 1) // 12) for m in range(1, last + 1)},
                    "id": None, "goal_id": None, "label": "monthly investing"})
    return out


# ── Time grid ──
def grid(horizon_months: int, start_month: int | None = None) -> list[int]:
    """Boundaries in months: monthly to 24, then quarterly, yearly from `start_month` (withdrawals). The last
    step may be shorter. The grid's prefix never depends on the horizon (CRN across horizons)."""
    h = max(int(horizon_months), 1)
    ts, m = [0], 0
    while m < h:
        if start_month is not None and m >= start_month:
            nxt = m + 12
        elif m < MONTHLY_STEPS:
            nxt = m + 1
        else:
            nxt = m + QUARTER
        if start_month is not None and m < start_month < nxt:
            nxt = start_month
        m = min(nxt, h)
        ts.append(m)
    return ts


def _first_at_or_after(ts: list[int], month: float) -> int:
    """Index of the first boundary ≥ month (the last one when month is past the horizon)."""
    for i, t in enumerate(ts):
        if t >= month - 1e-9:
            return i
    return len(ts) - 1


# ── The deterministic pass ──
def _dest(targets: dict | None, seg_vals: dict[str, float], total: float) -> str:
    """Where released ladder money goes: the target segment furthest under its target (in points), as its key
    ('FD_POOL' / 'P2P_POOL' for the ladder segments; EPF never takes it), else MF_DEBT."""
    if not targets or total <= 0:
        return MF_DEBT
    best, gap = None, 0.0
    for seg, pct in targets.items():
        if seg == EPF or seg not in _SEG_KEY:
            continue
        g = _f(pct) - seg_vals.get(seg, 0.0) / total * 100
        if g > gap + 1e-12:
            best, gap = seg, g
    if best is None:
        return MF_DEBT
    return {FD: "FD_POOL", P2P: "P2P_POOL"}.get(best, best)


def _det_pass(layer: dict, ctx: dict) -> dict:
    """One layer (the state, or the flows) on the no-shock path at each key's μ.

    Decides and records what every simulation then repeats: the routed rupees per step (FD releases, P2P
    receipts not re-lent), the deterministic ladder values per boundary, the rupees released at the start of
    withdrawals, and the glide's trim fraction per boundary. Also gives the mean path (`tot`)."""
    ts, n = ctx["grid"], len(ctx["grid"]) - 1
    start, net, mu = ctx["start"], ctx["net"], ctx["mu"]
    V = list(layer["V"])
    pool = 0.0                                   # the glide's FD pool
    fds = [dict(f, done=False) for f in layer["fds"]]
    loans = [dict(ln) for ln in layer["loans"]]
    fd_pool, p2p_pool, stuck = layer["fd_pool"], layer["p2p_pool"], layer["stuck"]
    epf, acc, epf_rate, epf_c = layer["epf"], 0.0, layer["epf_rate"], layer["epf_c"]
    F = [list(row) for row in layer["F"]]
    pin = layer["pool_in"]
    route = layer["route"]
    targets = ctx["targets"]
    fd_mu, p2p_mu = ctx["fd_mu"] * net, ctx["p2p_mu"] * net
    p2p_loss_m = 1 - A.P2P_LOSS / 12
    cal = ctx["cal"]
    glide_ev, e0_idx, gl = ctx["glide_ev"], ctx["e0_idx"], ctx["glide"]
    annuity = ctx["annuity_share"]

    def lad_parts():
        fdv = sum(f["value"] for f in fds if not f["done"]) + fd_pool
        p2v = sum(ln["outstanding"] for ln in loans) + p2p_pool + stuck
        return fdv, p2v, epf + acc

    def seg_values():
        out = {k: V[_IDX[k]] for k in STOCH}
        out[MF] = out.get(MF, 0.0) + out.pop(MF_DEBT, 0.0)
        fdv, p2v, ev = lad_parts()
        out[FD], out[P2P], out[EPF] = fdv + pool, p2v, ev
        return out

    lad = [0.0] * (n + 1)
    lad_by = [(0.0, 0.0, 0.0)] * (n + 1)
    tot = [0.0] * (n + 1)
    vals = [None] * (n + 1)
    pools = [0.0] * (n + 1)
    gc = [0.0] * (n + 1)
    contrib = [0.0] * (n + 1)
    routes: list[dict] = []
    release = 0.0
    carve = 0.0
    e0 = None

    def record(b):
        parts = lad_parts()
        lad_by[b] = parts
        lad[b] = sum(parts)
        vals[b] = list(V)
        pools[b] = pool
        tot[b] = sum(V) + pool + lad[b]

    def equity_share():
        e = sum(V[_IDX[k]] for k in EQUITY_KEYS)
        t = sum(V) + pool + sum(lad_parts())
        return e, t

    record(0)
    if gl is not None and e0_idx == 0:
        e, t = equity_share()
        e0 = e / t if t > 0 else None
    for i in range(n):
        t0, t1 = ts[i], ts[i + 1]
        dt = (t1 - t0) / 12
        if start is not None and t0 == start:
            parts = lad_parts()
            release = parts[0] + parts[1] - stuck + parts[2]
            V[_IDX[MF_DEBT]] += release
            for f in fds:
                f["done"] = True
            loans, fd_pool, p2p_pool, stuck, epf, acc = [], 0.0, 0.0, 0.0, 0.0, 0.0
            if annuity:
                c = annuity * V[_IDX[NPS]]
                carve += c
                V[_IDX[MF_DEBT]] += V[_IDX[NPS]] - c
                V[_IDX[NPS]] = 0.0
        if start is None or t0 < start:
            if route:
                sv = seg_values()
                dest = _dest(targets, sv, sum(sv.values()))
                total0 = sum(sv.values())
            routed_fd = routed_p2p = 0.0
            for m in range(t0 + 1, t1 + 1):
                for f in fds:
                    if f["done"]:
                        continue
                    if f["month"] is not None and f["month"] == m:
                        if net < 1 or not f["maturity_value"]:
                            amount = f["value"] * (1 + f["rate"] * net) ** (1 / 12)
                        else:
                            amount = max(f["maturity_value"], f["value"])
                        routed_fd += amount
                        f["done"], f["value"] = True, 0.0
                    else:
                        f["value"] *= (1 + f["rate"] * net) ** (1 / 12)
                receipts = 0.0
                for ln in loans:
                    if ln["months"] <= 0 or ln["outstanding"] <= 0:
                        continue
                    ln["outstanding"] *= p2p_loss_m
                    r = ln["rate"] * net / 12
                    nleft = ln["months"]
                    out = ln["outstanding"]
                    emi = out * r / (1 - (1 + r) ** -nleft) if r > 0 else out / nleft
                    principal = min(emi - out * r, out)
                    ln["outstanding"] = out - principal if nleft > 1 else 0.0
                    ln["months"] = nleft - 1
                    receipts += emi if nleft > 1 else out * (1 + r)
                loans = [ln for ln in loans if ln["months"] > 0 and ln["outstanding"] > 0]
                if receipts > 0:
                    relend = 0.0
                    if route:
                        p2v = sum(ln["outstanding"] for ln in loans) + p2p_pool + stuck
                        relend = min(receipts, max(RELEND_CAP * total0 - p2v, 0.0))
                    p2p_pool += relend
                    routed_p2p += receipts - relend
                p2p_pool *= (1 + p2p_mu) ** (1 / 12)
                fd_pool *= (1 + fd_mu) ** (1 / 12)
                acc += epf * epf_rate / 12
                epf += epf_c
                contrib[i + 1] += epf_c
                if cal[m] == 3:
                    epf, acc = epf + acc, 0.0
            pf, pp, pe = pin[i]
            if pf or pp or pe:
                fd_pool += pf
                p2p_pool += pp
                epf += pe
            routed = routed_fd + routed_p2p
            if routed > 0:
                if dest == "FD_POOL":
                    fd_pool += routed
                elif dest == "P2P_POOL":
                    p2p_pool += routed
                else:
                    F[i][_IDX[dest]] += routed
                for src, amt in ((FD, routed_fd), (P2P, routed_p2p)):
                    if amt > 0:
                        routes.append({"month": t1, "from": src, "to": {"FD_POOL": FD, "P2P_POOL": P2P}.get(dest, dest),
                                       "amount": round(amt, 2)})
        for k in range(6):
            g = (1 + mu[k]) ** dt
            V[k] = V[k] * g + (F[i][k] * math.sqrt(g) if F[i][k] else 0.0)
        pool *= (1 + fd_mu) ** dt
        b = i + 1
        if gl is not None:
            if e0 is None and b >= e0_idx:
                e, t = equity_share()
                if t > 0 and e > 0:
                    e0 = e / t
            if b in glide_ev and e0 is not None:
                e, t = equity_share()
                target = max(gl["floor"], e0 - gl["step"] * glide_ev[b])
                if e > target * t and e > 0:
                    c = 1 - target * t / e
                    gc[b] = c
                    moved = 0.0
                    for k in EQUITY_KEYS:
                        mv = V[_IDX[k]] * c
                        V[_IDX[k]] -= mv
                        moved += mv
                    V[_IDX[MF_DEBT]] += moved / 2
                    pool += moved / 2
        record(b)
    return {"F": F, "lad": lad, "lad_by": lad_by, "tot": tot, "vals": vals, "pools": pools, "gc": gc,
            "contrib": contrib, "routes": routes, "release": release, "carve": carve}


# ── The simulation ──
def _layer(V, F, pool_in, *, fds=(), loans=(), fd_pool=0.0, p2p_pool=0.0, stuck=0.0, epf=0.0, epf_rate=0.0,
           epf_c=0.0, route=False) -> dict:
    return {"V": V, "F": F, "pool_in": pool_in, "fds": list(fds), "loans": list(loans), "fd_pool": fd_pool,
            "p2p_pool": p2p_pool, "stuck": stuck, "epf": epf, "epf_rate": epf_rate, "epf_c": epf_c, "route": route}


def run(state, flows, book, *, horizon_months, sims=1000, seed=42, real=False, inflation=None, after_tax=False,
        slab_rate=0.30, shock=None, glide=None, withdrawals=None, goals=None, milestones=None, sample_months=None,
        keep_paths=False, probe=None) -> dict:
    """Simulate the state and its flows to `horizon_months` (K8).

    Options
    - `shock` {key: fraction}: applied to values at t = 0, before any growth (stress-to-plan).
    - `glide` {current_age, start_age 45, floor 0.30, step 0.01}: at each year end from `start_age` the equity
      share (Equity India + USA + Mutual Funds) is trimmed to max(floor, e₀ − step × years); the excess goes
      half to MF_DEBT and half to an FD pool at the Book's FD μ. It never buys equity.
    - `withdrawals` {start_month, annual, growth, until_month, annuity?}: at `start_month` EPF and the open
      ladders are released to MF_DEBT (a defaulted loan is written off); with `annuity` ({share 0.4, rate 0.06}
      or True) that share of NPS buys an annuity and the rest joins MF_DEBT. At the start of each year
      W_k = annual × (1+growth)^k, less the annuity income, is taken pro rata by value; a path that cannot pay
      it is depleted (value 0, month recorded).
    - `after_tax`: FD and P2P accrue at rate × (1 − slab × 1.04), and the horizon value "if sold" pays equity
      LTCG above ₹1.25 L, 12.5% × 1.04 on US equity and commodity gains and slab × 1.04 on debt-fund gains.
    - `goals` [{id, alloc {key: share of that key's starting value}, target, month, flows [indices into flows]}]:
      valued on the same draws. A flow with `goal_only: True` counts for goals only, not the totals.
    - `milestones` [amounts], `sample_months` [months] (`at`, sorted path values), `keep_paths` (`paths`
      {month: {total, state[, probe]}} in simulation order, for the linear decompositions K10 uses).
    - `probe` [flows]: a third layer grown on the same draws with the same routing and glide, never added to the
      totals; with `keep_paths` its per-path value at each sample month is `paths[m]['probe']`. Retirement uses
      it for B_i (the value of ₹1 a month) without a second run. Tracked only up to the last sample month, and
      meaningful only up to `start_month` (it takes no part in releases or withdrawals).

    Result: {years [{year, p10, p25, p50, p75, p90, contributed, by_key_p50}], expected, no_flow_p50, milestones,
    prob_below_contributed_3y, max_drawdown_p50 (percent), at, paths?, depletion, goals, after_tax, routes,
    annuity, sims, seed, steps, notes}.
    """
    H = max(int(horizon_months), 1)
    sims = max(int(sims), 2)
    sims += sims % 2
    pairs = sims // 2
    infl = A.INFLATION if inflation is None else float(inflation)
    slab = max(min(_f(slab_rate), 0.5), 0.0)
    net = (1 - slab * CESS) if after_tax else 1.0
    shock = shock or {}
    W = withdrawals or None
    start = int(W["start_month"]) if W else None
    if start is not None and start < 0:
        start = 0
    ts = grid(H, start)
    n = len(ts) - 1
    low, _pivot = stochastic_cholesky()
    mus = [_ms(book, k)[0] for k in STOCH]
    sigs = [_ms(book, k)[1] for k in STOCH]
    fd_mu, p2p_mu, epf_mu = _ms(book, FD)[0], _ms(book, P2P)[0], _ms(book, EPF)[0]
    today = state.get("today") or date.today()
    cal = [0] + [add_months(today, m).month for m in range(1, H + 1)]
    step_of = [0] * (H + 1)
    for i in range(n):
        for m in range(ts[i] + 1, ts[i + 1] + 1):
            step_of[m] = i
    notes: list[str] = []

    # ── initial values (post-shock) and the state layer ──
    V0 = [state["values"].get(k, 0.0) * (1 + _f(shock.get(k))) for k in STOCH]
    basis0 = [state["basis"].get(k, 0.0) for k in STOCH]
    s_fd, s_p2p = 1 + _f(shock.get(FD)), 1 + _f(shock.get(P2P))
    fds0 = [dict(f, value=f["value"] * s_fd, maturity_value=(f["maturity_value"] * s_fd if f["maturity_value"] else None))
            for f in state.get("fds") or []]
    loans0 = [dict(ln, outstanding=ln["outstanding"] * s_p2p) for ln in state.get("loans") or []]
    epf_s = state.get("epf") or {}
    targets = state.get("targets")
    release0 = _f(state.get("release0")) * s_fd
    if release0 > 0:   # A28: a matured, unrecorded FD moves at step 0
        seg = {k: V0[_IDX[k]] for k in STOCH}
        seg[MF] = seg.get(MF, 0.0) + seg.pop(MF_DEBT, 0.0)
        dest0 = _dest(targets, seg, sum(seg.values()) + release0)
        dest0 = MF_DEBT if dest0 in ("FD_POOL", "P2P_POOL") else dest0
        V0[_IDX[dest0]] += release0
        basis0[_IDX[dest0]] += release0
    F0 = [[0.0] * 6 for _ in range(n)]
    pin0 = [(0.0, 0.0, 0.0)] * n
    L0 = _layer(V0, F0, pin0, fds=fds0, loans=loans0, p2p_pool=_f(state.get("p2p_pool")) * s_p2p,
                stuck=_f(state.get("stuck")) * s_p2p, epf=_f(epf_s.get("value")) * (1 + _f(shock.get(EPF))),
                epf_rate=_f(epf_s.get("rate")) or epf_mu,      # EPF interest is exempt: never netted for tax
                epf_c=_f(epf_s.get("monthly")), route=True)

    # ── the flows layer, and the probe layer (tracked on the same draws, never in the totals) ──
    def flow_layer(fls):
        F = [[0.0] * 6 for _ in range(n)]
        pin = [[0.0, 0.0, 0.0] for _ in range(n)]
        added = [0.0] * (n + 1)
        has = False
        for fl in fls:
            if fl.get("goal_only"):
                continue
            key = fl.get("key") or MF
            for m, amt in (fl.get("months") or {}).items():
                m = int(m)
                if not 1 <= m <= H or not amt or (start is not None and m > start):
                    continue
                i = step_of[m]
                if key in _IDX:
                    F[i][_IDX[key]] += amt
                elif key in (FD, P2P, EPF):
                    pin[i][(FD, P2P, EPF).index(key)] += amt
                else:
                    F[i][_IDX[MF]] += amt
                added[i + 1] += amt
                has = True
        return _layer([0.0] * 6, F, [tuple(x) for x in pin], epf_rate=_f(epf_s.get("rate")) or epf_mu), added, has

    flows = list(flows or [])
    L1, flow_in, has_l1 = flow_layer(flows)
    L2, _probe_in, has_l2 = flow_layer(probe or [])

    # ── glide schedule ──
    gl = None
    glide_ev: dict[int, int] = {}
    e0_idx = 0
    if glide:
        gl = {**GLIDE_DEFAULTS, **{k: v for k, v in glide.items() if v is not None}}
        cur = _f(gl.get("current_age"))
        g0 = max(0, int(round((_f(gl["start_age"]) - cur) * 12))) if gl.get("current_age") is not None else 0
        e0_idx = _first_at_or_after(ts, g0) if g0 <= H else n + 1
        k = 1
        while g0 + 12 * k <= H:
            glide_ev[_first_at_or_after(ts, g0 + 12 * k)] = k
            k += 1
        gl["floor"], gl["step"] = _f(gl["floor"]), _f(gl["step"])

    annuity_share = annuity_rate = 0.0
    if W and W.get("annuity"):
        an = W["annuity"] if isinstance(W["annuity"], dict) else {}
        annuity_share = _f(an.get("share", ANNUITY_SHARE))
        annuity_rate = _f(an.get("rate", ANNUITY_RATE))
    ctx = {"grid": ts, "start": start, "net": net, "mu": mus, "targets": targets, "fd_mu": fd_mu, "p2p_mu": p2p_mu,
           "cal": cal, "glide_ev": glide_ev, "e0_idx": e0_idx, "glide": gl, "annuity_share": annuity_share}
    D0 = _det_pass(L0, ctx)
    D1 = _det_pass(L1, {**ctx, "targets": None}) if has_l1 else None
    D2 = _det_pass(L2, {**ctx, "targets": None}) if has_l2 else None

    # ── withdrawals schedule ──
    wd: dict[int, float] = {}
    if W:
        until = int(W.get("until_month") or H)
        k = 0
        while start + 12 * k < min(until, H):
            idx = _first_at_or_after(ts, start + 12 * k)
            wd[idx] = wd.get(idx, 0.0) + _f(W.get("annual")) * (1 + _f(W.get("growth"))) ** k
            k += 1
    sb = ts.index(start) if (start is not None and start in ts and start < H) else None

    # ── active keys and per-step coefficients ──
    goal_specs = []
    for g in goals or []:
        alloc = {k: _f(x) for k, x in (g.get("alloc") or {}).items() if _f(x) > 0}
        fl_idx = [j for j in (g.get("flows") or []) if 0 <= j < len(flows)]
        goal_specs.append({"id": g.get("id"), "alloc": alloc, "target": _f(g.get("target")),
                           "b": _first_at_or_after(ts, max(_f(g.get("month")), 0)), "flows": fl_idx})
    active = [False] * 6
    for k in range(6):
        if (V0[k] > 0 or any(F0r[k] for F0r in D0["F"]) or (has_l1 and any(r[k] for r in D1["F"]))
                or (has_l2 and any(r[k] for r in D2["F"]))):
            active[k] = True
    if gl is not None or W:
        active[_IDX[MF_DEBT]] = True
    for gs in goal_specs:
        for j in gs["flows"]:
            if flows[j].get("key") in _IDX:
                active[_IDX[flows[j]["key"]]] = True
    act = [k for k in range(6) if active[k]]
    na = len(act)
    pos = {k: a for a, k in enumerate(act)}
    eq_a = [pos[_IDX[k]] for k in EQUITY_KEYS if _IDX[k] in pos]
    mfd_a = pos.get(_IDX[MF_DEBT])
    nps_a = pos.get(_IDX[NPS])
    drift = [math.log(1 + mus[k]) - sigs[k] ** 2 / 2 for k in range(6)]
    Ag, Mg, F0g, F1g, F2g, poolg = [], [], [], [], [], []
    for i in range(n):
        dt = (ts[i + 1] - ts[i]) / 12
        sq = math.sqrt(dt)
        Ag.append([math.exp(drift[k] * dt) for k in act])
        Mg.append([tuple(sigs[k] * sq * low[k][m] for m in range(6)) for k in act])
        r0 = [D0["F"][i][k] for k in act]
        F0g.append(r0 if any(r0) else None)
        if has_l1:
            r1 = [D1["F"][i][k] for k in act]
            F1g.append(r1 if any(r1) else None)
        else:
            F1g.append(None)
        if has_l2:
            r2 = [D2["F"][i][k] for k in act]
            F2g.append(r2 if any(r2) else None)
        else:
            F2g.append(None)
        poolg.append((1 + fd_mu * net) ** dt)
    gc0 = D0["gc"]
    gc1 = D1["gc"] if has_l1 else [0.0] * (n + 1)
    gc2 = D2["gc"] if has_l2 else [0.0] * (n + 1)
    lad2 = D2["lad"] if has_l2 else [0.0] * (n + 1)
    lad0 = D0["lad"]
    lad1 = D1["lad"] if has_l1 else [0.0] * (n + 1)
    ladT = [lad0[b] + lad1[b] for b in range(n + 1)]
    rel0 = D0["release"]
    rel1 = D1["release"] if has_l1 else 0.0
    use_pool = gl is not None

    # what to record
    nyears = H // 12
    year_b = [_first_at_or_after(ts, 12 * y) for y in range(nyears + 1)]
    samples = sorted({max(0, min(int(m), H)) for m in (sample_months or [])})
    sample_b = {m: _first_at_or_after(ts, m) for m in samples}
    m36 = min(36, H)
    b36 = _first_at_or_after(ts, m36)
    rec_b = set(year_b) | set(sample_b.values()) | {b36, n}
    rec_tot = {b: [] for b in rec_b}
    rec_state = {b: [] for b in rec_b}
    probe_stop = max(sample_b.values(), default=0) if has_l2 else 0     # the probe is grown only this far
    rec_probe = {b: [] for b in sample_b.values()} if has_l2 else {}
    by_key_b = set(year_b)
    rec_key = {b: [[] for _ in range(na)] for b in by_key_b}
    rec_pool = {b: [] for b in by_key_b} if use_pool else {}
    ms_list = sorted(_f(x) for x in (milestones or []) if _f(x) > 0)
    nms = len(ms_list)
    ms_hits: list[list[int]] = [[] for _ in range(nms)]
    dd_all: list[float] = []
    dep_months: list[int | None] = []
    ann_income: list[float] = []
    after_vals: list[float] = []
    goal_vals: list[list[float]] = [[] for _ in goal_specs]

    # goals: starting values per key and per-step flows into their keys
    gspec_rt = []
    for gs in goal_specs:
        init = [0.0] * na
        det0 = 0.0
        det_keys = []
        for k, share in gs["alloc"].items():
            if k in _IDX:
                if _IDX[k] in pos:
                    init[pos[_IDX[k]]] += share * V0[_IDX[k]]
            elif k in LADDERS:
                lv = {FD: sum(f["value"] for f in fds0), P2P: sum(ln["outstanding"] for ln in loans0)
                      + _f(state.get("p2p_pool")) * s_p2p, EPF: _f(epf_s.get("value"))}[k]
                det_keys.append((share * lv, {FD: fd_mu * net, P2P: p2p_mu * net, EPF: epf_mu}[k]))
        Fg = [None] * n
        det_flow = [0.0] * n
        for j in gs["flows"]:
            key = flows[j].get("key") or MF
            for m, amt in (flows[j].get("months") or {}).items():
                m = int(m)
                if not 1 <= m <= H or not amt:
                    continue
                i = step_of[m]
                if key in _IDX and _IDX[key] in pos:
                    if Fg[i] is None:
                        Fg[i] = [0.0] * na
                    Fg[i][pos[_IDX[key]]] += amt
                else:
                    det_flow[i] += amt
        # the deterministic part of the goal's value at its boundary (ladder keys and flows into them)
        months_b = ts[gs["b"]]
        for lv, r in det_keys:
            det0 += lv * (1 + r) ** (months_b / 12)
        for i in range(gs["b"]):
            if det_flow[i]:
                det0 += det_flow[i] * (1 + fd_mu * net) ** ((months_b - (ts[i] + ts[i + 1]) / 2) / 12)
        gspec_rt.append((init, Fg, det0, gs["b"]))
    track_g = bool(gspec_rt)

    exp, sqrt = math.exp, math.sqrt
    V0a = [V0[k] for k in act]
    B0a = [basis0[k] for k in act]
    for j in range(pairs):
        rng = random.Random(seed * SEED_STRIDE + j)
        gauss = rng.gauss
        zs = [gauss(0.0, 1.0) for _ in range(6 * n)]
        P0, Q0 = list(V0a), list(V0a)
        P1, Q1 = [0.0] * na, [0.0] * na
        P2, Q2 = [0.0] * na, [0.0] * na
        pp0 = pq0 = pp1 = pq1 = pp2 = pq2 = 0.0
        bP, bQ = (list(B0a), list(B0a)) if after_tax else (None, None)
        if 0 in rec_probe:
            rec_probe[0].append(lad2[0])
            rec_probe[0].append(lad2[0])
        ptot = qtot = sum(V0a) + ladT[0]
        peakP = peakQ = ptot
        ddP = ddQ = 0.0
        miP = miQ = 0
        depP = depQ = None
        incP = incQ = 0.0
        gP = [list(gr[0]) for gr in gspec_rt]
        gQ = [list(gr[0]) for gr in gspec_rt]
        for gi, gr in enumerate(gspec_rt):
            if gr[3] == 0:   # a goal due now: its starting value
                goal_vals[gi].append(sum(gr[0]) + gr[2])
                goal_vals[gi].append(sum(gr[0]) + gr[2])
        if 0 in rec_b:
            rec_tot[0].append(ptot)
            rec_tot[0].append(qtot)
            s0 = sum(V0a) + lad0[0]
            rec_state[0].append(s0)
            rec_state[0].append(s0)
            if 0 in by_key_b:
                for a in range(na):
                    rec_key[0][a].append(V0a[a])
                    rec_key[0][a].append(V0a[a])
                if use_pool:
                    rec_pool[0].append(0.0)
                    rec_pool[0].append(0.0)
        if nms:
            while miP < nms and ptot >= ms_list[miP]:
                ms_hits[miP].append(0)
                ms_hits[miP].append(0)
                miP += 1
            miQ = miP
        for i in range(n):
            # start-of-step events at boundary i: withdrawals begin, then the year's withdrawal
            if i == sb:
                if mfd_a is not None:
                    P0[mfd_a] += rel0
                    Q0[mfd_a] += rel0
                    P1[mfd_a] += rel1
                    Q1[mfd_a] += rel1
                    if after_tax:
                        bP[mfd_a] += rel0 + rel1
                        bQ[mfd_a] += rel0 + rel1
                if annuity_share and nps_a is not None and mfd_a is not None:
                    cP = annuity_share * (P0[nps_a] + P1[nps_a])
                    cQ = annuity_share * (Q0[nps_a] + Q1[nps_a])
                    incP, incQ = cP * annuity_rate, cQ * annuity_rate
                    if after_tax:   # the 60% lump sum joins MF_DEBT at its value (NPS itself is never taxed)
                        bP[mfd_a] += (P0[nps_a] + P1[nps_a]) * (1 - annuity_share)
                        bQ[mfd_a] += (Q0[nps_a] + Q1[nps_a]) * (1 - annuity_share)
                        bP[nps_a] = bQ[nps_a] = 0.0
                    for X in (P0, Q0, P1, Q1):
                        X[mfd_a] += X[nps_a] * (1 - annuity_share)
                        X[nps_a] = 0.0
            if i in wd:
                wk = wd[i]
                for side in (0, 1):
                    if side == 0:
                        if depP is not None:
                            continue
                        X0, X1, inc = P0, P1, incP
                        tot_now = sum(X0) + sum(X1) + pp0 + pp1
                    else:
                        if depQ is not None:
                            continue
                        X0, X1, inc = Q0, Q1, incQ
                        tot_now = sum(X0) + sum(X1) + pq0 + pq1
                    need = max(wk - inc, 0.0)
                    if need <= 0:
                        continue
                    if tot_now < need or tot_now <= 0:
                        for a in range(na):
                            X0[a] = 0.0
                            X1[a] = 0.0
                        if side == 0:
                            pp0 = pp1 = 0.0
                            depP = ts[i]
                        else:
                            pq0 = pq1 = 0.0
                            depQ = ts[i]
                    else:
                        fct = 1 - need / tot_now
                        for a in range(na):
                            X0[a] *= fct
                            X1[a] *= fct
                        if side == 0:
                            pp0 *= fct
                            pp1 *= fct
                            if after_tax:
                                for a in range(na):
                                    bP[a] *= fct
                        else:
                            pq0 *= fct
                            pq1 *= fct
                            if after_tax:
                                for a in range(na):
                                    bQ[a] *= fct
            # growth with mid-step flows
            b6 = 6 * i
            z0, z1, z2, z3, z4, z5 = zs[b6], zs[b6 + 1], zs[b6 + 2], zs[b6 + 3], zs[b6 + 4], zs[b6 + 5]
            Ai, Mi, f0, f1 = Ag[i], Mg[i], F0g[i], F1g[i]
            if track_g:
                GA, GB = [0.0] * na, [0.0] * na
            for a in range(na):
                c = Mi[a]
                e = exp(c[0] * z0 + c[1] * z1 + c[2] * z2 + c[3] * z3 + c[4] * z4 + c[5] * z5)
                aa = Ai[a]
                ga = aa * e
                gb = aa / e
                if track_g:
                    GA[a], GB[a] = ga, gb
                if f0 is not None and f0[a]:
                    x = f0[a]
                    P0[a] = P0[a] * ga + x * sqrt(ga)
                    Q0[a] = Q0[a] * gb + x * sqrt(gb)
                    if after_tax:
                        bP[a] += x
                        bQ[a] += x
                else:
                    P0[a] *= ga
                    Q0[a] *= gb
                if has_l1:
                    if f1 is not None and f1[a]:
                        x = f1[a]
                        P1[a] = P1[a] * ga + x * sqrt(ga)
                        Q1[a] = Q1[a] * gb + x * sqrt(gb)
                        if after_tax:
                            bP[a] += x
                            bQ[a] += x
                    else:
                        P1[a] *= ga
                        Q1[a] *= gb
                if i < probe_stop:
                    f2 = F2g[i]
                    if f2 is not None and f2[a]:
                        x = f2[a]
                        P2[a] = P2[a] * ga + x * sqrt(ga)
                        Q2[a] = Q2[a] * gb + x * sqrt(gb)
                    else:
                        P2[a] *= ga
                        Q2[a] *= gb
            b = i + 1
            if i < probe_stop and use_pool:
                pp2 *= poolg[i]
                pq2 *= poolg[i]
                c2 = gc2[b]
                if c2:
                    for X2, side in ((P2, 0), (Q2, 1)):
                        m2 = 0.0
                        for a in eq_a:
                            v2 = X2[a] * c2
                            X2[a] -= v2
                            m2 += v2
                        X2[mfd_a] += m2 / 2
                        if side == 0:
                            pp2 += m2 / 2
                        else:
                            pq2 += m2 / 2
            if b in rec_probe:
                rec_probe[b].append(sum(P2) + pp2 + lad2[b])
                rec_probe[b].append(sum(Q2) + pq2 + lad2[b])
            if use_pool:
                pg = poolg[i]
                pp0 *= pg
                pq0 *= pg
                pp1 *= pg
                pq1 *= pg
                c0, c1 = gc0[b], gc1[b]
                if c0 or c1:
                    for side in (0, 1):
                        X0, X1, bs = (P0, P1, bP) if side == 0 else (Q0, Q1, bQ)
                        m0 = m1 = 0.0
                        for a in eq_a:
                            v0, v1 = X0[a] * c0, X1[a] * c1
                            if after_tax:
                                full = X0[a] + X1[a]
                                if full > 0:
                                    bs[a] *= 1 - (v0 + v1) / full
                            X0[a] -= v0
                            X1[a] -= v1
                            m0 += v0
                            m1 += v1
                        X0[mfd_a] += m0 / 2
                        X1[mfd_a] += m1 / 2
                        if after_tax:
                            bs[mfd_a] += (m0 + m1) / 2
                        if side == 0:
                            pp0 += m0 / 2
                            pp1 += m1 / 2
                        else:
                            pq0 += m0 / 2
                            pq1 += m1 / 2
            if track_g:
                for gi, (init, Fg, det0, gb_idx) in enumerate(gspec_rt):
                    if b > gb_idx:
                        continue
                    xp, xq = gP[gi], gQ[gi]
                    fg = Fg[i]
                    for a in range(na):
                        if fg is not None and fg[a]:
                            xp[a] = xp[a] * GA[a] + fg[a] * sqrt(GA[a])
                            xq[a] = xq[a] * GB[a] + fg[a] * sqrt(GB[a])
                        else:
                            xp[a] *= GA[a]
                            xq[a] *= GB[a]
                    if b == gb_idx:
                        goal_vals[gi].append(sum(xp) + det0)
                        goal_vals[gi].append(sum(xq) + det0)
            lt = ladT[b]
            sp0, sq0 = sum(P0) + pp0, sum(Q0) + pq0
            ptot = sp0 + (sum(P1) + pp1 if has_l1 else 0.0) + lt
            qtot = sq0 + (sum(Q1) + pq1 if has_l1 else 0.0) + lt
            if b in rec_b:
                rec_tot[b].append(ptot)
                rec_tot[b].append(qtot)
                rec_state[b].append(sp0 + lad0[b])
                rec_state[b].append(sq0 + lad0[b])
                if b in by_key_b:
                    rk = rec_key[b]
                    for a in range(na):
                        rk[a].append(P0[a] + P1[a])
                        rk[a].append(Q0[a] + Q1[a])
                    if use_pool:
                        rec_pool[b].append(pp0 + pp1)
                        rec_pool[b].append(pq0 + pq1)
            if nms:
                while miP < nms and ptot >= ms_list[miP]:
                    ms_hits[miP].append(ts[b])
                    miP += 1
                while miQ < nms and qtot >= ms_list[miQ]:
                    ms_hits[miQ].append(ts[b])
                    miQ += 1
            if ptot > peakP:
                peakP = ptot
            elif peakP > 0:
                x = 1 - ptot / peakP
                if x > ddP:
                    ddP = x
            if qtot > peakQ:
                peakQ = qtot
            elif peakQ > 0:
                x = 1 - qtot / peakQ
                if x > ddQ:
                    ddQ = x
        dd_all.append(ddP)
        dd_all.append(ddQ)
        dep_months.append(depP)
        dep_months.append(depQ)
        ann_income.append(incP)
        ann_income.append(incQ)
        if after_tax:
            for X0, X1, bs, tot_h in ((P0, P1, bP, ptot), (Q0, Q1, bQ, qtot)):
                tax = 0.0
                eq_gain = 0.0
                for a, k in enumerate(act):
                    key = STOCH[k]
                    gain = X0[a] + X1[a] - bs[a]
                    if key in (EQ_IN, MF):
                        eq_gain += gain
                    elif key in (EQ_US, COMM):
                        tax += max(gain, 0.0) * LTCG_RATE * CESS
                    elif key == MF_DEBT:
                        tax += max(gain, 0.0) * slab * CESS
                tax += max(eq_gain - LTCG_EXEMPTION, 0.0) * LTCG_RATE * CESS
                after_vals.append(tot_h - tax)

    # ── assemble ──
    def defl(month: float) -> float:
        return (1 + infl) ** (month / 12) if real else 1.0

    contributed = [0.0] * (n + 1)
    run_c = sum(V0) + lad0[0] + (lad1[0] if has_l1 else 0.0)
    contributed[0] = run_c
    for b in range(1, n + 1):
        run_c += flow_in[b] + D0["contrib"][b]
        contributed[b] = run_c

    # the mean path: the deterministic layers, scaled by the withdrawals they would pay
    det_tot = [D0["tot"][b] + (D1["tot"][b] if has_l1 else 0.0) for b in range(n + 1)]
    expected = list(det_tot)
    if W:
        kappa = 1.0
        carve = D0["carve"] + (D1["carve"] if has_l1 else 0.0)
        income = carve * annuity_rate
        for b in range(n + 1):
            expected[b] = det_tot[b] * kappa
            if b in wd and b < n:
                base = det_tot[b] - (carve if b == sb else 0.0)
                tnow = base * kappa
                need = max(wd[b] - income, 0.0)
                if tnow <= 0 or tnow < need:
                    kappa = 0.0
                elif need > 0:
                    kappa *= 1 - need / tnow

    years = []
    for y, b in enumerate(year_b):
        xs = sorted(rec_tot[b])
        f = defl(ts[b])
        by_key = {}
        for a, k in enumerate(act):
            vals_k = sorted(rec_key[b][a])
            med = _pctl(vals_k, 0.5)
            if med > 0.005:
                by_key[STOCH[k]] = round(med / f, 2)
        fdv, p2v, ev = D0["lad_by"][b]
        if has_l1:
            a1, b1, c1 = D1["lad_by"][b]
            fdv, p2v, ev = fdv + a1, p2v + b1, ev + c1
        if use_pool:
            fdv += _pctl(sorted(rec_pool[b]), 0.5)
        for key, v in ((FD, fdv), (P2P, p2v), (EPF, ev)):
            if v > 0.005:
                by_key[key] = round(v / f, 2)
        years.append({"year": y, "month": ts[b], "p10": round(_pctl(xs, 0.10) / f, 2), "p25": round(_pctl(xs, 0.25) / f, 2),
                      "p50": round(_pctl(xs, 0.50) / f, 2), "p75": round(_pctl(xs, 0.75) / f, 2),
                      "p90": round(_pctl(xs, 0.90) / f, 2), "contributed": round(contributed[b], 2), "by_key_p50": by_key})
    no_flow = [round(_pctl(sorted(rec_state[b]), 0.5) / defl(ts[b]), 2) for b in year_b]
    exp_years = [round(expected[b] / defl(ts[b]), 2) for b in year_b]

    ms_out = []
    for amt, hits in zip(ms_list, ms_hits):
        hits = sorted(hits)
        ms_out.append({"amount": amt, "probability": round(len(hits) / sims * 100, 1),
                       "median_months": hits[len(hits) // 2] if hits else None})

    end36 = rec_tot[b36]
    below = sum(1 for v in end36 if v < contributed[b36]) / len(end36) * 100 if end36 else 0.0
    at = {m: [v / defl(ts[sample_b[m]]) for v in sorted(rec_tot[sample_b[m]])] for m in samples}
    result = {
        "years": years, "expected": exp_years, "no_flow_p50": no_flow, "milestones": ms_out,
        "prob_below_contributed_3y": round(below, 1),
        "max_drawdown_p50": round(_pctl(sorted(dd_all), 0.5) * 100, 1),
        "at": at, "depletion": None, "goals": [], "after_tax": None, "routes": D0["routes"], "annuity": None,
        "sims": sims, "seed": seed, "steps": n, "grid": ts, "notes": notes,
    }
    if keep_paths:
        result["paths"] = {m: {"total": [v / defl(ts[sample_b[m]]) for v in rec_tot[sample_b[m]]],
                               "state": [v / defl(ts[sample_b[m]]) for v in rec_state[sample_b[m]]]} for m in samples}
        if has_l2:
            for m in samples:
                result["paths"][m]["probe"] = [v / defl(ts[sample_b[m]]) for v in rec_probe[sample_b[m]]]
    if W:
        lasts = sum(1 for x in dep_months if x is None)
        result["depletion"] = {"lasts_pct": round(lasts / sims * 100, 1),
                               "ages": sorted(dep_months, key=lambda x: (x is None, x or 0))}
        if annuity_share:
            inc = sorted(ann_income)
            result["annuity"] = {"share": annuity_share, "rate": annuity_rate, "income_p50": round(_pctl(inc, 0.5), 2)}
    for gs, vals_g in zip(goal_specs, goal_vals):
        xs = sorted(vals_g)
        hit = sum(1 for v in xs if v >= gs["target"]) if xs else 0
        result["goals"].append({"id": gs["id"], "probability": round(hit / len(xs) * 100, 1) if xs else None,
                                "p10": round(_pctl(xs, 0.10), 2), "p50": round(_pctl(xs, 0.50), 2),
                                "p90": round(_pctl(xs, 0.90), 2)})
    if after_tax:
        xs = sorted(after_vals)
        f = defl(ts[n])
        result["after_tax"] = {"p10": round(_pctl(xs, 0.10) / f, 2), "p50": round(_pctl(xs, 0.50) / f, 2),
                               "p90": round(_pctl(xs, 0.90) / f, 2), "note": AFTER_TAX_NOTE}
        notes.append(f"After tax: {AFTER_TAX_NOTE}.")
    return result
