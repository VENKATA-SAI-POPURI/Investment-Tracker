"""One signal vocabulary (SPEC P2.12, AMENDMENTS K16): the price signals Markets shows and the trend a
holding's outlook reads come from this one module, so a holding can no longer read "Uptrend" next to
"Falling steadily".

Pure and a leaf: it imports nothing from the package, so `quant` (AMENDMENTS G3) and `markets` (which
also imports the network module `prices`) can both use it.

Signals look only at price movement over the last week and the last month, read two ways:
  momentum  rising over both windows: consider buying; falling over both: consider exiting
  dip       fell hard over the month but turning up this week: possible entry;
            ran up hard over the month but slipping this week: consider booking profit
They are price patterns, not forecasts, research or advice: every described signal carries
`label: SIGNAL_LABEL` so the copy travels with it (SPEC §6.12).

The trend is the moving-average rule (price against its 50- and 200-day averages), reconciled with the
momentum signals: an "up" average rule while the past month is falling steadily reads "mixed", and the
mirror for "down". RSI uses Wilder's smoothing.
"""
from __future__ import annotations

WEEK, MONTH = 5, 21        # trading days

# Thresholds in percent; a signal needs both windows to agree
RULES = {
    "momentum_buy": {"m1": 8.0, "w1": 3.0},
    "momentum_sell": {"m1": -8.0, "w1": -3.0},
    "dip_buy": {"m1": -8.0, "w1": 0.5},
    "profit_book": {"m1": 15.0, "w1": -2.0},
}
SIGNAL_TEXT = {
    "momentum_buy": ("Rising strongly", "Up {m1} this month and {w1} this week"),
    "momentum_sell": ("Falling steadily", "Down {m1} this month and {w1} this week"),
    "dip_buy": ("Bouncing after a fall", "Down {m1} this month, {w1} this week"),
    "profit_book": ("Cooling after a run", "Up {m1} this month, {w1} this week"),
}
SIGNAL_LABEL = "price pattern, not a forecast"

RSI_N = 14
TREND_LABELS = {"up": "Uptrend", "down": "Downtrend", "mixed": "No clear trend"}


def pct_text(v: float | None) -> str:
    """A signed percentage for a sentence ("+3.0%"), or an em dash when unknown."""
    return "—" if v is None else f"{v:+.1f}%"


def _r(v, n=2):
    return None if v is None else round(v, n)


# ── windows and signals ──

def windows(vals: list[float]) -> dict:
    """{w1, m1}: the percent change over the last 5 and 21 closes, 2 dp, None without enough closes.

    The exact rule `markets.metrics` uses (it calls this), so Markets and the outlook cannot drift."""
    last = vals[-1] if vals else None

    def chg(n):
        ref = vals[-1 - n] if len(vals) > n else None
        return round((last / ref - 1) * 100, 2) if ref and last is not None else None

    return {"w1": chg(WEEK), "m1": chg(MONTH)}


def signals_for(m: dict | None) -> list[str]:
    """The signal keys whose two thresholds (RULES) both hold for metrics {w1, m1}, in RULES order."""
    if not m or m.get("w1") is None or m.get("m1") is None:
        return []
    out = []
    w1, m1 = m["w1"], m["m1"]
    if m1 >= RULES["momentum_buy"]["m1"] and w1 >= RULES["momentum_buy"]["w1"]:
        out.append("momentum_buy")
    if m1 <= RULES["momentum_sell"]["m1"] and w1 <= RULES["momentum_sell"]["w1"]:
        out.append("momentum_sell")
    if m1 <= RULES["dip_buy"]["m1"] and w1 >= RULES["dip_buy"]["w1"]:
        out.append("dip_buy")
    if m1 >= RULES["profit_book"]["m1"] and w1 <= RULES["profit_book"]["w1"]:
        out.append("profit_book")
    return out


def size_text(v: float | None) -> str:
    """An unsigned percentage ("14.5%") for after "Up"/"Down", which already say the direction; em dash when unknown."""
    return "—" if v is None else f"{abs(v):.1f}%"


def describe(sig: str, m: dict) -> dict:
    """{signal, title, note, label}: one signal in words, with its honesty label (SPEC §6.12).

    The note reads the month figure unsigned after "Up"/"Down" and keeps the week figure's sign
    (AMENDMENTS R12): "Down 14.5% this month, +2.0% this week"."""
    title, note = SIGNAL_TEXT[sig]
    return {"signal": sig, "title": title, "note": note.format(m1=size_text(m["m1"]), w1=pct_text(m["w1"])),
            "label": SIGNAL_LABEL}


# ── indicators ──

def sma(vals: list[float], n: int) -> float | None:
    """Simple mean of the last n values, None with fewer."""
    return sum(vals[-n:]) / n if len(vals) >= n else None


def rsi(vals: list[float], n: int = RSI_N) -> float | None:
    """Wilder's RSI over every close.

    The first average gain and loss are the simple means of the first n changes; after that each
    average is (previous × (n − 1) + current) / n. Returns 100 when the average loss is 0, and None
    with n or fewer closes (fewer than n changes): the first value needs n changes, as in the published
    StockCharts example, whose first RSI (70.53) is read on the 15th close (AMENDMENTS, W6-B5 notes)."""
    if n < 1 or len(vals) <= n:
        return None
    diffs = [b - a for a, b in zip(vals[:-1], vals[1:])]
    gain = sum(max(x, 0.0) for x in diffs[:n]) / n
    loss = sum(max(-x, 0.0) for x in diffs[:n]) / n
    for x in diffs[n:]:
        gain = (gain * (n - 1) + max(x, 0.0)) / n
        loss = (loss * (n - 1) + max(-x, 0.0)) / n
    if loss == 0:
        return 100.0
    return 100 - 100 / (1 + gain / loss)


# ── trend ──

def _keys(sigs) -> set[str]:
    """Signal keys from keys or described signals ({signal, ...})."""
    return {s["signal"] if isinstance(s, dict) else s for s in (sigs or [])}


def trend(vals: list[float], sigs=()) -> dict:
    """The moving-average trend, reconciled with the price signals.

    Rule: up when price > SMA50 > SMA200, down when price < SMA50 < SMA200, else mixed; with only
    50 closes or more, up or down against SMA50 alone; under 50 closes, mixed. Then reconciled with
    `sigs` (keys or described signals): up while `momentum_sell` fires, or down while `momentum_buy`
    fires, becomes mixed and `reconciled` is True.

    Returns {key, label, reconciled, sma50, sma200, above_50, above_200}."""
    price = vals[-1] if vals else None
    s50, s200 = sma(vals, 50), sma(vals, 200)
    if price is not None and s50 and s200:
        key = "up" if price > s50 > s200 else "down" if price < s50 < s200 else "mixed"
    elif price is not None and s50:
        key = "up" if price > s50 else "down"
    else:
        key = "mixed"
    fired = _keys(sigs)
    reconciled = (key == "up" and "momentum_sell" in fired) or (key == "down" and "momentum_buy" in fired)
    if reconciled:
        key = "mixed"
    return {"key": key, "label": TREND_LABELS[key], "reconciled": reconciled,
            "sma50": _r(s50, 4), "sma200": _r(s200, 4),
            "above_50": bool(s50 and price > s50), "above_200": bool(s200 and price > s200)}


def read(vals: list[float]) -> dict:
    """{w1, m1, signals: [described], trend, rsi}: the whole signal read of one closes series.

    `rsi` is rounded to 1 dp; `signals` equal Markets' for the same closes and no live quote."""
    m = windows(vals)
    sigs = signals_for(m)
    return {"w1": m["w1"], "m1": m["m1"], "signals": [describe(s, m) for s in sigs],
            "trend": trend(vals, sigs), "rsi": _r(rsi(vals), 1)}
