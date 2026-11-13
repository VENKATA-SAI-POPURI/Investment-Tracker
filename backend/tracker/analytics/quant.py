"""Quantitative read-outs over price series: trend, momentum, volatility, beta and a statistical
projection cone for one holding; value-at-risk, correlations and risk contribution for the portfolio.

Everything here is a pure function over (iso_date, close) lists so it can be tested offline.
The projections are statistical ranges built from past volatility: they describe how wide the
outcomes could be, not where the price will go.
"""
from __future__ import annotations

import math
from bisect import bisect_right
from datetime import date, timedelta

from .. import domain as d

TRADING_DAYS = 252
RISK_FREE = 0.065
Z95 = 1.6449
Z90 = 1.2816
# Long-run prior for the drift used in the cone, by segment (annual). Blended 50/50 with the
# holding's own 3-year CAGR, so a hot year does not become the forecast.
DRIFT_PRIOR = {d.SEG_EQ_IN: 0.12, d.SEG_EQ_US: 0.11, d.SEG_MF: 0.11, d.SEG_COMMODITY: 0.08, d.SEG_NPS: 0.10}
DISCLAIMER = ("Ranges are statistical: they assume future moves look like the past year's volatility. "
              "They are not predictions or advice.")


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


def sma(vals: list[float], n: int) -> float | None:
    return sum(vals[-n:]) / n if len(vals) >= n else None


def change(vals: list[float], n: int) -> float | None:
    """Percent change over the last n observations."""
    return (vals[-1] / vals[-1 - n] - 1) * 100 if len(vals) > n and vals[-1 - n] else None


def rsi(vals: list[float], n: int = 14) -> float | None:
    if len(vals) <= n:
        return None
    gains = losses = 0.0
    for a, b in zip(vals[-n - 1:-1], vals[-n:]):
        diff = b - a
        gains += max(diff, 0)
        losses += max(-diff, 0)
    if losses == 0:
        return 100.0
    return 100 - 100 / (1 + (gains / n) / (losses / n))


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
    return days, {key: [(_FF(pts)).at(day) for day in days] for key, pts in series.items()}


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
    """Log-normal percentile bands: {label: {p10, p50, p90}} for horizons in trading days."""
    out = {}
    for label, days in horizons.items():
        t = days / TRADING_DAYS
        m = (mu - sigma * sigma / 2) * t
        s = sigma * math.sqrt(t)
        out[label] = {"p10": round(price * math.exp(m - Z90 * s), 2), "p50": round(price * math.exp(m), 2),
                      "p90": round(price * math.exp(m + Z90 * s), 2), "days": days}
    return out


def holding_outlook(points: list[tuple[str, float]], bench_points: list[tuple[str, float]] | None = None,
                    segment: str | None = None, today: date | None = None) -> dict | None:
    """Trend, momentum, volatility, beta and a 3M/6M/1Y statistical range for one priced holding."""
    today = today or date.today()
    pts = [(p[0], float(p[1])) for p in points if p[1] is not None and float(p[1]) > 0]
    vals = [p[1] for p in pts]
    if len(vals) < 30:
        return None
    price = vals[-1]
    rets = [r for _, r in log_returns(pts)]
    s50, s200 = sma(vals, 50), sma(vals, 200)
    year = vals[-TRADING_DAYS:]
    hi, lo = max(year), min(year)
    vol_1y = annual_vol(rets, TRADING_DAYS)
    vol_1m = annual_vol(rets, 21)
    mdd, cur_dd = max_drawdown(year)
    years_avail = (date.fromisoformat(pts[-1][0]) - date.fromisoformat(pts[0][0])).days / 365.25
    c3 = cagr(vals[-3 * TRADING_DAYS:], min(3.0, years_avail)) if years_avail >= 1 else None
    r14 = rsi(vals)

    if s50 and s200:
        trend = "up" if price > s50 > s200 else "down" if price < s50 < s200 else "mixed"
    elif s50:
        trend = "up" if price > s50 else "down"
    else:
        trend = "mixed"
    labels = {"up": "Uptrend", "down": "Downtrend", "mixed": "No clear trend"}

    regime = None
    if vol_1y and vol_1m:
        ratio = vol_1m / vol_1y
        regime = "turbulent" if ratio > 1.4 else "calm" if ratio < 0.7 else "normal"

    beta = corr = None
    if bench_points:
        start = pts[max(len(pts) - TRADING_DAYS, 0)][0]
        _, grid = daily_grid({"a": pts, "b": bench_points}, start, pts[-1][0])
        beta, corr = beta_corr(returns_on_grid(grid["a"]), returns_on_grid(grid["b"]))

    # drift for the cone: half long-run prior, half own 3-year record (clamped)
    prior = DRIFT_PRIOR.get(segment or "", 0.10)
    own = max(min(c3, 0.25), -0.10) if c3 is not None else prior
    mu = 0.5 * prior + 0.5 * own
    sigma = max(vol_1y or 0.2, 0.08)
    ranges = cone(price, mu, sigma, {"3M": 63, "6M": 126, "1Y": TRADING_DAYS})

    notes = []
    if trend == "up":
        notes.append("Trading above its 50- and 200-day averages: the trend is up.")
    elif trend == "down":
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
        "trend": {"key": trend, "label": labels[trend], "sma50": _r(s50, 4), "sma200": _r(s200, 4),
                  "above_50": bool(s50 and price > s50), "above_200": bool(s200 and price > s200)},
        "momentum": {"1M": _r(change(vals, 21)), "3M": _r(change(vals, 63)), "6M": _r(change(vals, 126)),
                     "1Y": _r(change(vals, TRADING_DAYS))},
        "rsi": _r(r14, 1),
        "volatility": {"annual_pct": _r(vol_1y * 100 if vol_1y else None, 1), "month_pct": _r(vol_1m * 100 if vol_1m else None, 1),
                       "regime": regime},
        "range_52w": {"high": round(hi, 4), "low": round(lo, 4), "from_high_pct": _r(cur_dd * 100), "max_drawdown_pct": _r(mdd * 100),
                      "position_pct": _r((price - lo) / (hi - lo) * 100 if hi > lo else 50.0, 1)},
        "cagr_3y_pct": _r(c3 * 100 if c3 is not None else None, 1),
        "beta": _r(beta), "correlation": _r(corr),
        "assumptions": {"drift_pct": round(mu * 100, 1), "volatility_pct": round(sigma * 100, 1)},
        "cone": ranges, "notes": notes, "disclaimer": DISCLAIMER,
    }


def percentile(sorted_xs: list[float], q: float) -> float:
    if not sorted_xs:
        return 0.0
    k = (len(sorted_xs) - 1) * q
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return sorted_xs[int(k)]
    return sorted_xs[f] * (c - k) + sorted_xs[c] * (k - f)


def portfolio_risk(positions: list[dict], hist: dict[str, list], bench_points: list[tuple[str, float]] | None,
                   fx_points: list[tuple[str, float]] | None = None, today: date | None = None, lookback_days: int = 365) -> dict:
    """Value-at-risk, beta, Sortino, correlations and risk contribution from one year of daily history.

    Holdings without a price series (FDs, EPF, P2P, NPS at a manual NAV) count as zero-volatility
    ballast: they lower the portfolio's risk numbers but do not show up in the correlation table.
    """
    today = today or date.today()
    total = sum(float(p.get("value") or 0) for p in positions if p.get("is_open"))
    priced = [p for p in positions if p.get("is_open") and p["asset_class"] in d.TRADABLE and p.get("symbol")
              and len(hist.get(p["symbol"], [])) >= 60 and float(p.get("value") or 0) > 0]
    empty = {"total": round(total, 2), "exposed_pct": 0.0, "holdings": [], "correlation": {"labels": [], "matrix": [], "highest": None, "lowest": None}}
    if total <= 0 or not priced:
        return {**empty, "notes": ["Not enough price history to measure risk yet."]}
    start = (today - timedelta(days=lookback_days)).isoformat()
    series = {p["symbol"]: hist[p["symbol"]] for p in priced}
    if bench_points:
        series["__bench"] = bench_points
    if fx_points:
        series["__fx"] = fx_points
    days, grid = daily_grid(series, start, today.isoformat())
    rets = {k: returns_on_grid(v) for k, v in grid.items()}
    fx_r = rets.get("__fx")
    for p in priced:  # rupee returns for USD holdings
        if p.get("currency") == "USD" and fx_r:
            rets[p["symbol"]] = [None if a is None or b is None else a + b for a, b in zip(rets[p["symbol"]], fx_r)]

    weights = {p["id"]: float(p["value"]) / total for p in priced}
    exposed = sum(weights.values())
    port = []
    for i in range(1, len(days)):
        port.append(sum(weights[p["id"]] * (rets[p["symbol"]][i] or 0.0) for p in priced))
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
    mean_ann = sum(port) / len(port) * TRADING_DAYS
    vol_ann = sd * math.sqrt(TRADING_DAYS)
    sortino = (mean_ann - RISK_FREE) / dd_dev if dd_dev > 0 else None
    sharpe = (mean_ann - RISK_FREE) / vol_ann if vol_ann > 0 else None
    beta = corr = None
    bench_r = rets["__bench"][1:] if "__bench" in rets else None
    if bench_r:
        beta, corr = beta_corr(port, bench_r)

    var_p = sd * sd
    mp = sum(port) / len(port)
    rows = []
    for p in priced:
        r = rets[p["symbol"]][1:]
        pairs = [(a, b) for a, b in zip(r, port) if a is not None]
        if len(pairs) < 30:
            continue
        xs = [a for a, _ in pairs]
        mx = sum(xs) / len(xs)
        cov = sum((a - mx) * (b - mp) for a, b in pairs) / (len(pairs) - 1)
        vol_i = stdev(xs) * math.sqrt(TRADING_DAYS)
        b_i = beta_corr(r, bench_r)[0] if bench_r else None
        contrib = weights[p["id"]] * cov / var_p if var_p > 0 else None
        rows.append({"id": p["id"], "name": p["name"], "symbol": p["symbol"], "segment": p["segment"],
                     "weight_pct": round(weights[p["id"]] * 100, 2), "volatility_pct": round(vol_i * 100, 1), "beta": _r(b_i),
                     "risk_contribution_pct": _r(contrib * 100 if contrib is not None else None, 1), "value": round(float(p["value"]), 2)})
    rows.sort(key=lambda x: -(x["risk_contribution_pct"] or 0))

    top = sorted(priced, key=lambda p: -float(p["value"]))[:10]
    labels, matrix = [p["name"] for p in top], []
    for a in top:
        row = []
        for b in top:
            row.append(1.0 if a is b else _r(beta_corr(rets[a["symbol"]][1:], rets[b["symbol"]][1:])[1]))
        matrix.append(row)
    pairs = sorted((matrix[i][j], top[i]["name"], top[j]["name"]) for i in range(len(top)) for j in range(i + 1, len(top))
                   if matrix[i][j] is not None)
    vol_by_id = {r["id"]: r["volatility_pct"] / 100 for r in rows}
    weighted_vol = sum(weights[p["id"]] * vol_by_id.get(p["id"], 0.0) for p in priced)
    diversification = weighted_vol / vol_ann if vol_ann > 0 else None

    notes = [f"On a bad day (1 in 20), expect to lose about ₹{var_hist * total:,.0f} or more; "
             f"over a bad month, about ₹{var_hist * math.sqrt(21) * total:,.0f}."]
    if beta is not None:
        notes.append(f"Beta {beta:.2f} to the Nifty 50: a 10% fall in the index has tended to mean about "
                     f"{abs(beta) * 10:.0f}% on the whole portfolio.")
    if exposed < 0.6:
        notes.append(f"Only {exposed * 100:.0f}% of the portfolio is market-priced; FDs, EPF and loans steady the rest.")
    if rows and (rows[0]["risk_contribution_pct"] or 0) > 35:
        notes.append(f"{rows[0]['name']} drives {rows[0]['risk_contribution_pct']:.0f}% of the day-to-day risk.")
    if pairs and pairs[-1][0] >= 0.8:
        notes.append(f"{pairs[-1][1]} and {pairs[-1][2]} move almost together (correlation {pairs[-1][0]:.2f}); "
                     "they diversify each other little.")
    if diversification and diversification >= 1.4:
        notes.append(f"Diversification ratio {diversification:.2f}: mixing these holdings removes about "
                     f"{(1 - 1 / diversification) * 100:.0f}% of the risk they carry alone.")

    return {
        "total": round(total, 2), "exposed_pct": round(exposed * 100, 1), "days": len(port), "since": days[1] if len(days) > 1 else None,
        "var_95": {"day_pct": round(var_hist * 100, 2), "day": round(var_hist * total, 2),
                   "month_pct": round(var_hist * math.sqrt(21) * 100, 2), "month": round(var_hist * math.sqrt(21) * total, 2),
                   "parametric_day_pct": round(Z95 * sd * 100, 2), "expected_shortfall_day_pct": round(es * 100, 2)},
        "volatility_pct": round(vol_ann * 100, 1), "downside_deviation_pct": round(dd_dev * 100, 1),
        "beta": _r(beta), "correlation_index": _r(corr), "sharpe": _r(sharpe), "sortino": _r(sortino),
        "diversification_ratio": _r(diversification), "holdings": rows,
        "correlation": {"labels": labels, "matrix": matrix,
                        "highest": {"pair": [pairs[-1][1], pairs[-1][2]], "value": pairs[-1][0]} if pairs else None,
                        "lowest": {"pair": [pairs[0][1], pairs[0][2]], "value": pairs[0][0]} if pairs else None},
        "notes": notes,
    }
