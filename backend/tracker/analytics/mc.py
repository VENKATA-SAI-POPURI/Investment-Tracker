"""Monte Carlo helpers shared by goals and retirement (SPEC §6.4, §7.1; AMENDMENTS E17).

`required_sip_for` answers "what monthly SIP reaches the target in 75 of 100 futures?" on yearly
log-normal steps with common random numbers, so the answer is stable and monotone in the target.
Imports only the standard library, the Book and `quant.percentile`; `quant` must never import `mc`.
"""
from __future__ import annotations

import math
import random

from .assumptions import typical
from .quant import percentile as pctl

__all__ = ["annual_shocks", "required_sip_for", "pctl", "SIMS"]

SIMS = 400


def annual_shocks(seed: int, sims: int, years: int) -> list[list[float]]:
    """Z[sims][years] of standard normals from random.Random(seed).gauss(0, 1), drawn row by row."""
    rng = random.Random(seed)
    return [[rng.gauss(0.0, 1.0) for _ in range(years)] for _ in range(sims)]


def _year_fracs(months: int) -> list[float]:
    """Length of each simulated year as a fraction: full years, then the partial last year."""
    years = math.ceil(months / 12)
    last = (months - 12 * (years - 1)) / 12
    return [1.0] * (years - 1) + [last]


def _terminal_parts(pv: float, months: int, mu: float, sigma: float, step_up: float, z: list[float]) -> tuple[float, float]:
    """(A, B) with terminal value = A + sip × B along one path of yearly shocks `z`.

    Growth in year k is exp((ln(1+μ) − σ²/2)·f + σ·√f·Z), f the fraction of the year (1 except the last): over
    a fraction f of a year the log-return's mean scales with f and its variance with f (σ²f), so the shock
    scales with √f (W2 review, amends E17). The year's 12·f instalments go in mid-year (× √growth) and rise by
    `step_up` every 12 months."""
    drift = math.log(1 + mu) - sigma * sigma / 2
    a, b = pv, 0.0
    for k, f in enumerate(_year_fracs(months)):
        g = math.exp(drift * f + sigma * math.sqrt(f) * z[k])
        a *= g
        b = b * g + 12 * f * (1 + step_up) ** k * math.sqrt(g)
    return a, b


def _sip_typical(pv: float, months: int, mu: float, sigma: float, target: float, step_up: float) -> float:
    """The deterministic SIP at the typical (median) return, compounded monthly, paid at month end."""
    rm = (1 + typical(mu, sigma)) ** (1 / 12) - 1
    grown = pv * (1 + rm) ** months
    factor = sum((1 + step_up) ** (j // 12) * (1 + rm) ** (months - 1 - j) for j in range(months))
    return max(target - grown, 0.0) / factor if factor > 0 else 0.0


def required_sip_for(pv: float, months: int, mu: float, sigma: float, target: float, prob: float = 0.75,
                     step_up: float = 0.0, seed: int = 0, *, sims: int = SIMS) -> dict:
    """The monthly SIP that reaches `target` in `months` with probability `prob`, and the typical SIP.

    Returns {sip_75, sip_typical}, rounded up to ₹1 (`sip_75` is the SIP for `prob`, 0.75 by default).
    - A target already reached (pv ≥ target) returns {0, 0}.
    - With no months left and the target not reached, no SIP can help: {None, None}.
    - Shocks Z[sims][years] are drawn once (`annual_shocks(seed, …)`, common random numbers). Each
      path's terminal value is linear in the SIP, A_i + s·B_i, so the SIP that meets the target on at
      least ceil(prob·sims) paths is an order statistic of (target − A_i)/B_i. That is the exact limit
      of the 14-step bisection in SPEC §6.4, and it is monotone in the target by construction.
    - `sip_typical` is the deterministic SIP at typical(μ, σ) with monthly compounding. The 75% SIP is
      never reported below it (the two use slightly different contribution timing).
    """
    pv, target = float(pv or 0), float(target or 0)
    months = int(months or 0)
    if pv >= target:
        return {"sip_75": 0, "sip_typical": 0}
    if months <= 0:
        return {"sip_75": None, "sip_typical": None}
    years = math.ceil(months / 12)
    sims = max(int(sims), 1)
    need = min(max(math.ceil(prob * sims - 1e-9), 1), sims)
    per_path = []
    for z in annual_shocks(seed, sims, years):
        a, b = _terminal_parts(pv, months, mu, sigma, step_up, z)
        per_path.append(max(target - a, 0.0) / b if b > 0 else math.inf)
    per_path.sort()
    s75 = per_path[need - 1]
    s_typ = _sip_typical(pv, months, mu, sigma, target, step_up)
    s75 = max(s75, s_typ)
    return {"sip_75": None if math.isinf(s75) else math.ceil(s75 - 1e-9), "sip_typical": math.ceil(s_typ - 1e-9)}
