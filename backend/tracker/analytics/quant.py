"""Quantitative read-outs over price series: trend, momentum, volatility, beta and a statistical
projection cone for one holding; value-at-risk, correlations and risk contribution for the portfolio.

Everything here is a pure function over (iso_date, close) lists so it can be tested offline.
Every assumed number (segment μ and σ, correlations, the risk-free rate, the P2P loss and cap) comes
from the Assumption Book (`assumptions`, SPEC §6.1). The cone is a statistical range at the Book's
long-run return and the holding's shrunk volatility (§6.2): it describes how wide the outcomes could
be, not where the price will go, and it never extrapolates momentum.

Imports only `domain`, `assumptions` and the leaf `signals` from the package (AMENDMENTS G3, K16):
never `goals`, `optimizer` or `mc` (mc imports `percentile` from here). The trend, the RSI and the
holding's price signals come from `signals`, the one signal model Markets also reads (SPEC P2.12).
"""
from __future__ import annotations

import math
from bisect import bisect_right
from datetime import date, timedelta

from .. import domain as d
from . import assumptions as A
# Re-exported Book constants (G4: quant.RISK_FREE is the Book's)
from .assumptions import HONESTY, MF_DEBT, P2P_LOSS, P2P_MU_CAP, RATE_KEYS, RISK_FREE

# The one signal model (K16). `signals` is a pure leaf that imports nothing from the package, so G3's
# "no cycle" holds; quant's package imports are exactly {domain, assumptions, signals} (L1).
from . import signals as sg

TRADING_DAYS = 252
Z95 = 1.6449
Z90 = 1.2816

# ── Shrinkage toward the Book prior (SPEC §6.2) ──
SHRINK_MIN_N, SHRINK_FULL_N, SHRINK_CAP = 60, 756, 0.6
BETA_FULL_N, BETA_CAP = 504, 0.7
OWN_N = 504
# A key the Book does not know reads the diversified `Mutual Funds` row (as goals does, W3-B4).
FALLBACK_KEY = d.SEG_MF
# Index that stands in for a holding before its first close (× β_prior = 1). MF_DEBT has none.
NSEI, GSPC, GOLDBEES = "^NSEI", "^GSPC", "GOLDBEES.NS"
PROXY_INDEX = {d.SEG_EQ_IN: NSEI, d.SEG_MF: NSEI, d.SEG_NPS: NSEI, d.SEG_EQ_US: GSPC, d.SEG_COMMODITY: GOLDBEES}
PROXY_LABEL = {NSEI: "Nifty 50", GSPC: "S&P 500 in ₹", GOLDBEES: "GOLDBEES"}
KEY_LABEL = {MF_DEBT: "Mutual Funds (debt)"}
DISCLAIMER = ("Ranges are statistical: they assume the asset class's long-run return and a volatility close to "
              "this holding's own record. They are not predictions or advice.")


def _r(v, n=2):
    return None if v is None else round(v, n)


def log_returns(points: list[tuple[str, float]]) -> list[tuple[str, float]]:
    out, prev = [], None
    for day, px in points:
        if px is None or px <= 0:
            continue
        if prev:
            out.append((day, math.log(px / prev)))
        prev = px
    return out


sma = sg.sma


def change(vals: list[float], n: int) -> float | None:
    """Percent change over the last n observations."""
    return (vals[-1] / vals[-1 - n] - 1) * 100 if len(vals) > n and vals[-1 - n] else None


rsi = sg.rsi     # Wilder's smoothing (K16)


def stdev(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def annual_vol(rets: list[float], window: int | None = None) -> float | None:
    xs = rets[-window:] if window else rets
    return stdev(xs) * math.sqrt(TRADING_DAYS) if len(xs) >= 10 else None


def max_drawdown(vals: list[float]) -> tuple[float, float]:
    peak, mdd, cur = 0.0, 0.0, 0.0
    for v in vals:
        peak = max(peak, v)
        cur = v / peak - 1 if peak else 0.0
        mdd = min(mdd, cur)
    return mdd, cur


def cagr(vals: list[float], years: float) -> float | None:
    if len(vals) < 2 or vals[0] <= 0 or years <= 0:
        return None
    return (vals[-1] / vals[0]) ** (1 / years) - 1


class _FF:
    """Forward-filled lookup over sparse (iso_date, value) points."""

    def __init__(self, points):
        pts = [(p[0], float(p[1])) for p in points if p[1] is not None]
        self.dates = [p[0] for p in pts]
        self.vals = [p[1] for p in pts]

    def at(self, iso: str):
        i = bisect_right(self.dates, iso) - 1
        return self.vals[i] if i >= 0 else None


def daily_grid(series: dict[str, list], start: str, end: str) -> tuple[list[str], dict[str, list[float | None]]]:
    """Weekday grid from start to end; each series forward-filled, so returns line up by date."""
    days, cur, last = [], date.fromisoformat(start), date.fromisoformat(end)
    while cur <= last:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    lookups = {key: _FF(pts) for key, pts in series.items()}
    return days, {key: [ff.at(day) for day in days] for key, ff in lookups.items()}


def returns_on_grid(vals: list[float | None]) -> list[float | None]:
    out: list[float | None] = [None]
    prev = vals[0] if vals else None
    for v in vals[1:]:
        out.append(math.log(v / prev) if v and prev else None)
        prev = v if v else prev
    return out


def beta_corr(a: list[float | None], b: list[float | None]) -> tuple[float | None, float | None]:
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    if len(pairs) < 30:
        return None, None
    n = len(pairs)
    ma = sum(x for x, _ in pairs) / n
    mb = sum(y for _, y in pairs) / n
    cov = sum((x - ma) * (y - mb) for x, y in pairs) / (n - 1)
    va = sum((x - ma) ** 2 for x, _ in pairs) / (n - 1)
    vb = sum((y - mb) ** 2 for _, y in pairs) / (n - 1)
    if vb <= 0 or va <= 0:
        return None, None
    return cov / vb, cov / math.sqrt(va * vb)


def cone(price: float, mu: float, sigma: float, horizons: dict[str, int]) -> dict[str, dict]:
    """Log-normal percentile bands: {label: {p10, p50, p90}} for horizons in trading days.

    `mu` is the continuous drift of the price (the mean of the log return is (mu − σ²/2)·t), so with
    mu = ln(1 + μ) the one-year median is `assumptions.typical(μ, σ)`."""
    out = {}
    for label, days in horizons.items():
        t = days / TRADING_DAYS
        m = (mu - sigma * sigma / 2) * t
        s = sigma * math.sqrt(t)
        out[label] = {"p10": round(price * math.exp(m - Z90 * s), 2), "p50": round(price * math.exp(m), 2),
                      "p90": round(price * math.exp(m + Z90 * s), 2), "days": days}
    return out


def holding_outlook(points: list[tuple[str, float]], bench_points: list[tuple[str, float]] | None = None,
                    segment: str | None = None, today: date | None = None, *, book_key: str | None = None,
                    book: dict | None = None) -> dict | None:
    """Trend, momentum, volatility, beta and a 3M/6M/1Y statistical range for one priced holding.

    None under 30 closes (SPEC §7.8: no cone). The cone (AMENDMENTS G9) is built on the Book, never on
    the holding's own trend:
      - key = `book_key` (pass `assumptions.book_key(position)`), else `segment`;
      - μ = the Book μ of that key in `book` (None = `effective_book(None)`);
      - σ = `holding_stats(points, key, book, bench_points=…)['sigma_used']`, the shrunk volatility;
      - continuous drift ln(1 + μ), so the 1-year p50 is price × (1 + typical(μ, σ)).
    `momentum`, `cagr_3y_pct`, `trend`, `rsi`, `signals` and `beta` (one year against `bench_points`)
    are descriptive only. `signals` and `trend` come from the one signal model (`signals.read`, K16):
    `signals` are the described Markets signals of these closes (no live quote), and `trend` is the
    moving-average rule reconciled with them ({key, label, reconciled, sma50, sma200, above_50,
    above_200}), so it never reads up while `momentum_sell` fires. `assumptions` = {drift_pct (Book μ), volatility_pct (σ used), typical_pct, basis,
    data_quality, hash, cone_label = HONESTY['cone']} (H16: the cone's own label; `signal` stays the
    §6.12 market-signal copy).
    """
    today = today or date.today()
    pts = [(p[0], float(p[1])) for p in points if p[1] is not None and float(p[1]) > 0]
    vals = [p[1] for p in pts]
    if len(vals) < 30:
        return None
    price = vals[-1]
    rets = [r for _, r in log_returns(pts)]
    sig = sg.read(vals)
    trend = sig["trend"]
    year = vals[-TRADING_DAYS:]
    hi, lo = max(year), min(year)
    vol_1y = annual_vol(rets, TRADING_DAYS)
    vol_1m = annual_vol(rets, 21)
    mdd, cur_dd = max_drawdown(year)
    years_avail = (date.fromisoformat(pts[-1][0]) - date.fromisoformat(pts[0][0])).days / 365.25
    c3 = cagr(vals[-3 * TRADING_DAYS:], min(3.0, years_avail)) if years_avail >= 1 else None
    r14 = rsi(vals)

    regime = None
    if vol_1y and vol_1m:
        ratio = vol_1m / vol_1y
        regime = "turbulent" if ratio > 1.4 else "calm" if ratio < 0.7 else "normal"

    beta = corr = None
    if bench_points:
        start = pts[max(len(pts) - TRADING_DAYS, 0)][0]
        _, grid = daily_grid({"a": pts, "b": bench_points}, start, pts[-1][0])
        beta, corr = beta_corr(returns_on_grid(grid["a"]), returns_on_grid(grid["b"]))

    # The cone: the Book's long-run return for the key and the shrunk σ (G9); no momentum, no CAGR
    book = book or A.effective_book(None)
    key = book_key or segment
    mu, _ = _book_row(book, key)
    st = holding_stats(pts, key, book, bench_points=bench_points)
    sigma = st["sigma_used"]
    ranges = cone(price, math.log(1 + max(mu, -0.99)), sigma, {"3M": 63, "6M": 126, "1Y": TRADING_DAYS})

    notes = []
    if trend["reconciled"]:
        # K16: the averages and the past month disagree, so the trend reads mixed and says why
        notes.append("Above its long averages but falling over the past month: no clear trend." if trend["above_50"]
                     else "Below its long averages but rising over the past month: no clear trend.")
    elif trend["key"] == "up":
        notes.append("Trading above its 50- and 200-day averages: the trend is up.")
    elif trend["key"] == "down":
        notes.append("Below its 50- and 200-day averages: the trend is down.")
    if r14 is not None and r14 >= 70:
        notes.append(f"RSI {r14:.0f}: stretched in the short term, pullbacks are common from here.")
    elif r14 is not None and r14 <= 30:
        notes.append(f"RSI {r14:.0f}: oversold; bounces often follow, but so can further falls.")
    if cur_dd <= -0.15:
        notes.append(f"{abs(cur_dd) * 100:.0f}% below its 52-week high.")
    elif price >= hi * 0.995:
        notes.append("At a 52-week high.")
    if regime == "turbulent":
        notes.append("Swinging more than usual this month: size positions with that in mind.")
    elif regime == "calm":
        notes.append("Unusually calm this month compared with the past year.")
    if beta is not None and beta >= 1.3:
        notes.append(f"Beta {beta:.1f}: moves about {beta:.1f}x the index, in both directions.")
    elif beta is not None and beta <= 0.6 and corr is not None and corr > 0.3:
        notes.append(f"Beta {beta:.1f}: a steadier holding than the index.")

    return {
        "as_of": pts[-1][0], "price": round(price, 4),
        "trend": trend, "signals": sig["signals"],
        "momentum": {"1M": _r(change(vals, 21)), "3M": _r(change(vals, 63)), "6M": _r(change(vals, 126)),
                     "1Y": _r(change(vals, TRADING_DAYS))},
        "rsi": _r(r14, 1),
        "volatility": {"annual_pct": _r(vol_1y * 100 if vol_1y else None, 1), "month_pct": _r(vol_1m * 100 if vol_1m else None, 1),
                       "regime": regime},
        "range_52w": {"high": round(hi, 4), "low": round(lo, 4), "from_high_pct": _r(cur_dd * 100), "max_drawdown_pct": _r(mdd * 100),
                      "position_pct": _r((price - lo) / (hi - lo) * 100 if hi > lo else 50.0, 1)},
        "cagr_3y_pct": _r(c3 * 100 if c3 is not None else None, 1),
        "beta": _r(beta), "correlation": _r(corr),
        "assumptions": {"drift_pct": round(mu * 100, 1), "volatility_pct": round(sigma * 100, 1),
                        "typical_pct": round(A.typical(mu, sigma) * 100, 1),
                        "basis": _cone_basis(key, mu, sigma, st), "data_quality": st["data_quality"],
                        "hash": A.book_hash(book), "cone_label": HONESTY["cone"]},
        "cone": ranges, "notes": notes, "disclaimer": DISCLAIMER,
    }


def _key_label(key: str | None) -> str:
    return KEY_LABEL.get(key or "", key or FALLBACK_KEY)


def _cone_basis(key: str | None, mu: float, sigma: float, st: dict) -> str:
    """One line naming where the cone's two numbers came from (T2 copy for the `est.` basis)."""
    label = _key_label(key if key in A.CORR else FALLBACK_KEY)
    quality = st["data_quality"]
    years = st["n"] / TRADING_DAYS
    if quality == "own":
        vol = f"volatility {sigma * 100:.1f}%, mostly from its own {years:.1f} years of prices"
    elif quality == "some":
        vol = f"volatility {sigma * 100:.1f}%, its own prices blended with the {label} average"
    elif quality == "prior":
        vol = f"volatility {sigma * 100:.1f}%, the {label} average (too few prices of its own yet)"
    else:
        vol = f"volatility {sigma * 100:.1f}%, the {label} average"
    return f"{label} long-run return of {mu * 100:.1f}% a year from the Assumption Book, not its recent trend; {vol}."


def percentile(sorted_xs: list[float], q: float) -> float:
    if not sorted_xs:
        return 0.0
    k = (len(sorted_xs) - 1) * q
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return sorted_xs[int(k)]
    return sorted_xs[f] * (c - k) + sorted_xs[c] * (k - f)


def _book_row(book: dict | None, key: str | None) -> tuple[float, float]:
    """(μ, σ) as fractions for a Book key. `book` may be the §6.1 shape {segments: {key: {return_pct,
    vol_pct}}} or a plain {key: (mu, sigma)} map (None = `effective_book(None)`). A key missing from
    `book` reads the default Book's row; a key the Book does not know reads FALLBACK_KEY's row."""
    segs = book.get("segments") if isinstance(book, dict) and isinstance(book.get("segments"), dict) else book
    row = (segs or {}).get(key) if key is not None else None
    if row is None:
        default = A.effective_book(None)["segments"]
        row = default.get(key) if key is not None else None
        row = row or default[FALLBACK_KEY]
    if isinstance(row, dict):
        mu = float(row.get("return_pct") or 0) / 100
        sigma = float(row.get("vol_pct", row.get("volatility_pct")) or 0) / 100
        return mu, sigma
    return float(row[0]), float(row[1])


def holding_stats(points: list[tuple[str, float]] | None, book_key: str, book: dict | None = None, *,
                  bench_points: list[tuple[str, float]] | None = None) -> dict:
    """Per-holding volatility and beta, shrunk toward the segment prior (SPEC §6.2).

    `points` are the holding's own closes (never zero-filled), `book_key` its Book row
    (`assumptions.book_key(position)`) and `book` the prior (the §6.1 effective-book shape or a plain
    {key: (mu, sigma)} map; None = `assumptions.effective_book(None)`).
    Returns fractions, not percentages:
      - sigma_own  = stdev(own daily log returns) × √252, or None with fewer than two returns;
      - sigma_used = √(w·σ_own² + (1−w)·σ_book²), w = min(n/756, 0.6), and w = 0 when n < 60;
      - beta       = w_b·β_own + (1−w_b)·1.0, w_b = min(n/504, 0.7), clamped to 0..2.5 (β_own against
                     `bench_points`; without a benchmark the prior 1.0 stands);
      - mu         = the prior μ for the segment (momentum is never used);
      - n          = number of own daily log returns;
      - data_quality = 'own' (n ≥ 504), 'some' (60 ≤ n < 504), 'prior' (n < 60), or 'rate' for FD/EPF/P2P,
                     whose σ is the segment's and whose beta is 0.
    """
    mu, sigma_book = _book_row(book, book_key)
    if book_key in RATE_KEYS:
        return {"sigma_own": None, "sigma_used": round(sigma_book, 4), "beta": 0.0, "mu": round(mu, 4), "n": 0,
                "data_quality": "rate"}
    pts = [(p[0], float(p[1])) for p in points or [] if p[1] is not None and float(p[1]) > 0]
    rets = [r for _, r in log_returns(pts)]
    n = len(rets)
    sigma_own = stdev(rets) * math.sqrt(TRADING_DAYS) if n >= 2 else None
    w = 0.0 if n < SHRINK_MIN_N or sigma_own is None else min(n / SHRINK_FULL_N, SHRINK_CAP)
    sigma_used = math.sqrt(w * (sigma_own or 0.0) ** 2 + (1 - w) * sigma_book ** 2)
    beta_own = None
    if bench_points and n >= 2:
        _, grid = daily_grid({"a": pts, "b": bench_points}, pts[0][0], pts[-1][0])
        beta_own = beta_corr(returns_on_grid(grid["a"]), returns_on_grid(grid["b"]))[0]
    w_b = min(n / BETA_FULL_N, BETA_CAP) if beta_own is not None else 0.0
    beta = min(max(w_b * (beta_own or 0.0) + (1 - w_b) * 1.0, 0.0), 2.5)
    quality = "own" if n >= OWN_N else "some" if n >= SHRINK_MIN_N else "prior"
    return {"sigma_own": _r(sigma_own, 4), "sigma_used": round(sigma_used, 4), "beta": round(beta, 3),
            "mu": round(mu, 4), "n": n, "data_quality": quality}


def _ballast_rate(p: dict, book: dict | None = None) -> float:
    """Annual accrual rate of a ballast position (FD, EPF, P2P, hand-priced NPS, cash), as a fraction.

    The position's own `rate` when it has one, else the Book μ of its key (FD 7%, EPF 8.25%, NPS 10%,
    P2P 10% − 3%). P2P accrues min(rate − P2P_LOSS, P2P_MU_CAP) per position (AMENDMENTS E15/G9) and
    a defaulted loan accrues 0; USD cash accrues 0."""
    if p.get("asset_class") == d.CASH:
        return 0.0
    key = A.book_key(p)
    if key == d.SEG_P2P and (p.get("status") or "").lower() == "defaulted":
        return 0.0   # a defaulted loan earns nothing; its loss is not a daily return
    try:
        rate = float(p.get("rate") or 0) / 100 or None   # 0 or missing = no rate, as rated_book reads it
    except (TypeError, ValueError):
        rate = None
    if key == d.SEG_P2P:
        mu = rate - P2P_LOSS if rate is not None else _book_row(book, key)[0]   # the Book's P2P μ is already net
        return min(mu, P2P_MU_CAP)
    return rate if rate is not None else _book_row(book, key)[0]


def _cov(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    return sum((a - mx) * (b - my) for a, b in zip(xs, ys)) / (n - 1)


def _rupee_points(points: list[tuple[str, float]], fx_points: list[tuple[str, float]] | None) -> list[tuple[str, float]]:
    if not fx_points:
        return points
    ff = _FF(fx_points)
    out = []
    for day, px in points:
        rate = ff.at(day)
        if px is not None and rate:
            out.append((day, float(px) * rate))
    return out


def portfolio_risk(positions: list[dict], hist: dict[str, list], bench_points: list[tuple[str, float]] | None,
                   fx_points: list[tuple[str, float]] | None = None, today: date | None = None, lookback_days: int = 365,
                   *, proxies: dict[str, list] | None = None, book: dict | None = None) -> dict:
    """Value-at-risk, beta, Sharpe/Sortino, correlations and risk contribution from a year of daily history (v2, SPEC §6.7).

    The portfolio's daily return is r_t = Σ_{i∈A_t} ŵᵢ r_{i,t} + Σ_{b∈B} ŵ_b a_b:
      - A_t: market-priced holdings with their own return on day t, or a proxy return before their
        first close (the segment index × β_prior = 1: ^NSEI from `bench_points` for Indian equity, MF
        and NPS; ^GSPC × USDINR for US holdings; GOLDBEES.NS for commodities; debt MFs have none).
        `proxies` supplies the '^GSPC' and 'GOLDBEES.NS' histories; without one, a holding counts only
        from its own first close and its row is flagged data 'prior'.
      - B, the ballast: FDs, EPF, P2P and hand-priced NPS accrue a_b = (1+rate)^(1/252) − 1 at the
        position's `rate`, else the Book μ (FD 7%, EPF 8.25%, P2P 10% − 3% loss, NPS 10%). P2P accrues
        min(rate − P2P_LOSS, P2P_MU_CAP) per position and a defaulted loan 0; USD cash accrues 0.
      - ŵ: today's value weights, renormalised over A_t ∪ B each day.
    Risk contributions are the Euler split of the variance over the daily components ŵᵢ,t·rᵢ,t, so
    the holdings' and ballast's shares add up to 100%. Each holding's own volatility is shrunk toward
    its Book prior (holding_stats) for `volatility_used_pct`.
    `model` is the Book's view of today's mix: vol_pct = the σ of
    `mu_sigma(weights_from_positions(held), rated_book(held, book))`, the same number as
    `optimizer.suggest()['current']['vol_pct']` and the brief's Risk vital (AMENDMENTS G9); var_day =
    1.645·σ/√252 × total. `book` is the base Book (None = `effective_book(None)`). Sharpe and Sortino
    use `assumptions.RISK_FREE`.
    """
    today = today or date.today()
    proxies = proxies or {}
    book = book or A.effective_book(None)
    total = sum(float(p.get("value") or 0) for p in positions if p.get("is_open"))
    held = [p for p in positions if p.get("is_open") and float(p.get("value") or 0) > 0]

    def is_market(p):
        if p["asset_class"] in d.TRADABLE:
            return True
        return p["asset_class"] == d.NPS and bool(p.get("symbol")) and len(hist.get(p["symbol"], [])) >= 2

    market = [p for p in held if is_market(p)]
    ballast = [p for p in held if not is_market(p) and p["asset_class"] in (d.FIXED_DEPOSIT, d.EPF, d.P2P, d.NPS, d.CASH)]
    ballast_value = sum(float(p["value"]) for p in ballast)
    ballast_rates = {id(p): _ballast_rate(p, book) for p in ballast}
    ballast_daily = sum(float(p["value"]) * ((1 + ballast_rates[id(p)]) ** (1 / TRADING_DAYS) - 1) for p in ballast)

    # Book (model) view of today's mix, over every open position with value (G9)
    _, sigma_model = A.mu_sigma(A.weights_from_positions(held), A.rated_book(held, book))
    model = {"vol_pct": round(sigma_model * 100, 2),
             "var_day": round(Z95 * sigma_model / math.sqrt(TRADING_DAYS) * total, 2) if total > 0 else 0.0}

    empty = {"total": round(total, 2), "exposed_pct": 0.0, "holdings": [],
             "correlation": {"labels": [], "matrix": [], "highest": None, "lowest": None},
             "model": model, "measured_vs_model": {"measured_vol_pct": None, "model_vol_pct": model["vol_pct"], "ratio": None}}
    if total <= 0 or not market:
        return {**empty, "notes": ["Not enough price history to measure risk yet."]}

    start = (today - timedelta(days=lookback_days)).isoformat()
    series: dict[str, list] = {}
    for p in market:
        if p.get("symbol") and hist.get(p["symbol"]):
            series[p["symbol"]] = hist[p["symbol"]]
    extra = {"__bench": bench_points, "__fx": fx_points, "__gspc": proxies.get(GSPC), "__gold": proxies.get(GOLDBEES)}
    series.update({k: v for k, v in extra.items() if v})
    days, grid = daily_grid(series, start, today.isoformat())
    rets = {k: returns_on_grid(v) for k, v in grid.items()}
    fx_r = rets.get("__fx")

    def with_fx(r):
        return [None if a is None or b is None else a + b for a, b in zip(r, fx_r)] if fx_r else r

    proxy_r = {NSEI: rets.get("__bench"), GSPC: with_fx(rets["__gspc"]) if "__gspc" in rets else None,
               GOLDBEES: rets.get("__gold")}

    # Each holding's effective return: its own (in rupees) from its first close, the proxy before that
    rows_in = []
    for p in market:
        sym = p.get("symbol")
        own = rets.get(sym) if sym else None
        if own is not None and p.get("currency") == "USD":
            own = with_fx(own)
        own = own or [None] * len(days)
        pts = [x for x in (hist.get(sym) or []) if x[1] is not None and float(x[1]) > 0] if sym else []
        first = pts[0][0] if pts else None
        key = A.book_key(p)
        index = PROXY_INDEX.get(p["segment"]) if key != MF_DEBT else None
        prox = proxy_r.get(index) if index else None
        eff, proxy_days = [], 0
        for i, day in enumerate(days):
            r = own[i]
            if r is None and prox is not None and (first is None or day <= first) and prox[i] is not None:
                r, proxy_days = prox[i], proxy_days + 1
            eff.append(r)
        if all(r is None for r in eff[1:]):
            continue
        own_start_in_window = first is None or first > days[0]
        rows_in.append({"p": p, "key": key, "own": own, "eff": eff, "proxy_days": proxy_days, "index": index if proxy_days else None,
                        "late": own_start_in_window, "pts": pts})

    if not rows_in:
        return {**empty, "notes": ["Not enough price history to measure risk yet."]}

    # Daily portfolio return with weights renormalised over A_t ∪ B
    port, idx, comps, ballast_comp = [], [], {id(r): [] for r in rows_in}, []
    for i in range(1, len(days)):
        active = [r for r in rows_in if r["eff"][i] is not None]
        if not active:
            continue
        denom = sum(float(r["p"]["value"]) for r in active) + ballast_value
        day_total = ballast_daily / denom
        ballast_comp.append(ballast_daily / denom)
        for r in rows_in:
            c = float(r["p"]["value"]) / denom * r["eff"][i] if r["eff"][i] is not None else 0.0
            comps[id(r)].append(c)
            day_total += c
        port.append(day_total)
        idx.append(i)

    exposed = sum(float(r["p"]["value"]) for r in rows_in) / total
    if len(port) < 30:
        return {**empty, "exposed_pct": round(exposed * 100, 1),
                "notes": ["Not enough overlapping price history yet (needs about six weeks)."]}

    sd = stdev(port)
    srt = sorted(port)
    var_hist = -percentile(srt, 0.05)
    tail = [x for x in srt if x <= -var_hist] or srt[:1]
    es = -sum(tail) / len(tail)
    downside = [min(x, 0.0) for x in port]
    dd_dev = math.sqrt(sum(x * x for x in downside) / len(downside)) * math.sqrt(TRADING_DAYS)
    mean_ann = sum(port) / len(port) * TRADING_DAYS   # includes the ballast's accrual (the corrected mean)
    vol_ann = sd * math.sqrt(TRADING_DAYS)
    sortino = (mean_ann - RISK_FREE) / dd_dev if dd_dev > 0 else None
    sharpe = (mean_ann - RISK_FREE) / vol_ann if vol_ann > 0 else None
    beta = corr = None
    bench_r = [rets["__bench"][i] for i in idx] if "__bench" in rets else None
    if bench_r:
        beta, corr = beta_corr(port, bench_r)

    var_p = sd * sd
    rows = []
    weights = {r["p"]["id"]: float(r["p"]["value"]) / total for r in rows_in}
    eff_vol = {}
    for r in rows_in:
        p = r["p"]
        contrib = _cov(comps[id(r)], port) / var_p if var_p > 0 else None
        own_pts = _rupee_points(r["pts"], fx_points) if p.get("currency") == "USD" else r["pts"]
        st = holding_stats(own_pts, r["key"], book, bench_points=bench_points)
        xs = [r["eff"][i] for i in idx if r["eff"][i] is not None]
        eff_vol[p["id"]] = stdev(xs) * math.sqrt(TRADING_DAYS) if len(xs) >= 2 else st["sigma_used"]
        data = "proxy" if r["proxy_days"] else "prior" if r["late"] or st["n"] < SHRINK_MIN_N else "own"
        rows.append({"id": p["id"], "name": p["name"], "symbol": p.get("symbol"), "segment": p["segment"],
                     "weight_pct": round(weights[p["id"]] * 100, 2),
                     "volatility_pct": _r(st["sigma_own"] * 100 if st["sigma_own"] is not None else None, 1),
                     "volatility_used_pct": round(st["sigma_used"] * 100, 1), "beta": _r(st["beta"]),
                     "risk_contribution_pct": _r(contrib * 100 if contrib is not None else None, 1), "value": round(float(p["value"]), 2),
                     "data": data, "data_quality": st["data_quality"], "n": st["n"],
                     "proxy": PROXY_LABEL.get(r["index"]) if r["index"] else None})
    rows.sort(key=lambda x: -(x["risk_contribution_pct"] or 0))
    ballast_contrib = _cov(ballast_comp, port) / var_p if var_p > 0 and ballast else 0.0

    # Correlations from own returns only: a shared proxy would make new holdings look identical
    by_value = sorted(rows_in, key=lambda r: -float(r["p"]["value"]))[:10]
    own_on = {id(r): [r["own"][i] for i in idx] for r in by_value}
    labels, matrix = [r["p"]["name"] for r in by_value], []
    for a in by_value:
        matrix.append([1.0 if a is b else _r(beta_corr(own_on[id(a)], own_on[id(b)])[1]) for b in by_value])
    pairs = sorted((matrix[i][j], by_value[i]["p"]["name"], by_value[j]["p"]["name"]) for i in range(len(by_value))
                   for j in range(i + 1, len(by_value)) if matrix[i][j] is not None)
    weighted_vol = sum(weights[pid] * v for pid, v in eff_vol.items())
    diversification = weighted_vol / vol_ann if vol_ann > 0 else None
    ratio = vol_ann / sigma_model if sigma_model > 0 else None

    notes = [f"On a bad day (1 in 20), expect to lose about ₹{var_hist * total:,.0f} or more; "
             f"over a bad month, about ₹{var_hist * math.sqrt(21) * total:,.0f}."]
    if beta is not None:
        notes.append(f"Beta {beta:.2f} to the Nifty 50: a 10% fall in the index has tended to mean about "
                     f"{abs(beta) * 10:.0f}% on the whole portfolio.")
    if exposed < 0.6:
        notes.append(f"Only {exposed * 100:.0f}% of the portfolio is market-priced; FDs, EPF and loans steady the rest "
                     "and are counted at their interest rates.")
    if rows and (rows[0]["risk_contribution_pct"] or 0) > 35:
        notes.append(f"{rows[0]['name']} drives {rows[0]['risk_contribution_pct']:.0f}% of the day-to-day risk.")
    if pairs and pairs[-1][0] >= 0.8:
        notes.append(f"{pairs[-1][1]} and {pairs[-1][2]} move almost together (correlation {pairs[-1][0]:.2f}); "
                     "they diversify each other little.")
    if diversification and diversification >= 1.4:
        notes.append(f"Diversification ratio {diversification:.2f}: mixing these holdings removes about "
                     f"{(1 - 1 / diversification) * 100:.0f}% of the risk they carry alone.")
    n_proxy = sum(1 for x in rows if x["data"] == "proxy")
    n_prior = sum(1 for x in rows if x["data"] == "prior")
    if n_proxy:
        whose = "each one's" if n_proxy > 1 else "its"
        notes.append(f"{n_proxy} holding{'s' if n_proxy > 1 else ''} with less than a year of prices: before {whose} "
                     "first price, the market index stands in.")
    if n_prior:
        notes.append(f"{n_prior} holding{'s' if n_prior > 1 else ''} with a short price record and no index to stand in: "
                     "counted from the first price only, with volatility leaning on the asset-class average.")
    skipped = len(market) - len(rows_in)
    if skipped:
        notes.append(f"{skipped} market-priced holding{'s' if skipped > 1 else ''} without any price history "
                     "left out of the daily returns.")

    return {
        "total": round(total, 2), "exposed_pct": round(exposed * 100, 1), "days": len(port), "since": days[idx[0]] if idx else None,
        "var_95": {"day_pct": round(var_hist * 100, 2), "day": round(var_hist * total, 2),
                   "month_pct": round(var_hist * math.sqrt(21) * 100, 2), "month": round(var_hist * math.sqrt(21) * total, 2),
                   "parametric_day_pct": round(Z95 * sd * 100, 2), "expected_shortfall_day_pct": round(es * 100, 2)},
        "volatility_pct": round(vol_ann * 100, 1), "downside_deviation_pct": round(dd_dev * 100, 1),
        "mean_return_pct": round(mean_ann * 100, 2), "risk_free_pct": round(RISK_FREE * 100, 2),
        "beta": _r(beta), "correlation_index": _r(corr), "sharpe": _r(sharpe), "sortino": _r(sortino),
        "diversification_ratio": _r(diversification), "holdings": rows,
        "ballast": {"value": round(ballast_value, 2), "weight_pct": round(ballast_value / total * 100, 2),
                    "rate_pct": round(sum(float(p["value"]) * ballast_rates[id(p)] for p in ballast) / ballast_value * 100, 2) if ballast_value else None,
                    "risk_contribution_pct": round(ballast_contrib * 100, 1)},
        "correlation": {"labels": labels, "matrix": matrix,
                        "highest": {"pair": [pairs[-1][1], pairs[-1][2]], "value": pairs[-1][0]} if pairs else None,
                        "lowest": {"pair": [pairs[0][1], pairs[0][2]], "value": pairs[0][0]} if pairs else None},
        "model": model,
        "measured_vs_model": {"measured_vol_pct": round(vol_ann * 100, 1), "model_vol_pct": model["vol_pct"],
                              "ratio": _r(ratio)},
        "notes": notes,
    }
