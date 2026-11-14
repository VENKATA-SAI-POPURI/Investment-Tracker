"""Monte Carlo helpers (SPEC §6.4, §7.1 mc row; AMENDMENTS E17)."""
import math
from pathlib import Path

import pytest

from tracker.analytics import mc, quant
from tracker.analytics.assumptions import typical

BASE = dict(pv=200000, months=120, mu=0.11, sigma=0.15)


def _prob(pv, months, mu, sigma, target, sip, seed=0, step_up=0.0, sims=mc.SIMS):
    """Share of paths reaching `target` with `sip`, re-simulated the E17 way (independent of the solver)."""
    years = math.ceil(months / 12)
    fracs = [1.0] * (years - 1) + [(months - 12 * (years - 1)) / 12]
    drift = math.log(1 + mu) - sigma * sigma / 2
    hits = 0
    for z in mc.annual_shocks(seed, sims, years):
        v = pv
        for k, f in enumerate(fracs):
            g = math.exp(drift * f + sigma * math.sqrt(f) * z[k])   # variance σ²f over a fraction f of a year
            v = v * g + sip * (1 + step_up) ** k * 12 * f * math.sqrt(g)
        hits += v >= target
    return hits / sims


def test_annual_shocks_shape_and_seed():
    z = mc.annual_shocks(3, 5, 4)
    assert len(z) == 5 and all(len(r) == 4 for r in z)
    assert z == mc.annual_shocks(3, 5, 4) and z != mc.annual_shocks(4, 5, 4)
    import random
    rng = random.Random(3)
    assert z[0][0] == rng.gauss(0, 1) and z[0][1] == rng.gauss(0, 1)   # row by row


def test_required_sip_is_monotone_in_the_target():
    sips = [mc.required_sip_for(target=t, **BASE)["sip_75"] for t in (1.0e6, 1.5e6, 2.0e6, 2.0e6 + 1, 3.0e6, 5.0e6)]
    assert sips == sorted(sips) and sips[0] > 0 and sips[-1] > sips[0]
    typ = [mc.required_sip_for(target=t, **BASE)["sip_typical"] for t in (1.0e6, 2.0e6, 5.0e6)]
    assert typ == sorted(typ)


def test_required_sip_repeats_for_the_same_seed():
    a = mc.required_sip_for(target=2.5e6, seed=17, **BASE)
    assert a == mc.required_sip_for(target=2.5e6, seed=17, **BASE)
    assert set(a) == {"sip_75", "sip_typical"} and all(isinstance(v, int) for v in a.values())


def test_sip_75_is_at_least_the_typical_sip():
    for target in (8e5, 1.5e6, 3e6):
        for sigma in (0.0, 0.01, 0.08, 0.15, 0.2):
            r = mc.required_sip_for(200000, 120, 0.11, sigma, target)
            assert r["sip_75"] >= r["sip_typical"]
    r = mc.required_sip_for(target=3e6, **BASE)
    assert r["sip_75"] > r["sip_typical"] * 1.05   # real volatility costs something


def test_sip_75_reaches_the_probability_and_no_less():
    target = 2.5e6
    s = mc.required_sip_for(target=target, **BASE)["sip_75"]
    assert _prob(target=target, sip=s, **BASE) >= 0.75
    assert _prob(target=target, sip=s * 0.97, **BASE) < 0.75
    s50 = mc.required_sip_for(target=target, prob=0.5, **BASE)["sip_75"]
    assert s50 < s and _prob(target=target, sip=s50, **BASE) >= 0.5


def test_target_already_reached_gives_zero():
    assert mc.required_sip_for(5e6, 60, 0.11, 0.15, 5e6) == {"sip_75": 0, "sip_typical": 0}
    assert mc.required_sip_for(6e6, 60, 0.11, 0.15, 5e6) == {"sip_75": 0, "sip_typical": 0}
    assert mc.required_sip_for(1e5, 0, 0.11, 0.15, 5e6) == {"sip_75": None, "sip_typical": None}   # no time left


def test_sip_typical_is_the_deterministic_sip_at_the_typical_return():
    pv, months, target = 100000, 60, 1e6
    s = mc.required_sip_for(pv, months, 0.10, 0.12, target)["sip_typical"]
    rm = (1 + typical(0.10, 0.12)) ** (1 / 12) - 1
    v = pv
    for _ in range(months):
        v = v * (1 + rm) + s
    one_rupee = sum((1 + rm) ** k for k in range(months))   # what ₹1 more a month adds by the end
    assert v >= target and v - target < one_rupee              # rounded up to ₹1


def test_partial_year_and_step_up():
    flat = mc.required_sip_for(target=2e6, **BASE)
    stepped = mc.required_sip_for(target=2e6, step_up=0.10, **BASE)
    assert stepped["sip_75"] < flat["sip_75"] and stepped["sip_typical"] < flat["sip_typical"]
    r = mc.required_sip_for(100000, 30, 0.10, 0.12, 1e6)   # 2.5 years: a half final year
    assert _prob(100000, 30, 0.10, 0.12, 1e6, r["sip_75"]) >= 0.75
    # σ = 0: every path is the same, so 75% and typical differ only by contribution timing
    z = mc.required_sip_for(100000, 120, 0.10, 0.0, 2e6)
    assert z["sip_75"] == pytest.approx(z["sip_typical"], rel=0.05)


def test_partial_year_shock_scales_with_the_root_of_the_fraction():
    """W2 review (amends E17): over a fraction f of a year the log-return has mean drift·f and variance σ²f."""
    mu, sigma = 0.12, 0.18
    drift = math.log(1 + mu) - sigma * sigma / 2
    a, b = mc._terminal_parts(1000.0, 6, mu, sigma, 0.0, [1.0])
    g = math.exp(drift * 0.5 + sigma * math.sqrt(0.5))
    assert a == pytest.approx(1000 * g) and b == pytest.approx(6 * math.sqrt(g))


def test_sip_75_holds_against_an_independent_simulation_with_partial_years():
    """The 75% SIP clears the target in about 75 of 100 futures drawn independently of the solver's paths, with
    σ√f partial-year shocks. Scaling the shock by f instead understated the last year's risk (≈ 70–73%)."""
    import random
    mu, sigma, pv = 0.12, 0.18, 100000

    def independent(months, target, sip, sims=10000):
        rng = random.Random(12345)
        years = math.ceil(months / 12)
        fracs = [1.0] * (years - 1) + [(months - 12 * (years - 1)) / 12]
        drift = math.log(1 + mu) - sigma * sigma / 2
        hits = 0
        for _ in range(sims):
            v = pv
            for f in fracs:
                g = math.exp(drift * f + sigma * math.sqrt(f) * rng.gauss(0, 1))
                v = v * g + sip * 12 * f * math.sqrt(g)
            hits += v >= target
        return hits / sims

    for months, target in ((6, 3e5), (30, 1e6)):
        sip = mc.required_sip_for(pv, months, mu, sigma, target)["sip_75"]
        assert 0.735 <= independent(months, target, sip) <= 0.80, (months, target, sip)


def test_pctl_reexports_quant_percentile_and_quant_does_not_import_mc():
    assert mc.pctl is quant.percentile
    assert mc.pctl([1.0, 2.0, 3.0, 4.0], 0.5) == 2.5
    src = Path(quant.__file__).read_text(encoding="utf-8")
    assert "import mc" not in src and "from .mc" not in src
