"""Money-weighted return (XIRR) on irregular dated cash flows."""
from __future__ import annotations

from datetime import date
from typing import Iterable

Flow = tuple[date, float]  # (date, amount) — negative = money invested, positive = money received


def _npv(rate: float, flows: list[Flow], d0: date) -> float:
    return sum(a / (1 + rate) ** ((d - d0).days / 365.0) for d, a in flows)


def xirr(flows: Iterable[Flow]) -> float | None:
    """Annualised internal rate of return as a fraction (0.12 = 12%), or None if undefined."""
    fl = sorted(((d, float(a)) for d, a in flows if a), key=lambda f: f[0])
    if not fl or not any(a < 0 for _, a in fl) or not any(a > 0 for _, a in fl):
        return None
    d0 = fl[0][0]
    if (fl[-1][0] - d0).days < 1:
        return None

    # Flows that switch between money in and money out many times (P2P lending, SIPs with redemptions) can have
    # more than one rate that makes the NPV zero. Like Excel's XIRR (which starts its search at 10%), take the
    # root nearest 10%: scan a grid for sign changes and refine each by bisection.
    grid = [-0.9999, -0.99, -0.95, -0.9, -0.8, -0.6, -0.4, -0.25, -0.15, -0.1, -0.05, 0.0, 0.03, 0.06, 0.1, 0.15, 0.2,
            0.3, 0.45, 0.7, 1.0, 1.5, 2.5, 4.0, 7.0, 10.0, 30.0, 100.0, 1e3, 1e4, 1e6]
    vals = []
    for r in grid:
        try:
            vals.append(_npv(r, fl, d0))
        except OverflowError:
            vals.append(None)
    roots = []
    for (lo, f_lo), (hi, f_hi) in zip(zip(grid, vals), zip(grid[1:], vals[1:])):
        if f_lo is None or f_hi is None:
            continue
        if f_lo == 0:
            roots.append(lo)
            continue
        if f_lo * f_hi > 0:
            continue
        for _ in range(200):  # bisection: slower than Newton but never diverges
            mid = (lo + hi) / 2
            f_mid = _npv(mid, fl, d0)
            if abs(f_mid) < 1e-7 or (hi - lo) < 1e-10:
                break
            if f_lo * f_mid < 0:
                hi, f_hi = mid, f_mid
            else:
                lo, f_lo = mid, f_mid
        roots.append((lo + hi) / 2)
    if not roots:
        return None
    return min(roots, key=lambda r: abs(r - 0.10))


def annualise(total_return: float, days: int) -> float | None:
    if days <= 0 or total_return <= -1:
        return None
    return (1 + total_return) ** (365.0 / days) - 1
