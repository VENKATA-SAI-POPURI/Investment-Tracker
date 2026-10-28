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

    lo, hi = -0.9999, 10.0
    f_lo, f_hi = _npv(lo, fl, d0), _npv(hi, fl, d0)
    # Expand the upper bound for very short, very profitable windows
    while f_lo * f_hi > 0 and hi < 1e6:
        hi *= 10
        f_hi = _npv(hi, fl, d0)
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):  # bisection: slower than Newton but never diverges
        mid = (lo + hi) / 2
        f_mid = _npv(mid, fl, d0)
        if abs(f_mid) < 1e-7 or (hi - lo) < 1e-10:
            return mid
        if f_lo * f_mid < 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return (lo + hi) / 2


def annualise(total_return: float, days: int) -> float | None:
    if days <= 0 or total_return <= -1:
        return None
    return (1 + total_return) ** (365.0 / days) - 1
