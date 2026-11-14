"""The Assumption Book (SPEC §6.1, AMENDMENTS E14/E15): one source for return, volatility,
correlation, the risk-free rate and inflation.

A leaf module: it imports only `domain` and the standard library, so every engine (optimizer, story,
history and, from wave 3, goals, forecast and quant) can import it without a cycle. It has no database
access; `effective_book(settings)` is the only place settings could change a number (P2 overrides).

Shapes
- `ASSUMPTIONS`: {key: (mu, sigma)} as fractions; today's `goals.ASSUMPTIONS` plus the internal
  `MF_DEBT` row.
- `book`: {segments: {key: {return_pct, vol_pct, source[, capped]}}, inflation_pct}, percentages.
- `CORR`: {key: {key: rho}} over the 8 segments plus `MF_DEBT` (9×9, positive definite as specified:
  the smallest Cholesky pivot is 0.186, so no repair, λ = 0; AMENDMENTS A32/E14).
"""
from __future__ import annotations

import hashlib
import json
import math
import re

from .. import domain as d

# ── Constants ──
RISK_FREE = 0.065        # ~ Indian 1-year T-bill
INFLATION = 0.06
P2P_LOSS = 0.03          # expected annual credit loss on P2P lending
P2P_MU_CAP = 0.12        # E15: borrower rates of 36–48% are not what a lender keeps
STATUS_THRESHOLDS = {"on_track": 75, "at_risk": 40}
EPF_DEFAULT = 0.0825
MF_DEBT = "MF_DEBT"      # internal row; reported under "Mutual Funds" in payloads
DEBT_MF_RE = re.compile(r"debt|liquid|gilt|overnight|money market|bond|credit|arbitrage", re.I)

# Long-run planning assumptions per key: (expected arithmetic annual return, annual volatility)
ASSUMPTIONS: dict[str, tuple[float, float]] = {
    d.SEG_EQ_IN: (0.12, 0.18),
    d.SEG_EQ_US: (0.11, 0.17),     # in ₹, so it includes the currency
    d.SEG_MF: (0.11, 0.15),        # mutual funds not matched as debt
    d.SEG_COMMODITY: (0.08, 0.15),
    d.SEG_P2P: (0.10, 0.06),       # gross; the Book applies P2P_LOSS
    d.SEG_FD: (0.07, 0.01),
    d.SEG_EPF: (0.0825, 0.005),    # declared EPF rate; credited yearly
    d.SEG_NPS: (0.10, 0.12),       # typical active-choice equity/debt mix
    MF_DEBT: (0.07, 0.03),
}
KEYS = tuple(d.SEGMENTS) + (MF_DEBT,)
RATE_KEYS = (d.SEG_FD, d.SEG_EPF, d.SEG_P2P)

#                  EQ_IN  EQ_US   MF   COMM   P2P    FD    EPF   NPS  MF_DEBT
_CORR_MATRIX = (
    (1.00, 0.55, 0.90, -0.05, 0.05, 0.00, 0.00, 0.70, 0.05),
    (0.55, 1.00, 0.55, 0.00, 0.05, 0.00, 0.00, 0.40, 0.00),
    (0.90, 0.55, 1.00, -0.05, 0.05, 0.05, 0.00, 0.75, 0.10),
    (-0.05, 0.00, -0.05, 1.00, 0.00, 0.00, 0.00, 0.00, 0.05),
    (0.05, 0.05, 0.05, 0.00, 1.00, 0.10, 0.00, 0.05, 0.10),
    (0.00, 0.00, 0.05, 0.00, 0.10, 1.00, 0.20, 0.10, 0.30),
    (0.00, 0.00, 0.00, 0.00, 0.00, 0.20, 1.00, 0.10, 0.20),
    (0.70, 0.40, 0.75, 0.00, 0.05, 0.10, 0.10, 1.00, 0.30),
    (0.05, 0.00, 0.10, 0.05, 0.10, 0.30, 0.20, 0.30, 1.00),
)
CORR: dict[str, dict[str, float]] = {a: {b: _CORR_MATRIX[i][j] for j, b in enumerate(KEYS)} for i, a in enumerate(KEYS)}
CORR_NOTE = "Positive definite as specified."

# Copy for forward-looking numbers (SPEC §1.9 / §6.12); forecast.HONESTY is this same object (G4).
# `signal` labels market signals (§6.12); `cone` labels a holding's statistical range (H16).
HONESTY = {
    "p50": "Typical — half of {sims} simulated futures end higher",
    "p10": "1-in-10 bad case",
    "p90": "1-in-10 good case",
    "mean": "Average, pulled up by the best cases",
    "probability": "{n} of 100 futures",
    "estimate": "est.",
    "signal": "range if it moves as it has; not a forecast",
    "cone": "statistical range at the asset class's long-run return; not a forecast",
    "disclaimer": "Estimates from long-run assumptions, not predictions or advice. Real returns will differ.",
}

# An empty portfolio is assumed to be a diversified mutual fund (forecast.blended_assumptions, and the W4 review:
# the portfolio chip and /assumptions bands say the same thing instead of 0% ± 0%).
NO_HOLDINGS_MIX: dict[str, float] = {d.SEG_MF: 1.0}
NO_HOLDINGS_BASIS = "diversified mutual fund (no holdings yet)"


def honesty_view(sims: int) -> dict[str, str]:
    """HONESTY for a page that lists the labels (GET /assumptions): p50 formatted for `sims`, and the {n}
    template of `probability` described rather than printed raw (W4 review)."""
    return {**HONESTY, "p50": HONESTY["p50"].format(sims=f"{int(sims or 0):,}"),
            "probability": "Chances are given as N of 100 simulated futures"}


# ── Positions → keys ──
def _num(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def book_key(position: dict) -> str:
    """The Book row for a position: its segment, with debt mutual funds split out as `MF_DEBT`.

    An MF is debt when `tax_class == 'debt'` or its `category`/`sub_category` matches the debt regex
    (the name is never read). The USD cash wallet maps to `Equity (USA)`.
    """
    if position.get("asset_class") == d.CASH:
        return d.SEG_EQ_US
    seg = position.get("segment") or d.segment_of(position)
    if seg == d.SEG_MF and (position.get("tax_class") == d.TAX_DEBT
                            or any(DEBT_MF_RE.search(str(position.get(k) or "")) for k in ("category", "sub_category"))):
        return MF_DEBT
    return seg


def _open_valued(positions) -> list[tuple[dict, float]]:
    out = []
    for p in positions or []:
        v = _num(p.get("value")) or 0.0
        if p.get("is_open", True) and v > 0:
            out.append((p, v))
    return out


# ── The book ──
def _row(mu: float, sigma: float, source: str = "default") -> dict:
    return {"return_pct": round(mu * 100, 4), "vol_pct": round(sigma * 100, 4), "source": source}


def _finite(v) -> float | None:
    """v as a float when it is a real, finite number (bool is not a number here), else None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    v = float(v)
    return v if math.isfinite(v) else None


def effective_book(settings: dict | None = None) -> dict:
    """The Book in the §6.1 shape, with the user's P2 overrides (AMENDMENTS R4) applied.

    P2P's default μ is net of the expected loss (0.10 − P2P_LOSS).

    Overrides come from `settings['assumptions']` in the §7.7 shape {segments: {key: {return_pct, vol_pct}},
    inflation_pct}. Each listed Book key takes both numbers with `source: 'override'` (a P2P return_pct is the
    net return, the Book row's meaning), and `inflation_pct` replaces the default. A missing, null or {} value,
    and any shape without `segments` / `inflation_pct`, means no overrides. The stored value was checked by
    `validate_overrides`; a row that is still malformed (an unknown key, a missing or non-finite number) is
    skipped rather than trusted. `rated_book` still replaces the FD, EPF and P2P returns with holding rates when
    such positions exist; an override's vol_pct for those keys survives that."""
    segs = {k: _row(mu - P2P_LOSS if k == d.SEG_P2P else mu, sigma) for k, (mu, sigma) in ASSUMPTIONS.items()}
    inflation = round(INFLATION * 100, 4)
    ov = (settings or {}).get("assumptions") if isinstance(settings, dict) else None
    if isinstance(ov, dict):
        rows = ov.get("segments")
        for key, row in (rows.items() if isinstance(rows, dict) else ()):
            if key not in segs or not isinstance(row, dict):
                continue
            ret, vol = _finite(row.get("return_pct")), _finite(row.get("vol_pct"))
            if ret is None or vol is None:
                continue
            segs[key] = {"return_pct": round(ret, 4), "vol_pct": round(vol, 4), "source": "override"}
        infl = _finite(ov.get("inflation_pct"))
        if infl is not None:
            inflation = round(infl, 4)
    return {"segments": segs, "inflation_pct": inflation}


# R4: the editable ranges, in percent
OVERRIDE_RETURN = (-5.0, 25.0)
OVERRIDE_VOL = (0.0, 60.0)
OVERRIDE_INFLATION = (0.0, 15.0)


def validate_overrides(value) -> dict | None:
    """Check a PUT /settings/assumptions value (§7.7, AMENDMENTS R4) and return what to store.

    None or {} clears the overrides and returns {}. Otherwise the value is an object with only `segments` and
    `inflation_pct` (either may be absent or null). `segments` maps Book keys (`KEYS`, MF_DEBT included) to rows
    that need both `return_pct` in −5..25 and `vol_pct` in 0..60 as finite numbers; extra row keys are dropped.
    `inflation_pct` must be in 0..15. Anything else raises ValueError with a message for a 400."""
    if value is None or value == {}:
        return {}
    if not isinstance(value, dict):
        raise ValueError("assumptions must be an object")
    unknown = sorted(set(value) - {"segments", "inflation_pct"})
    if unknown:
        raise ValueError("Unknown assumption field(s): " + ", ".join(map(str, unknown)))
    out: dict = {}
    rows = value.get("segments")
    if rows is not None:
        if not isinstance(rows, dict):
            raise ValueError("segments must be an object of class → {return_pct, vol_pct}")
        clean = {}
        for key, row in rows.items():
            if key not in KEYS:
                raise ValueError(f"Unknown asset class '{key}'")
            if not isinstance(row, dict):
                raise ValueError(f"{key} must be an object with return_pct and vol_pct")
            for field, (lo, hi) in (("return_pct", OVERRIDE_RETURN), ("vol_pct", OVERRIDE_VOL)):
                v = _finite(row.get(field))
                if v is None:
                    raise ValueError(f"{key} {field} must be a number")
                if not lo <= v <= hi:
                    raise ValueError(f"{key} {field} must be between {lo:g} and {hi:g}")
            clean[key] = {"return_pct": float(row["return_pct"]), "vol_pct": float(row["vol_pct"])}
        if clean:
            out["segments"] = clean
    if value.get("inflation_pct") is not None:
        v = _finite(value["inflation_pct"])
        if v is None:
            raise ValueError("inflation_pct must be a number")
        lo, hi = OVERRIDE_INFLATION
        if not lo <= v <= hi:
            raise ValueError(f"inflation_pct must be between {lo:g} and {hi:g}")
        out["inflation_pct"] = v
    return out


def book_hash(book: dict) -> str:
    """First 10 hex digits of the SHA-1 of the canonical JSON: stable under key order."""
    return hashlib.sha1(json.dumps(book, sort_keys=True).encode("utf-8")).hexdigest()[:10]


def _position_rate(p: dict, key: str) -> tuple[float, bool]:
    """(μ, capped) of one rated position as a fraction."""
    rate = _num(p.get("rate"))
    if key == d.SEG_EPF:
        return (rate / 100 if rate else EPF_DEFAULT), False
    if key == d.SEG_FD:
        return (rate / 100 if rate else ASSUMPTIONS[d.SEG_FD][0]), False
    # P2P: a defaulted loan earns nothing (as quant's ballast treats it)
    if (p.get("status") or "").lower() == "defaulted":
        return 0.0, False
    mu = (rate / 100 if rate else ASSUMPTIONS[d.SEG_P2P][0]) - P2P_LOSS
    return (P2P_MU_CAP, True) if mu > P2P_MU_CAP else (mu, False)


def rated_book(positions, book: dict | None = None) -> dict:
    """A copy of `book` whose FD, EPF and P2P μ are the value-weighted instrument rates of the open
    positions (P2P net of P2P_LOSS, capped at P2P_MU_CAP per position). σ is unchanged; a segment with
    no rated position keeps its row."""
    book = book or effective_book(None)
    out = {**book, "segments": {k: dict(v) for k, v in (book.get("segments") or {}).items()}}
    acc: dict[str, list[float]] = {}
    capped: set[str] = set()
    for p, v in _open_valued(positions):
        key = book_key(p)
        if key not in RATE_KEYS:
            continue
        mu, cap = _position_rate(p, key)
        a = acc.setdefault(key, [0.0, 0.0])
        a[0] += mu * v
        a[1] += v
        if cap:
            capped.add(key)
    for key, (num, den) in acc.items():
        row = out["segments"].get(key) or _row(*ASSUMPTIONS[key])
        row = {**row, "return_pct": round(num / den * 100, 4), "source": "holding rates"}
        if key in capped:
            row["capped"] = True
        out["segments"][key] = row
    return out


def weights_from_positions(positions, book: dict | None = None) -> dict[str, float]:
    """{key: weight} by value over open positions with value > 0, normalised to 1 ({} when empty).
    `book` is accepted for the §6.1 signature; the weights do not depend on it."""
    w: dict[str, float] = {}
    for p, v in _open_valued(positions):
        k = book_key(p)
        w[k] = w.get(k, 0.0) + v
    tot = sum(w.values())
    return {k: v / tot for k, v in w.items()} if tot > 0 else {}


def _mu_sigma_of(book: dict | None, key: str) -> tuple[float, float] | None:
    """(μ, σ) of a key in either the §6.1 shape or a plain {key: (mu, sigma)} map; None when unknown."""
    if book is None:
        book = effective_book(None)
    segs = book.get("segments") if isinstance(book.get("segments"), dict) else book
    row = segs.get(key)
    if row is None:
        return None
    if isinstance(row, dict):
        return float(row.get("return_pct") or 0) / 100, float(row.get("vol_pct", row.get("volatility_pct")) or 0) / 100
    return float(row[0]), float(row[1])


def mu_sigma(w: dict[str, float], book: dict | None = None, *, notes: list | None = None) -> tuple[float, float]:
    """μ = Σ wᵢμᵢ and σ = √(Σᵢ Σⱼ wᵢwⱼρᵢⱼσᵢσⱼ) over Book keys.

    Weights are used as given (not renormalised). (0, 0) when Σw = 0. A key missing from the book or
    from CORR is ignored and, when `notes` is a list, named there."""
    rows: dict[str, tuple[float, float, float]] = {}
    for k, x in (w or {}).items():
        x = float(x or 0)
        if x == 0:
            continue
        ms = _mu_sigma_of(book, k)
        if ms is None or k not in CORR:
            if notes is not None:
                notes.append(f"No assumption for {k}; left out of the estimate.")
            continue
        rows[k] = (x, ms[0], ms[1])
    if not rows or sum(x for x, _, _ in rows.values()) == 0:
        return 0.0, 0.0
    mu = sum(x * m for x, m, _ in rows.values())
    var = 0.0
    for a, (xa, _, sa) in rows.items():
        for b, (xb, _, sb) in rows.items():
            var += xa * xb * CORR[a][b] * sa * sb
    return mu, math.sqrt(max(var, 0.0))


# ── Typical (median) growth ──
def typical(mu: float, sigma: float) -> float:
    """The median annual growth of the log-normal with arithmetic mean μ: exp(ln(1+μ) − σ²/2) − 1."""
    if mu <= -1:
        return -1.0
    return math.exp(math.log(1 + mu) - sigma * sigma / 2) - 1


def typical_band(mu: float, sigma: float, years: float) -> dict:
    """Annualised return over T = max(years, 1) years: the median and the 1-in-10 band, in percent."""
    t = max(float(years or 0), 1.0)
    if mu <= -1:
        return {"typical": -100.0, "lo": -100.0, "hi": -100.0}
    m = math.log(1 + mu) - sigma * sigma / 2
    s = sigma / math.sqrt(t)
    z = 1.2816
    return {"typical": round((math.exp(m) - 1) * 100, 2), "lo": round((math.exp(m - z * s) - 1) * 100, 2),
            "hi": round((math.exp(m + z * s) - 1) * 100, 2)}


# ── Status ──
def status_for(prob: float | None, achieved: bool = False) -> str | None:
    """'achieved' when the goal is already met; else ≥75 → 'on_track', ≥40 → 'at_risk', otherwise
    'off_track'. None when there is no probability."""
    if achieved:
        return "achieved"
    if prob is None:
        return None
    p = float(prob)
    return "on_track" if p >= STATUS_THRESHOLDS["on_track"] else "at_risk" if p >= STATUS_THRESHOLDS["at_risk"] else "off_track"


# ── The assumption chip ──
def chip(book: dict | None, w: dict[str, float]) -> dict:
    """{return_pct, typical_pct, volatility_pct, inflation_pct, hash, text} for a mix.

    Example text: "11.0% avg · 9.6% typical · ±12.4% · 6% inflation". When the mix holds P2P and its
    rate was capped, the text adds "P2P capped at 12%"."""
    book = book or effective_book(None)
    mu, sigma = mu_sigma(w, book)
    typ = typical(mu, sigma)
    infl = float(book.get("inflation_pct", INFLATION * 100))
    text = f"{mu * 100:.1f}% avg · {typ * 100:.1f}% typical · ±{sigma * 100:.1f}% · {infl:g}% inflation"
    p2p = (book.get("segments") or {}).get(d.SEG_P2P) or {}
    if (w or {}).get(d.SEG_P2P, 0) > 0 and p2p.get("capped"):
        text += f" · P2P capped at {P2P_MU_CAP * 100:g}%"
    return {"return_pct": round(mu * 100, 2), "typical_pct": round(typ * 100, 2), "volatility_pct": round(sigma * 100, 2),
            "inflation_pct": round(infl, 2), "hash": book_hash(book), "text": text}
