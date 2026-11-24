"""Use-cases composed from the ledger, market data and analytics."""
from __future__ import annotations

import json
import math
import re
import threading
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from . import domain as d
from . import markets as mk
from . import prices as px
from .analytics import actions as actions_mod
from .analytics import assumptions as A
from .analytics import brief as brief_mod
from .analytics import calendar as calendar_mod
from .analytics import forecast, optimizer, plans, quant
from .analytics import calibration as calibration_mod
from .analytics import goals as goals_mod
from .analytics import overview as overview_mod
from .analytics import scenarios as scen_mod
from .analytics import tax as tax_mod
from .analytics.calendar import build_calendar
from .analytics.health import health_score
from .analytics.history import build_history
from .analytics.insights import build_insights
from .analytics.portfolio import compute_portfolio, to_date
from .analytics.story import build_story
from .analytics.tax import compute_tax
from .ledger import Ledger

PRICE_TTL_MIN = 15
DEFAULT_SLAB = 0.30
NIFTY = px.BENCHMARKS["NIFTY50"]["symbol"]  # ^NSEI
NIFTY_KEY = f"quote:{NIFTY}"                 # system value: {price, prev_close, date}
FAMILY_OWNER = "__family__"                  # kpi_snapshots owner for the family view (SPEC §7.4)
GLOBAL_OWNER = "__global__"                  # settings owner of an admin or a guest
DONE_DAYS, LIST_MAX = 90, 50                 # E4: the Done list covers 90 days; Done and Snoozed hold ≤ 50 rows
# H14: the risk lookback is the 3.2 years services.outlook already fetches, so price_meta coverage is shared and a
# holding held about 3 years reaches 'own' data quality. portfolio_risk(lookback_days=365) still measures one year.
RISK_LOOKBACK_DAYS = int(3.2 * 365)
MARKET_STATE_DAYS = 400                      # H4: stored ^NSEI closes read for market_state (≥ 252 trading days)
PLAN_SNAPSHOT_DAYS = 30                      # /plan deltas and plan:probability-drop compare with 30 days ago
SNAP_PROJECTION_SIMS = 1000                  # H12: the snapshot's projection_1y
# H9: where each kind of arriving money is explained
ARRIVING_LINK = {"usd": "/forex", "fd": "/fixed-deposits", "p2p_principal": "/p2p", "escrow": "/cash-flows"}
_SKIP_ID = re.compile(r"^sip:(?:due|missed):([^:]+):(\d{4}-\d{2}-\d{2})$")   # A11: a skipped instalment's action id
OPEN_ID_PREFIXES = ("concentration:", "sector:")                             # H13: insight hysteresis

# A source the actions build could not compute is skipped and named in `notes` (E4). User-facing wording.
SOURCE_NOTE = {
    "insights": "Insights couldn't be checked right now",
    "calendar": "The money calendar couldn't be built right now",
    "cashflow": "Expected cash flows couldn't be projected right now",
    "cushion": "The emergency cushion couldn't be measured right now",
    "deploy": "Money free to invest couldn't be totalled right now",
    "risk": "The risk estimate is unavailable right now",
    "stress": "The stress test couldn't run right now",
    "retirement": "The retirement plan couldn't be checked right now",
    "snapshot": "Last month's snapshot couldn't be read",
    "adherence": "SIP instalments couldn't be matched right now",
    "upcoming": "The next 90 days couldn't be listed right now",
    "market_state": "The market's fall from its high couldn't be measured right now",
    "funding": "Where your money is earmarked couldn't be worked out right now",
    "sensitivities": "What moves the needle couldn't be worked out right now",
}


class Services:
    def __init__(self, ledger: Ledger):
        self.ledger = ledger
        # (snapshot owner, date) pairs whose KPI snapshot this process has already written (E7): a warm /brief
        # makes no database write at all
        self._snap_written: set[tuple[str, str]] = set()
        self._snap_lock = threading.Lock()

    # ── market data ──
    def usd_inr(self) -> float | None:
        raw = self.ledger.system_value("fx:USDINR")
        try:
            return float(json.loads(raw)["price"]) if raw else None
        except (ValueError, KeyError, TypeError):
            return None

    def prices_status(self) -> dict:
        raw = self.ledger.system_value("prices:last_refresh")
        return {"last_refresh": raw, "usd_inr": self.usd_inr()}

    def refresh_prices(self, scope: str | None, force: bool = False) -> dict:
        last = self.ledger.system_value("prices:last_refresh")
        if last and not force:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() / 60
            if age < PRICE_TTL_MIN:
                return {"refreshed": False, "last_refresh": last, "reason": "fresh"}
        data = self.ledger.load(scope)
        symbols = sorted({i["symbol"] for i in data["instruments"] if i.get("symbol") and i["asset_class"] in d.TRADABLE})
        version = self.ledger._version
        # The Nifty 50 quote rides in the same batch; it feeds the Home hero's "Nifty today"
        quotes = px.fetch_quotes(symbols + [px.USDINR, NIFTY])
        fx = quotes.pop(px.USDINR, None)
        nifty = quotes.get(NIFTY) if NIFTY in symbols else quotes.pop(NIFTY, None)
        self.ledger.store_quotes(quotes)
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if fx:
            self.ledger.set_system_value("fx:USDINR", json.dumps({"price": fx["price"], "at": stamp}))
        if nifty:  # a failed fetch leaves the previous quote in place
            self.ledger.set_system_value(NIFTY_KEY, json.dumps({"price": nifty["price"], "prev_close": nifty.get("prev_close"),
                                                                "date": nifty.get("date") or date.today().isoformat()}))
        got = [s for s in symbols if quotes.get(s)]
        if got or not symbols:
            # An outage (every holding quote failed) leaves the previous stamp, so the TTL lets the next call retry.
            # The stamp is shared by all owners; the Home Data vital reads each holding's own price_at instead.
            self.ledger.set_system_value("prices:last_refresh", stamp)
        if self.ledger._version == version:
            # No holding price changed, but the USD rate and the refresh stamp did, and the memoised portfolio
            # carries both: a refresh always invalidates, as it did before the portfolio was memoised
            self.ledger._bump()
        failed = [s for s, q in quotes.items() if not q]
        return {"refreshed": True,
                "last_refresh": stamp if (got or not symbols) else self.ledger.system_value("prices:last_refresh"),
                "updated": len(symbols) - len(failed), "failed": failed, "usd_inr": fx["price"] if fx else None}

    # ── analytics ──
    @staticmethod
    def settings_who() -> tuple[str, str]:
        """Whose settings the request reads (P2.6, §7.4, AMENDMENTS R11): (g.scope, 'user') when an admin or a guest
        has picked a member in the switcher, so the member's own rows apply over `__global__`; otherwise
        (g.email, g.role). An admin who picks themselves reads their own row, not the family plan."""
        from flask import g
        if getattr(g, "role", None) in ("admin", "guest") and getattr(g, "scope", None):
            return g.scope, "user"
        return g.email, g.role

    def settings(self) -> dict:
        """The request's settings (R11): `ledger.get_settings(*settings_who())`, a member's rows over `__global__`."""
        return self.ledger.get_settings(*self.settings_who())

    def owner(self) -> str:
        """The settings owner of the request (E3, R11): the user's email; the member picked in the switcher for an
        admin or a guest viewing one; '__global__' for the family view."""
        return self.ledger.settings_owner(*self.settings_who())

    @staticmethod
    def base_book(settings: dict) -> dict:
        """The base Book every engine reads (AMENDMENTS R4): `assumptions.effective_book(settings)`, which applies
        the saved overrides. Each engine rates it with the holdings itself, so payload hashes equal `book()`'s."""
        return A.effective_book(settings)

    @staticmethod
    def snapshot_owner(scope: str | None) -> str:
        """kpi_snapshots owner: the scope, or '__family__' for the family view (SPEC §7.4, E7)."""
        return scope or FAMILY_OWNER

    def portfolio(self, scope: str | None, settings: dict) -> tuple[dict, dict]:
        """(port, data), memoised on ('portfolio', scope, targetAllocation, today).
        RETURNED OBJECTS ARE SHARED AND READ-ONLY. Callers build new dicts (GET /portfolio sends a copy)."""
        targets = settings.get("targetAllocation") or {}
        return self._memo("portfolio", scope, targets, date.today(), fn=lambda: self._portfolio(scope, targets))

    def _portfolio(self, scope: str | None, targets: dict) -> tuple[dict, dict]:
        data = self.ledger.load(scope)
        port = compute_portfolio(data["instruments"], data["transactions"], self.usd_inr(), targets)
        port["contributions"] = self._contributions(data["cash_movements"])
        port["prices"] = self.prices_status()
        return port, data

    def context(self, scope: str | None, settings: dict) -> dict:
        """The shared read model: {port, data, fy, tax (current FY at taxSlabRate), goals (each projected with the
        positions), sips, adherence}. Memoised on ('context', scope, settings, today), so insights, pulse,
        notifications, goals and tax build the portfolio once between writes.

        `adherence` is always None here (AMENDMENTS H2): SIP adherence reads the action log (a skipped instalment is
        a dismissed action), and a status POST bumps only actions_rev, which this memo is not keyed on. Use
        `Services.adherence(...)`; /brief hands build_brief a shallow copy {**ctx, 'adherence': ...}.

        RETURNED OBJECTS ARE SHARED AND READ-ONLY. Callers build new dicts; never pop or assign into them."""
        return self._memo("context", scope, settings, date.today(), fn=lambda: self._context(scope, settings))

    def _context(self, scope: str | None, settings: dict) -> dict:
        port, data = self.portfolio(scope, settings)
        fy = d.fy_of(date.today().isoformat())
        tax = compute_tax(port, data["transactions"], data["instruments"], fy, self._slab(settings))
        sips = self.ledger.sips(scope)
        return {"port": port, "data": data, "fy": fy, "tax": tax,
                "goals": self._project_goals(scope, port, settings, sips), "sips": sips, "adherence": None}

    @staticmethod
    def _slab(settings: dict) -> float:
        return float(settings.get("taxSlabRate") or DEFAULT_SLAB * 100) / 100

    @staticmethod
    def _contributions(cash: list[dict]) -> dict:
        cap = [c for c in cash if c["account"] == "capital"]
        dep = sum(float(c["amount"] or 0) for c in cap if c["direction"] == "in")
        wd = sum(float(c["amount"] or 0) for c in cap if c["direction"] == "out" and c.get("kind") != "Profit Withdrawal")
        profit = sum(float(c["amount"] or 0) for c in cap if c.get("kind") == "Profit Withdrawal")
        esc = [c for c in cash if c["account"] == "p2p_escrow"]
        escrow = sum(float(c["amount"] or 0) * (1 if c["direction"] == "in" else -1) for c in esc)
        return {"deposits": round(dep, 2), "withdrawals": round(wd, 2), "profit_withdrawals": round(profit, 2),
                "net": round(dep - wd - profit, 2), "p2p_escrow_balance": round(escrow, 2)}

    @staticmethod
    def _key(*key) -> tuple:
        return ("svc", *[json.dumps(k, sort_keys=True, default=str) for k in key])

    def _memo(self, *key, fn):
        """Heavy analytics, recomputed only after a write or a price refresh (both bump the ledger version)."""
        return self.ledger._cached(self._key(*key), fn)

    def _peek(self, *key):
        """The memo entry for `key` (same arguments as _memo) without building it; None if missing or stale.
        Lets a fast endpoint use an expensive result (e.g. performance) only when it is already warm."""
        return self.ledger._peek(self._key(*key))

    def performance(self, scope: str | None, rng: str = "ALL", segment: str | None = None) -> dict:
        return self._memo("performance", scope, rng, segment, fn=lambda: self._performance(scope, rng, segment))

    def _performance(self, scope: str | None, rng: str, segment: str | None) -> dict:
        data = self.ledger.load(scope)
        insts, txns = data["instruments"], data["transactions"]
        if segment:
            insts = [i for i in insts if d.segment_of(i) == segment]
            ids = {i["id"] for i in insts}
            txns = [t for t in txns if t["instrument_id"] in ids]
        if not txns:
            return {"series": [], "metrics": {}, "benchmarks": [], "monthly": []}
        start = min(to_date(t["date"]) for t in txns)
        symbols = {i["symbol"] for i in insts if i.get("symbol") and i["asset_class"] in d.TRADABLE}
        bench_keys = ["NIFTY50", "NIFTY500", "SP500", "GOLD"]
        if segment == d.SEG_EQ_US:
            bench_keys = ["SP500", "NIFTY50"]
        elif segment == d.SEG_COMMODITY:
            bench_keys = ["GOLD", "NIFTY50"]
        bench_syms = {px.BENCHMARKS[k]["symbol"] for k in bench_keys}
        # USD/INR is always needed: US holdings and the S&P 500 benchmark are valued in rupees
        hist = px.ensure_history(self.ledger.db, sorted(symbols | bench_syms | {px.USDINR}), start)
        bench_hist = {k: {**px.BENCHMARKS[k], "points": hist.get(px.BENCHMARKS[k]["symbol"], [])} for k in bench_keys}
        result = build_history(insts, txns, {s: hist.get(s, []) for s in symbols}, hist.get(px.USDINR, []), bench_hist,
                               rng=rng)
        result["segment"] = segment
        return result

    # ── the redesigned app: groups, market comparison, rebalancing, suggestions ──
    BENCH_KEYS = ("NIFTY500", "SP500", "GOLD")

    def bench_history(self, txns: list[dict]) -> tuple[dict, list]:
        """Benchmark closes (Nifty 500, S&P 500, gold) and USD/INR from the first transaction on. A failed fetch
        returns what is stored; comparisons that need a missing series come back empty, never wrong."""
        if not txns:
            return {}, []
        start = min(to_date(t["date"]) for t in txns)
        syms = [px.BENCHMARKS[k]["symbol"] for k in self.BENCH_KEYS] + [px.USDINR]
        try:
            hist = px.ensure_history(self.ledger.db, syms, start)
        except Exception as e:  # noqa: BLE001 — the overview still loads without market comparison
            print(f"[overview] benchmark history unavailable: {e!r}")
            hist = {}
        bench = {k: {**px.BENCHMARKS[k], "points": hist.get(px.BENCHMARKS[k]["symbol"], [])} for k in self.BENCH_KEYS}
        return bench, hist.get(px.USDINR, [])

    def overview(self, scope: str | None, settings: dict) -> dict:
        """Totals, the seven groups (targets, market comparison) and up to five suggestions. Memoised like the
        portfolio. RETURNED OBJECTS ARE SHARED AND READ-ONLY."""
        def build() -> dict:
            ctx = self.context(scope, settings)
            port, data = ctx["port"], ctx["data"]
            bench, fx = self.bench_history(data["transactions"])
            view = overview_mod.group_view(port, data["transactions"], settings, bench, fx)
            view["suggestions"] = overview_mod.suggestions(view, port, ctx["tax"], date.today(), self._slab(settings))
            return view
        return self._memo("overview", scope, settings, date.today(), fn=build)

    def group_rebalance(self, scope: str | None, settings: dict, new_money: float, allow_sell: bool,
                        target_set: str = "mine") -> dict:
        view = self.overview(scope, settings)
        t = view["targets"]
        targets = (t["mine"] if target_set == "mine" and t["mine"] else t["suggested"]["mix"])
        ctx = self.context(scope, settings)
        port, data = ctx["port"], ctx["data"]

        def plan(legs):
            return tax_mod.plan_sales(port, data["transactions"], data["instruments"], legs,
                                      slab_rate=self._slab(settings), today=date.today())
        res = overview_mod.rebalance(view["groups"], targets, new_money, allow_sell, plan_sales=plan)
        res["target_set"] = "mine" if targets is t["mine"] else "suggested"
        return res

    def tax(self, scope: str | None, settings: dict, fy: str | None = None) -> dict:
        """Tax for `fy` (default: the current FY, which is the context's computation) plus the list of years."""
        ctx = self.context(scope, settings)
        port, data = ctx["port"], ctx["data"]
        fy = fy or ctx["fy"]
        if fy == ctx["fy"]:
            base = ctx["tax"]
        else:
            base = self._memo("tax", scope, settings, fy, date.today(), fn=lambda: compute_tax(
                port, data["transactions"], data["instruments"], fy, self._slab(settings)))
        years = {d.fy_of(r["sell_date"]) for r in port["realized_lots"]}
        years |= {d.fy_of(str(t["date"])) for t in data["transactions"]
                  if t["type"] in (d.DIVIDEND, d.REPAYMENT, d.INTEREST, d.MATURITY)}
        years.add(ctx["fy"])
        return {**base, "years": sorted(years, reverse=True)}  # a new dict: the memoised tax stays untouched

    def goals(self, scope: str | None, settings: dict, port: dict | None = None) -> list[dict]:
        """Goals with their projections; read from the context unless a specific portfolio is passed."""
        if port is not None:
            return self._project_goals(scope, port, settings)
        return self.context(scope, settings)["goals"]

    def _project_goals(self, scope: str | None, port: dict, settings: dict | None = None,
                       sips: list[dict] | None = None) -> list[dict]:
        """Each goal projected (K15, R3, R4): with the positions (G2/H14: a debt fund inside a goal's Mutual Funds
        share counts at MF_DEBT), the SIP plans linked to it (`goal_id`), and the base Book."""
        sips = self.ledger.sips(scope) if sips is None else sips
        book = self.base_book(settings or {})
        out = []
        for g in self.ledger.goals(scope):
            g = dict(g)
            g["allocation"] = goals_mod.parse_allocation(g.get("allocation"))
            linked = [s for s in sips if s.get("goal_id") is not None and s.get("goal_id") == g.get("id")]
            g["projection"] = goals_mod.project_goal(g, port["segments"], positions=port.get("positions"),
                                                     linked_sips=linked, book=book)
            out.append(g)
        return out

    def book(self, scope: str | None, settings: dict) -> dict:
        """The Assumption Book these numbers come from (AMENDMENTS H5): {book: rated_book(positions,
        effective_book(settings)), hash: book_hash(book)}. Memoised on ('book', scope, settings.assumptions, today).
        The hash goes into the forecast, retirement, stress, cash-flow, brief, plan and assumptions memo keys, and
        equals every forward payload's `assumptions.hash`. RETURNED OBJECTS ARE SHARED AND READ-ONLY."""
        def build() -> dict:
            port, _ = self.portfolio(scope, settings)
            b = A.rated_book(port.get("positions") or [], A.effective_book(settings))
            return {"book": b, "hash": A.book_hash(b)}
        return self._memo("book", scope, settings.get("assumptions"), date.today(), fn=build)

    def _hash(self, scope: str | None, settings: dict) -> str:
        return self.book(scope, settings)["hash"]

    def insights(self, scope: str | None, settings: dict, with_performance: bool = True) -> dict:
        """{insights, portfolio, tax, goals, performance} (AMENDMENTS H13).

        Without performance (the bell, /insights?performance=0) the list IS the action path's
        (`_action_inputs(...)['insights']`), so the bell and /actions can never disagree. With performance (/insights,
        /pulse, the AI context) it is built once more with the same keyword sources plus the history metrics.
        E11: the action log is the only place a snooze lives; the dismissedInsights setting is never read."""
        ctx = self.context(scope, settings)
        port, data, tax, goals = ctx["port"], ctx["data"], ctx["tax"], ctx["goals"]
        inp = self._action_inputs(scope, settings)
        perf = None
        if with_performance:
            try:
                perf = self.performance(scope, "ALL")
            except Exception as e:  # noqa: BLE001 — market data outage must not hide other insights
                print(f"[insights] performance unavailable: {e}")
        if not with_performance and inp.get("insights") is not None:
            items = inp["insights"]
        else:
            items = build_insights(port, tax, goals, self._insight_settings(settings), (perf or {}).get("metrics"),
                                   (perf or {}).get("benchmarks"), sips=ctx["sips"], txns=data["transactions"],
                                   **self._insight_kwargs(inp))
        return {"insights": items, "portfolio": port, "tax": tax, "goals": goals, "performance": perf}

    @staticmethod
    def _insight_kwargs(inp: dict) -> dict:
        """H13: the keyword sources every build_insights call gets (adherence never: it would key on actions_rev)."""
        return {"cushion": inp.get("cushion"), "risk_est": inp.get("risk_est"), "stress": inp.get("stress"),
                "snapshot_then": inp.get("snapshot_then"), "book": inp.get("book"), "open_ids": inp.get("open_ids")}

    # ── forecasting, risk and planning ──
    @staticmethod
    def monthly_sip_total(sips: list[dict]) -> float:
        """Monthly equivalent of the plans running today (SPEC §6.6 rule 8: a plan that starts later is left out).
        One definition for /sips, the forecast, stress, retirement and the cash-flow payload."""
        return forecast.monthly_sip_total(sips)

    def _perf_metrics(self, scope: str | None) -> dict | None:
        try:
            return self.performance(scope, "ALL").get("metrics")
        except Exception as e:  # noqa: BLE001 — market data outage must not block a projection
            print(f"[forecast] performance unavailable: {e}")
            return None

    @staticmethod
    def _inflation(settings: dict, book: dict | None = None) -> float | None:
        """The projection's inflation as a fraction (A1, R4: its real_p50): retirementPlan.inflation_pct when saved,
        else the base Book's `inflation_pct` when `book` is given (6% with no override), else None."""
        rp = settings.get("retirementPlan")
        raw = rp.get("inflation_pct") if isinstance(rp, dict) else None
        try:
            if raw not in (None, ""):
                return float(raw) / 100
        except (TypeError, ValueError):
            pass
        return forecast.book_inflation_pct(book) / 100 if book is not None else None

    @staticmethod
    def _saved_plan(settings: dict) -> dict | None:
        """The saved retirementPlan, unmerged (L5: a merged `monthly_sip: 0` would always beat the plans), or None."""
        rp = settings.get("retirementPlan")
        return dict(rp) if isinstance(rp, dict) and rp else None

    def forecast(self, scope: str | None, settings: dict, years: int, sip: float | None, step_up: float, sims: int,
                 return_pct: float | None, after_tax: bool = False) -> dict:
        """GET /forecast (K9, R3, R4): `project_portfolio` with the plans (`sips`; `monthly_sip=None` when the request
        names no `sip`, so each plan is routed to its own class, `flows_basis` 'plans'), the ledger (EPF average, FD
        maturities), the saved targets (where maturities go), `after_tax` at the slab and the base Book.
        Memoised on the H5 hash, the flow inputs, the inflation, `after_tax` and the slab (K21)."""
        today = date.today()
        sips = self.ledger.sips(scope)
        book = self.base_book(settings)
        infl = self._inflation(settings, book)
        slab = self._slab(settings)
        targets = settings.get("targetAllocation") or None
        plans_total = self.monthly_sip_total(sips)
        key = (years, sip, plans_total, step_up, sims, return_pct, infl, today, self._hash(scope, settings),
               bool(after_tax), slab, targets)

        def build() -> dict:
            port, data = self.portfolio(scope, settings)
            res = forecast.project_portfolio(
                port, self._perf_metrics(scope), years, sip, step_up, sims, today=today, return_override=return_pct,
                inflation=infl, sips=sips, txns=data["transactions"], instruments=data["instruments"],
                targets=targets, after_tax=bool(after_tax), slab_rate=slab, book=book)
            return res | {"sip_plans_total": plans_total}
        return self._memo("forecast", scope, key, fn=build)

    def _risk_ready(self, scope: str | None, settings: dict) -> dict | None:
        """The risk payload when its memo is already warm (K11: β is never built for a stress test), else None."""
        return self._peek("risk", scope, date.today(), self._hash(scope, settings))

    @staticmethod
    def _betas(risk: dict | None) -> dict | None:
        """{holding id: β} from `risk.holdings[]` (the rows carry `id`, R3); None without a warm risk payload."""
        if not risk:
            return None
        out = {h.get("id"): h.get("beta") for h in risk.get("holdings") or []
               if h.get("id") is not None and h.get("beta") is not None}
        return out or None

    def stress(self, scope: str | None, settings: dict) -> dict:
        """The stress test the brief, /actions, market_state and Risk T0 use (K11, R3): β-scaled only when the risk
        memo is warm (`risk_ready` in the key, as perf_ready elsewhere), never `plan`. E12: keyed on the date (the
        SIP total depends on it); H5: and on the Book hash."""
        risk = self._risk_ready(scope, settings)
        return self._memo("stress", scope, date.today(), self._hash(scope, settings), risk is not None,
                          fn=lambda: forecast.stress_test(
                              self.portfolio(scope, settings)[0], self.monthly_sip_total(self.ledger.sips(scope)),
                              betas=self._betas(risk), book=self.base_book(settings)))

    def stress_detail(self, scope: str | None, settings: dict) -> dict:
        """GET /forecast/stress (K11, R3): the stress test plus `plan_impact`, for the Risk & mix stress page only.

        `plan` = {retirement: the saved retirementPlan unmerged (L5) or None, goals: the context goal rows}, with the
        plans, the ledger and today. β comes only from a warm risk memo. Up to 7 runs of 500 sims, so it is
        memoised on its own key, which carries the plan's hash (retirementPlan, goal ids, targets, dates and monthly
        contributions, and the plans' total), the Book hash and risk_ready."""
        today = date.today()
        ctx = self.context(scope, settings)
        saved = self._saved_plan(settings)
        goals = [{k: g.get(k) for k in ("id", "name", "allocation", "target_amount", "target_date",
                                         "monthly_contribution")} for g in ctx["goals"]]
        sips = ctx["sips"]
        plan_hash = json.dumps({"retirement": saved, "goals": goals, "plans": self.monthly_sip_total(sips),
                                "links": sorted((s.get("id"), s.get("goal_id")) for s in sips
                                                if s.get("goal_id") is not None)},
                               sort_keys=True, default=str)
        risk = self._risk_ready(scope, settings)

        def build() -> dict:
            port, data = ctx["port"], ctx["data"]
            return forecast.stress_test(port, self.monthly_sip_total(sips), betas=self._betas(risk),
                                        plan={"retirement": saved, "goals": goals}, sips=sips,
                                        txns=data["transactions"], instruments=data["instruments"], today=today,
                                        book=self.base_book(settings))
        return self._memo("stress_detail", scope, today, self._hash(scope, settings), risk is not None, plan_hash,
                          fn=build)

    def _funding(self, scope: str | None, settings: dict) -> dict | None:
        """`goals.funding_summary(goals, segments, positions, emergencyFund)`: the funding /plan shows (K21), so the
        Plan funding stack and the retirement corpus agree. Memoised on ('funding', scope, settings, today), so
        /plan and the retirement it shows compute it once. Raises what funding_summary raises.
        RETURNED OBJECTS ARE SHARED AND READ-ONLY."""
        def build() -> dict:
            ctx = self.context(scope, settings)
            ef = settings.get("emergencyFund") if isinstance(settings.get("emergencyFund"), dict) else None
            return goals_mod.funding_summary(ctx["goals"], ctx["port"]["segments"], ctx["port"].get("positions"), ef)
        return self._memo("funding", scope, settings, date.today(), fn=build)

    def retirement(self, scope: str | None, settings: dict, params: dict, *, build_history: bool = True) -> dict:
        """The retirement plan (K10, L5, R3): the saved retirementPlan overlaid with the planner's `params`.

        `monthly_sip` is never filled in here: with none named, the plans (`sips`) run on their own dates and classes;
        a typed SIP wins over them (L5). The money used is EPF + NPS + the goal-free share of the rest, from the same
        `funding_summary` /plan shows. With no inflation named, the base Book's applies (R4). One path serves
        /brief, /actions, /plan and GET /forecast/retirement, so they show one probability.

        With build_history=False (the /actions and /brief path, which never build history) the record-blended
        assumptions use the ALL-range performance only when it is already warm; whether it was is part of the
        memo key, so the two paths never serve each other a result computed on different inputs. The key also holds
        the emergencyFund (the funding) and the plans' monthly total."""
        saved = dict(settings.get("retirementPlan") or {})
        merged = {**saved, **{k: v for k, v in params.items() if v not in (None, "")}}
        if build_history:
            metrics = self._perf_metrics(scope)
        else:
            metrics = (self._peek("performance", scope, "ALL", None) or {}).get("metrics")
        sips = self.ledger.sips(scope)
        ef = settings.get("emergencyFund") if isinstance(settings.get("emergencyFund"), dict) else None

        def build() -> dict:
            port, data = self.portfolio(scope, settings)
            try:
                funding = self._funding(scope, settings)
            except Exception as e:  # noqa: BLE001 — the whole portfolio is used, as before K10
                print(f"[retirement] funding unavailable: {e!r}")
                funding = None
            return forecast.retirement_plan(port, metrics, merged, funding=funding, txns=data["transactions"],
                                            instruments=data["instruments"], sips=sips,
                                            book=self.base_book(settings))
        return self._memo("retirement", scope, merged, date.today(), metrics is not None, self._hash(scope, settings),
                          ef, self.monthly_sip_total(sips), fn=build)

    def cashflow(self, scope: str | None, settings: dict, months: int = 12) -> dict:
        def build():
            port, data = self.portfolio(scope, settings)
            return forecast.cash_flow_forecast(port["positions"], data["instruments"], data["transactions"],
                                               self.ledger.sips(scope), months, book=self.base_book(settings))
        return self._memo("cashflow", scope, months, date.today(), self._hash(scope, settings), fn=build)

    def risk(self, scope: str | None, settings: dict) -> dict:
        def build():
            port, _ = self.portfolio(scope, settings)
            priced = [p for p in port["positions"] if p.get("is_open") and p["asset_class"] in d.TRADABLE and p.get("symbol")]
            symbols = sorted({p["symbol"] for p in priced})
            bench = px.BENCHMARKS["NIFTY50"]["symbol"]
            start = date.today() - timedelta(days=RISK_LOOKBACK_DAYS)
            # A1/E12: the ^GSPC and GOLDBEES.NS proxy histories ride in the same call, so a US or gold holding
            # counts from day one instead of only from its own first close
            proxy_syms = [quant.GSPC, quant.GOLDBEES]
            fetch = sorted(set(symbols) | {bench, px.USDINR, *proxy_syms})
            hist = px.ensure_history(self.ledger.db, fetch, start) if symbols else {}
            proxies = {s: hist[s] for s in proxy_syms if hist.get(s)}
            res = quant.portfolio_risk(port["positions"], hist, hist.get(bench), hist.get(px.USDINR), proxies=proxies,
                                       book=self.base_book(settings))
            res["benchmark"] = px.BENCHMARKS["NIFTY50"]["label"]
            return res
        # R3: the Book hash is in the key (an override moves the Book σ the ballast uses)
        return self._memo("risk", scope, date.today(), self._hash(scope, settings), fn=build)

    def outlook(self, scope: str | None, settings: dict, iid: int) -> dict:
        inst = self.ledger.instrument(iid, scope)
        if not inst.get("symbol") or inst["asset_class"] not in d.TRADABLE:
            return {"available": False, "reason": "Only market-priced holdings with a ticker have an outlook."}

        def build():
            port, _ = self.portfolio(scope, settings)
            pos = next((p for p in port["positions"] if p["id"] == iid), None)
            seg = d.segment_of(inst)
            bench_key = "SP500" if seg == d.SEG_EQ_US else "GOLD" if seg == d.SEG_COMMODITY else "NIFTY50"
            bench = px.BENCHMARKS[bench_key]
            start = date.today() - timedelta(days=RISK_LOOKBACK_DAYS)
            hist = px.ensure_history(self.ledger.db, [inst["symbol"], bench["symbol"]], start)
            # G2/H14: the cone sits on the holding's own Book row (a debt fund at MF_DEBT's 7%) of this scope's Book
            key = A.book_key(pos or {**inst, "segment": seg})
            out = quant.holding_outlook(hist.get(inst["symbol"], []), hist.get(bench["symbol"]), seg,
                                        book_key=key, book=self.book(scope, settings)["book"])
            if not out:
                return {"available": False, "reason": "Not enough price history yet (needs about six weeks)."}
            out["available"] = True
            out["benchmark"] = bench["label"]
            out["currency"] = inst.get("currency") or "INR"
            if pos and pos.get("is_open") and pos.get("quantity"):
                fx = (self.usd_inr() or 0) if inst.get("currency") == "USD" else 1.0
                qty = float(pos["quantity"])
                out["holding"] = {"quantity": qty, "value": pos["value"],
                                  "cone": {k: {q: round(v[q] * qty * fx, 2) for q in ("p10", "p50", "p90")} for k, v in out["cone"].items()}}
            return out
        return self._memo("outlook", scope, iid, date.today(), self._hash(scope, settings), fn=build)

    def optimizer(self, scope: str | None, settings: dict, profile: str) -> dict:
        """The allocation lab (K14, R3, R4): `optimizer.suggest` with the ledger (trims costed by `tax.plan_sales` at
        the slab) and the base Book. Memoised on ('optimizer', scope, profile, slab, today, hash)."""
        today = date.today()
        slab = self._slab(settings)

        def build() -> dict:
            port, data = self.portfolio(scope, settings)
            return optimizer.suggest(port, profile, txns=data["transactions"], instruments=data["instruments"],
                                     slab_rate=slab, today=today, book=self.base_book(settings))
        return self._memo("optimizer", scope, profile, slab, today, self._hash(scope, settings), fn=build)

    def deploy(self, scope: str | None, settings: dict) -> dict:
        """Money free, or about to be, for redeploying (brief `deploy`, A6/A15): `deploy_state` over the portfolio
        and the next three months of cash-flow events. One definition for /brief, /actions and /rebalance?net=deploy.
        When the cash-flow forecast fails, P2P principal is left out (as build_brief does without events)."""
        def build():
            port, _ = self.portfolio(scope, settings)
            try:
                events = self.cashflow(scope, settings, 3)["events"]
            except Exception as e:  # noqa: BLE001 — the other sources still count
                print(f"[deploy] cash-flow events unavailable: {e}")
                events = None
            return brief_mod.deploy_state(port, events, date.today())
        return self._memo("deploy", scope, settings, date.today(), fn=build)

    def rebalance(self, scope: str | None, settings: dict, new_money: float, allow_sell: bool,
                  net: str | None = None) -> dict:
        """The segment-level plan toward targets. With net='deploy' (A15, E13) each deploy source's `held_value`
        is taken out of its segment first (in a copy, never below 0), so money that is about to be freed (an FD
        maturing within 30 days, the USD wallet, P2P principal coming back) is not counted twice: once inside its
        segment and again as the new money."""
        if net not in (None, "deploy"):
            raise ValueError("net must be 'deploy'")
        port, _ = self.portfolio(scope, settings)
        targets = settings.get("targetAllocation") or {}
        if not targets:
            return {"rows": [], "error": "Set a target allocation first", "months_to_fix": None}
        segments = port["segments"]
        netted: dict[str, float] = {}
        if net == "deploy":
            held: dict[str, float] = defaultdict(float)
            for s in self.deploy(scope, settings)["sources"]:
                if s.get("segment"):
                    held[s["segment"]] += float(s.get("held_value") or 0)
            segments = []
            for s in port["segments"]:
                cur = float(s.get("value") or 0)
                cut = min(held.get(s["segment"], 0.0), max(cur, 0.0))
                if cut > 0:
                    netted[s["segment"]] = round(cut, 2)
                segments.append({**s, "value": max(cur - cut, 0.0)})
        if allow_sell:
            # K13/R3: sells are costed together by tax.plan_sales; the no-sell plan stays exactly as before
            data = self.portfolio(scope, settings)[1]
            plan = goals_mod.rebalance_plan(segments, targets, new_money, allow_sell, port=port,
                                            txns=data["transactions"], instruments=data["instruments"],
                                            slab_rate=self._slab(settings), today=date.today())
        else:
            plan = goals_mod.rebalance_plan(segments, targets, new_money, allow_sell)
        if net == "deploy":
            plan = {**plan, "net": "deploy", "netted": netted}
        return {**plan, "months_to_fix": self._months_to_fix(scope, settings, plan)}

    def _months_to_fix(self, scope: str | None, settings: dict, plan: dict) -> int | None:
        """D2/H14: how many months of new money (SIPs plus a third of the next 90 days' inflow) close the gap without
        selling: ceil(money_to_fix_without_selling / max(1, monthly_sip_total + inflow_90d / 3)). 0 when nothing
        needs fixing; None when the plan has an error. An unknown inflow counts as 0."""
        if plan.get("error"):
            return None
        need = float(plan.get("money_to_fix_without_selling") or 0)
        if need <= 0:
            return 0
        try:
            inflow = float((self.upcoming(scope, settings) or {}).get("inflow_90d") or 0)
        except Exception as e:  # noqa: BLE001 — the SIP total alone still answers
            print(f"[rebalance] upcoming unavailable: {e!r}")
            inflow = 0.0
        monthly = self.monthly_sip_total(self.ledger.sips(scope)) + inflow / 3
        return math.ceil(need / max(1.0, monthly))

    def pulse(self, scope: str | None, settings: dict) -> dict:
        """Health score, money calendar and the narrative analysis for the overview."""
        return self._memo("pulse", scope, settings, date.today(), fn=lambda: self._pulse(scope, settings))

    def _pulse(self, scope: str | None, settings: dict) -> dict:
        res = self.insights(scope, settings)  # reads the shared context: no second portfolio build
        txns = self.context(scope, settings)["data"]["transactions"]
        return {"health": health_score(res["portfolio"], res["tax"], res["performance"]),
                "calendar": build_calendar(res["portfolio"], res["tax"], res["goals"]),
                "story": build_story(res["portfolio"], txns, res["performance"])}

    def _market_notices(self, scope: str | None) -> list[dict]:
        """Price alerts from the last two days and IPO dates in the next three."""
        db, today = self.ledger.db, date.today()
        w, p = ("owner = ?", [scope]) if scope else ("1=1", [])
        since = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        out = [{"id": f"mkt:{a['id']}", "kind": "market", "title": a["title"], "body": a["body"], "date": a["created_at"][:10],
                "days": 0, "link": a["link"], "severity": a["severity"]}
               for a in db.query(f"SELECT * FROM market_alerts WHERE {w} AND created_at >= ? ORDER BY created_at DESC LIMIT 10", [*p, since])]
        soon = (today + timedelta(days=3)).isoformat()
        for r in db.query(f"SELECT * FROM ipos WHERE {w}", p):
            for field, what in (("open_date", "opens"), ("close_date", "closes"), ("allotment_date", "allotment is"), ("listing_date", "lists")):
                when = r.get(field)
                if when and today.isoformat() <= when <= soon:
                    days = (date.fromisoformat(when) - today).days
                    out.append({"id": f"ipo:{r['id']}:{field}:{when}", "kind": "ipo", "title": f"{r['name']} IPO {what} "
                                + ("today" if days == 0 else "tomorrow" if days == 1 else f"in {days} days"),
                                "body": "Track it under Markets → Watchlist.", "date": when, "days": days,
                                "link": "/markets?tab=watchlist",
                                "severity": "warning" if field == "close_date" and days <= 1 and not r["applied"] else "info"})
        return out

    # ── actions and the Home brief (SPEC §7.2–§7.4, AMENDMENTS E3–E11) ──
    @staticmethod
    def _insight_settings(settings: dict) -> dict:
        """Settings for build_insights with no dismissed ids (E11): snoozes live in the action log only."""
        return {**settings, "dismissedInsights": {}}

    @staticmethod
    def _log_owners(owner: str, ctx: dict) -> list[str]:
        """A10/E3: the settings owner plus every distinct instrument (and segment-plan) owner in scope."""
        data = ctx["data"]
        extra = {i.get("owner") for i in data["instruments"]} | {s.get("owner") for s in ctx.get("sips") or []}
        return [owner, *sorted(o for o in extra if o and o != owner)]

    def _risk_est(self, scope: str | None, settings: dict) -> dict | None:
        """E8: RiskEst from the optimizer's view of the current mix, so the Risk vital, risk:above-profile and the
        Risk & mix page show one volatility. None for a portfolio with nothing to measure."""
        profile = settings.get("riskProfile") or None
        cur = self.optimizer(scope, settings, profile or "balanced").get("current")
        if not cur:
            return None
        prof = next((p for p in optimizer.PROFILES if p["key"] == profile), None)
        return {"vol_pct": cur.get("vol_pct"),
                "target_vol_pct": round(prof["target_vol"] * 100, 2) if prof else None,
                "profile": profile, "closest_profile": cur.get("closest_profile")}

    def _perf_ready(self, scope: str | None) -> bool:
        """Whether the ALL-range performance /brief peeks (A16) is warm right now."""
        return self._peek("performance", scope, "ALL", None) is not None

    def _peek_metrics(self, scope: str | None) -> dict | None:
        """The ALL-range history metrics when performance is already warm, else None (never builds history)."""
        return (self._peek("performance", scope, "ALL", None) or {}).get("metrics")

    def _open_ids(self, scope: str | None, ctx: dict) -> list[str] | None:
        """H13: ids of the open or planned concentration:/sector: rows, for build_insights' hysteresis.

        The inputs memo is not keyed on the request's owner, so the log is read for every owner such a row can
        have in this scope: the instrument owners (concentration:<iid>, A10), the scope itself and '__global__'
        (sector:<name> belongs to the settings owner, which is one of those two). None when the log can't be read."""
        owners = {i.get("owner") for i in ctx["data"]["instruments"]} | {scope, GLOBAL_OWNER}
        try:
            log = self.ledger.action_log(sorted(o for o in owners if o))
        except Exception as e:  # noqa: BLE001 — no hysteresis is better than no insights
            print(f"[actions] open ids unavailable: {e!r}")
            return None
        return sorted({aid for (_, aid), r in log.items()
                       if aid.startswith(OPEN_ID_PREFIXES) and r.get("status") in ("open", "planned")})

    # ── P1 sources that read the action log or the stored closes (AMENDMENTS H2–H4) ──
    @staticmethod
    def _skipped(log: dict) -> set[tuple[str, str]]:
        """A11/H2: (plan id, due ISO) of every instalment the user skipped: a dismissed row with reason 'skipped'
        whose id is sip:due:<sid>:<YYYY-MM-DD> or sip:missed:<sid>:<YYYY-MM-DD>."""
        out = set()
        for (_, aid), r in log.items():
            m = _SKIP_ID.match(aid)
            if m and r.get("status") == "dismissed" and (r.get("reason") or "").strip().lower() == "skipped":
                out.add((m.group(1), m.group(2)))
        return out

    def adherence(self, scope: str | None, settings: dict, owner: str | None = None, months: int = 6) -> dict:
        """plans.sip_adherence for the scope (AMENDMENTS H2), with `skipped` from the action log. Memoised on
        ('adherence', scope, owner, today, actions_rev, months): a status POST (a skip) rebuilds it, nothing else
        does. RETURNED OBJECTS ARE SHARED AND READ-ONLY."""
        owner = owner or self.owner()
        today = date.today()

        def build() -> dict:
            ctx = self.context(scope, settings)
            log = self.ledger.action_log(self._log_owners(owner, ctx))
            return plans.sip_adherence(ctx["sips"], ctx["data"]["transactions"], ctx["data"]["instruments"], today,
                                       months, skipped=self._skipped(log))
        return self._memo("adherence", scope, owner, today, self.ledger.actions_rev, months, fn=build)

    def _ipos(self, scope: str | None) -> list[dict]:
        """The scope's ipos rows (the _market_notices query without its date filter); calendar.upcoming dates them."""
        w, p = ("owner = ?", [scope]) if scope else ("1=1", [])
        return self.ledger.db.query(f"SELECT * FROM ipos WHERE {w}", p)

    def upcoming(self, scope: str | None, settings: dict, owner: str | None = None) -> dict:
        """Coming up over 90 days (AMENDMENTS H3): calendar.upcoming over build_calendar(horizon_days=90),
        cashflow(4) (so the rows cover the whole window), adherence's next_due (an instalment already paid or skipped
        is not money still to go out; EPF-excluded plans drop out) and the scope's IPO dates. Memoised on
        ('upcoming', scope, owner, settings, today, actions_rev). A failed cash flow leaves the totals None; a failed
        adherence falls back to plans.next_due."""
        owner = owner or self.owner()
        today = date.today()

        def build() -> dict:
            ctx = self.context(scope, settings)
            cal = build_calendar(ctx["port"], ctx["tax"], ctx["goals"], horizon_days=calendar_mod.UPCOMING_DAYS)
            try:
                cash = self.cashflow(scope, settings, 4)
            except Exception as e:  # noqa: BLE001 — dates without totals are still worth showing
                print(f"[upcoming] cash flow unavailable: {e!r}")
                cash = None
            try:
                due = self.adherence(scope, settings, owner)["next_due"]
            except Exception as e:  # noqa: BLE001
                print(f"[upcoming] adherence unavailable: {e!r}")
                due = plans.next_due(ctx["sips"], today, calendar_mod.UPCOMING_DAYS)
            return calendar_mod.upcoming(cal, cash, due, self._ipos(scope), today)
        return self._memo("upcoming", scope, owner, settings, today, self.ledger.actions_rev, fn=build)

    def market_state(self, scope: str | None, settings: dict) -> dict | None:
        """The Nifty's fall from its high and how yours compares (AMENDMENTS H4, D6, G12): markets.market_state over
        the ^NSEI closes already stored in price_history (a read: no network, no price_meta write), the ALL metrics
        only when performance is warm, and this scope's stress test. None with fewer than 200 stored closes.
        Memoised on ('market_state', scope, today, perf_ready)."""
        today = date.today()
        perf_ready = self._perf_ready(scope)

        def build() -> dict | None:
            pts = px.stored_history(self.ledger.db, NIFTY, today - timedelta(days=MARKET_STATE_DAYS))
            if len(pts) < mk.STATE_MIN_CLOSES:
                return None
            try:
                stress = self.stress(scope, settings)
            except Exception as e:  # noqa: BLE001 — the comparison falls back to a nominal correction
                print(f"[market_state] stress unavailable: {e!r}")
                stress = None
            return mk.market_state(pts, self._peek_metrics(scope), stress, today)
        return self._memo("market_state", scope, today, perf_ready, fn=build)

    def _action_inputs(self, scope: str | None, settings: dict) -> dict:
        """The sources /actions and /brief share (E8), computed once per (scope, settings, day, perf_ready) and
        independent of the action log, so a status POST (which bumps only actions_rev) re-runs only the overlay.

        perf_ready is in the key because plan.retirement blends in the user's own record once performance is warm
        (services.retirement with build_history=False): without it Home's retirement row, the Plan dot,
        retirement:gap and the snapshot's retirement probability would keep the cold estimate after /performance
        warms, while the Retirement tab shows the blended one.

        Each source sits in its own try/except: a failure leaves it None (its rules are skipped and its open
        actions are not closed) and adds a line to `notes`. Never builds market history: `market_state` reads only
        the stored ^NSEI closes (H4).

        H13: the insights are built here once, for /actions, the bell and /insights?performance=0, with the keyword
        sources (cushion, risk_est, stress, snapshot_then, book) and `open_ids`, the open or planned concentration:
        and sector: rows of the action log, read once per build (hysteresis; a status POST does not rebuild it).
        Adherence and upcoming are not held here, because they depend on the action log (H2, H3)."""
        def build() -> dict:
            ctx = self.context(scope, settings)
            port, today = ctx["port"], date.today()
            notes: list[str] = []
            out: dict = {"notes": notes, "book": self.book(scope, settings)["book"]}

            def attempt(key: str, fn):
                try:
                    return fn()
                except Exception as e:  # noqa: BLE001 — one broken source must not take the list down
                    print(f"[actions] {key} skipped: {e!r}")
                    notes.append(SOURCE_NOTE[key])
                    return None

            out["cushion"] = attempt("cushion", lambda: brief_mod.cushion_state(port, settings, today))
            out["cashflow_events"] = attempt("cashflow", lambda: self.cashflow(scope, settings, 3)["events"])
            out["deploy"] = attempt("deploy", lambda: self.deploy(scope, settings))
            out["risk_est"] = attempt("risk", lambda: self._risk_est(scope, settings))
            out["stress"] = attempt("stress", lambda: self.stress(scope, settings))
            rp = settings.get("retirementPlan")
            plan = {"goals": ctx["goals"], "retirement": None}
            if isinstance(rp, dict) and rp:
                # E8: only a saved plan; the age-30 query defaults must never raise retirement:gap
                plan["retirement"] = attempt("retirement", lambda: self.retirement(scope, settings, {}, build_history=False))
                if plan["retirement"] is None:
                    plan = None   # unknown, not "no plan": retirement rows stay as they are; goals come from insights
            out["plan"] = plan
            out["snapshot_then"] = attempt("snapshot", lambda: self.ledger.kpi_snapshot_at(
                self.snapshot_owner(scope), (today - timedelta(days=PLAN_SNAPSHOT_DAYS)).isoformat()))
            out["market_state"] = attempt("market_state", lambda: self.market_state(scope, settings))
            out["calendar"] = attempt("calendar", lambda: build_calendar(port, ctx["tax"], ctx["goals"]))
            out["open_ids"] = self._open_ids(scope, ctx)
            out["insights"] = attempt("insights", lambda: build_insights(
                port, ctx["tax"], ctx["goals"], self._insight_settings(settings), sips=ctx["sips"],
                txns=ctx["data"]["transactions"], **self._insight_kwargs(out)))
            return out
        return self._memo("action_inputs", scope, settings, date.today(), self._perf_ready(scope), fn=build)

    def actions(self, scope: str | None, settings: dict, owner: str | None = None) -> dict:
        """GET /actions (E4): {summary, actions, planned, done, snoozed, follow_through, notes}.
        Memoised on ('actions', scope, owner, settings, today, actions_rev, perf_ready, data_status). RETURNED
        OBJECTS ARE SHARED AND READ-ONLY; the route filters into new lists."""
        return self._actions_build(scope, settings, owner or self.owner())["payload"]

    def _actions_build(self, scope: str | None, settings: dict, owner: str) -> dict:
        # The Data vital ranks data:* actions 'now' while it is act (SPEC §1.7), on /actions exactly as on the
        # brief; its status depends on the clock, so it is part of the key.
        data_status = self._data_status(self.context(scope, settings)["port"])
        return self._memo("actions", scope, owner, settings, date.today(), self.ledger.actions_rev,
                          self._perf_ready(scope), data_status,
                          fn=lambda: self._build_actions(scope, settings, owner, data_status))

    def _build_actions(self, scope: str | None, settings: dict, owner: str, data_status: str | None = None) -> dict:
        today = date.today()
        ctx = self.context(scope, settings)
        inp = self._action_inputs(scope, settings)
        notes = list(inp["notes"])

        def attempt(key: str, fn):
            try:
                return fn()
            except Exception as e:  # noqa: BLE001 — one broken source must not take the list down
                print(f"[actions] {key} skipped: {e!r}")
                notes.append(SOURCE_NOTE[key])
                return None

        # H2/H3: the log-dependent sources, keyed on actions_rev like this build. With adherence present the plans
        # rule is the only sip:missed source (A9) and a skipped instalment is neither due nor missed (A11).
        adherence = attempt("adherence", lambda: self.adherence(scope, settings, owner))
        adherence_12m = attempt("adherence", lambda: self.adherence(scope, settings, owner, months=12)) \
            if adherence is not None else None
        upcoming = attempt("upcoming", lambda: self.upcoming(scope, settings, owner))
        src: dict = {"owner": owner, "port": ctx["port"], "txns": ctx["data"]["transactions"], "sips": ctx["sips"],
                     "settings": settings, "tax": ctx["tax"], "adherence": adherence}
        if upcoming is not None:
            src["upcoming"] = upcoming
        for k in ("insights", "calendar", "cashflow_events", "plan", "stress", "snapshot_then", "cushion", "deploy",
                  "risk_est", "market_state"):
            if inp.get(k) is not None:
                src[k] = inp[k]
        owners = self._log_owners(owner, ctx)
        log = self.ledger.action_log(owners)
        built = actions_mod.build_actions(src, log, today, include_closed=True,
                                          vitals=[{"key": "data", "status": data_status}])
        visible = [a for a in built if a["status"] in actions_mod.OPEN_STATUSES]
        closed = [a for a in built if a["status"] in ("done", "expired")]
        if self._persist_actions(visible, closed, log, today):
            log = self.ledger.action_log(owners)
        for a in visible:
            if a.get("first_seen") is None:
                a["first_seen"] = today.isoformat()   # E6: what was just inserted
        payload = {
            "summary": actions_mod.summary(visible),
            "actions": [a for a in visible if a["status"] == "open"],
            "planned": [a for a in visible if a["status"] == "planned"],
            "done": self._log_list(log, src, today, "done"),
            "snoozed": self._log_list(log, src, today, "snoozed"),
            "follow_through": actions_mod.follow_through(log, adherence_12m, today),   # §8.5 sip_adherence_12m
            "notes": notes,
        }
        return {"payload": payload, "visible": visible, "ctx": ctx, "inputs": inp, "adherence": adherence,
                "upcoming": upcoming}

    def _persist_actions(self, visible: list[dict], closed: list[dict], log: dict, today: date) -> bool:
        """E6: record first sightings and computed closures with upsert_action_seen (no bump). Rows already
        recorded with nothing to fill or change are skipped, so a rebuild with no news writes nothing.
        Returns whether anything was written."""
        by_owner: dict[str, list[dict]] = defaultdict(list)
        for a in visible:
            imp = a.get("impact") or {}
            rec = {"id": a["id"], "first_seen": a.get("first_seen") or today.isoformat(), "tier_first": a.get("tier"),
                   "category": a.get("category"), "title": a.get("title"), "impact": imp.get("amount"),
                   "impact_kind": imp.get("kind"), "due": a.get("due")}
            row = log.get((a["owner"], a["id"]))
            if row and all(row.get(k) is not None or rec.get(k) is None for k in rec if k not in ("id", "first_seen")):
                continue
            by_owner[a["owner"]].append(rec)
        for a in closed:
            row = log.get((a["owner"], a["id"]))
            if row and row.get("status") == a["status"]:
                continue
            by_owner[a["owner"]].append({"id": a["id"], "status": a["status"], "done_via": a.get("done_via"),
                                         "evidence": a.get("evidence"), "done_at": a.get("done_at")})
        for owner, rows in by_owner.items():
            if owner:
                self.ledger.upsert_action_seen(owner, rows)
        return bool(by_owner)

    @staticmethod
    def _log_list(log: dict, src: dict, today: date, which: str) -> list[dict]:
        """E4: 'done' = done in the last 90 days; 'snoozed' = live snoozes plus dismissed rows. Newest first, ≤ 50,
        in the Action shape (actions.action_from_row). Seen-notice rows (notice:*) are bookkeeping, not actions."""
        since = (today - timedelta(days=DONE_DAYS)).isoformat()
        rows = []
        for (owner, aid), r in log.items():
            if aid.startswith("notice:"):
                continue
            st = r.get("status")
            if which == "done":
                if st == "done" and (r.get("done_at") or "") >= since:
                    rows.append(((r.get("done_at") or "", r.get("updated_at") or ""), r))
            elif st == "dismissed" or (st == "snoozed" and (r.get("snooze_until") or "") >= today.isoformat()):
                rows.append(((r.get("updated_at") or "", ""), r))
        rows.sort(key=lambda x: x[0], reverse=True)
        return [actions_mod.action_from_row({**r, "owner": r.get("owner")}, src, today) for _, r in rows[:LIST_MAX]]

    @staticmethod
    def _data_status(port: dict) -> str | None:
        """The Data vital's status, known before build_brief so `for_home` can admit data actions while it is act."""
        try:
            return brief_mod._data_vital(brief_mod._freshness(port, datetime.now(timezone.utc)))["status"]
        except Exception:  # noqa: BLE001 — build_brief's own _safe reports it
            return None

    def brief(self, scope: str | None, settings: dict, since: str | None = None, owner: str | None = None) -> dict:
        """GET /brief: the Home answer ladder (A6 Brief plus the P1 fields of H11). Memoised on ('brief', scope,
        owner, settings, today, since, actions_rev, perf_ready, book hash) (E3, A16, H5): a brief built before
        /performance was warm is not served after it warms. Never builds market history: performance is only
        peeked and market_state reads stored closes.

        After the memo, the day's KPI snapshot is written once per (snapshot owner, date) in this process, inside
        try/except (E7), and never for an empty ledger. Its projection_1y is computed only then (H12)."""
        owner = owner or self.owner()
        today = date.today()
        perf = self._peek("performance", scope, "ALL", None)
        res = self._memo("brief", scope, owner, settings, today, since, self.ledger.actions_rev, perf is not None,
                         self._hash(scope, settings),
                         fn=lambda: self._build_brief(scope, settings, since, owner, perf, today))
        self._write_snapshot(res, today, scope, settings)
        return res["brief"]

    def _build_brief(self, scope: str | None, settings: dict, since: str | None, owner: str, perf: dict | None,
                     today: date) -> dict:
        built = self._actions_build(scope, settings, owner)
        ctx, inp, visible = built["ctx"], built["inputs"], built["visible"]
        port = ctx["port"]
        snap_owner = self.snapshot_owner(scope)
        try:
            since_snap = self.ledger.kpi_snapshot_at(snap_owner, since) if since else None
        except Exception as e:  # noqa: BLE001 — the hero simply has no since-last stat
            print(f"[brief] since snapshot unavailable: {e!r}")
            since_snap = None
        then_ids = set(((since_snap or {}).get("data") or {}).get("action_ids") or [])
        nifty_quote = self.ledger.system_value(NIFTY_KEY)
        total_value = float((port.get("totals") or {}).get("value") or 0)

        def compose(data_status: str | None) -> dict:
            # /actions ranked these with the Data vital it saw; re-rank with the brief's own status in case the
            # clock crossed a threshold in between, so Home and /actions agree on every data:* tier
            ranked = actions_mod.rank(visible, [{"key": "data", "status": data_status}])
            top = actions_mod.for_home(ranked, total_value, data_status)
            # E7: 'new' counts against the `since` snapshot, never against last month's
            top = [{**a, "is_new": since_snap is not None and a["id"] not in then_ids} for a in top]
            summary = actions_mod.summary(ranked)
            summary["new"] = sum(1 for a in ranked if since_snap is not None and a["id"] not in then_ids)
            # H2: a shallow copy carries adherence; the memoised context is never assigned into
            return brief_mod.build_brief({**ctx, "adherence": built.get("adherence")}, {"top": top, "summary": summary},
                                         built.get("upcoming"), inp.get("plan"), inp.get("risk_est"), inp.get("stress"),
                                         perf, since_snap, inp.get("market_state"), nifty_quote, settings, today,
                                         cushion=inp.get("cushion"), deploy=inp.get("deploy"))

        status = self._data_status(port)
        br = compose(status)
        got = next((v["status"] for v in br["vitals"] if v["key"] == "data"), None)
        if got is not None and got != status and "act" in (got, status):
            br = compose(got)   # the clock crossed a threshold between the two reads: admit with the brief's own status
        if scope is None and not br["empty"]:
            br["status"]["headline"] += " · family plan"   # SPEC §7.8, E8
        # H11: the assumptions chip and the cushion / risk_est pass-throughs (outside build_brief's A6 key set)
        br.update(brief_mod.p1_fields(port, settings, inp.get("cushion"), inp.get("risk_est"), br["empty"]))
        return {"brief": br, "snap_owner": snap_owner,
                "snapshot": None if br["empty"] else self._snapshot_data(ctx, inp, br, visible)}

    @staticmethod
    def _snapshot_data(ctx: dict, inp: dict, br: dict, visible: list[dict]) -> dict:
        """E7: what the next visit compares against. The retirement probability is stored twice on purpose:
        brief.py reads goal_probs['retirement'] and actions.py reads retirement_probability."""
        totals = ctx["port"].get("totals") or {}
        probs = {str(g["id"]): (g.get("projection") or {}).get("probability") for g in ctx["goals"]
                 if (g.get("projection") or {}).get("probability") is not None}
        ret = ((inp.get("plan") or {}).get("retirement") or {}).get("probability")
        if ret is not None:
            probs["retirement"] = ret
        return {"value": totals.get("value"), "invested": totals.get("cost"), "total_gain": totals.get("total_gain"),
                "xirr": totals.get("xirr"), "day_change": totals.get("day_change"), "goal_probs": probs,
                "retirement_probability": ret, "vitals": {v["key"]: v["status"] for v in br["vitals"]},
                "action_ids": [a["id"] for a in visible]}

    def _snapshot_extras(self, scope: str | None, settings: dict) -> dict:
        """H12: `book_hash` and `projection_1y` {p10, p50, p90} as growth factors (end.pX / totals.value, 4 dp) of a
        1-year, no-SIP, 1,000-simulation projection (seed 42) on the peeked ALL metrics. Only for a write that will
        happen, never inside the brief memo. projection_1y is left out when the value is ≤ 0 or the projection
        raises."""
        out: dict = {}
        try:
            out["book_hash"] = self._hash(scope, settings)
        except Exception as e:  # noqa: BLE001
            print(f"[brief] snapshot book hash unavailable: {e!r}")
        try:
            port, _ = self.portfolio(scope, settings)
            value = float((port.get("totals") or {}).get("value") or 0)
            if value > 0:
                proj = forecast.project_portfolio(port, self._peek_metrics(scope), years=1, monthly_sip=0.0,
                                                  step_up_pct=0.0, sims=SNAP_PROJECTION_SIMS,
                                                  book=self.base_book(settings))
                end = proj.get("end") or {}
                out["projection_1y"] = {q: round(float(end[q]) / value, 4) for q in ("p10", "p50", "p90")}
        except Exception as e:  # noqa: BLE001 — calibration data is optional
            print(f"[brief] snapshot projection unavailable: {e!r}")
        return out

    def _write_snapshot(self, res: dict, today: date, scope: str | None = None, settings: dict | None = None):
        data = res.get("snapshot")
        if data is None:
            return
        key = (res["snap_owner"], today.isoformat())
        with self._snap_lock:
            if key in self._snap_written:
                return
        try:
            if settings is not None:
                data = {**data, **self._snapshot_extras(scope, settings)}   # a copy: the memoised result stays as built
            self.ledger.kpi_snapshot_write(key[0], key[1], data)
            with self._snap_lock:
                self._snap_written.add(key)
        except Exception as e:  # noqa: BLE001 — bookkeeping must never fail the brief
            print(f"[brief] snapshot not written: {e!r}")

    # ── P1 read models: /plan, /assumptions, /tax/what-if, /sips, the cushion suggestion (AMENDMENTS H6–H10) ──
    def plan(self, scope: str | None, settings: dict) -> dict:
        """GET /plan (P1.1, AMENDMENTS H6). Memoised on ('plan', scope, settings, today, book hash, perf_ready) and
        NOT on actions_rev, so a status POST never rebuilds it. Never builds market history: the retirement row
        uses the ALL metrics only when already warm (build_history=False), the same memo /brief's plan uses, so the
        shell's Plan dot and /plan agree. RETURNED OBJECTS ARE SHARED AND READ-ONLY."""
        today = date.today()
        return self._memo("plan", scope, settings, today, self._hash(scope, settings), self._perf_ready(scope),
                          fn=lambda: self._build_plan(scope, settings, today))

    @staticmethod
    def _saved_retirement(settings: dict) -> bool:
        rp = settings.get("retirementPlan")
        return isinstance(rp, dict) and bool(rp)

    def _build_plan(self, scope: str | None, settings: dict, today: date) -> dict:
        ctx = self.context(scope, settings)
        port = ctx["port"]
        goals = ctx["goals"]
        notes: list[str] = []
        retirement = None
        if self._saved_retirement(settings):   # §7.8: no silent age-30 default anywhere on Plan
            try:
                retirement = self.retirement(scope, settings, {}, build_history=False)
            except Exception as e:  # noqa: BLE001 — /plan never returns 500 for one engine
                print(f"[plan] retirement skipped: {e!r}")
                notes.append(SOURCE_NOTE["retirement"])
        try:
            snap = self.ledger.kpi_snapshot_at(self.snapshot_owner(scope),
                                               (today - timedelta(days=PLAN_SNAPSHOT_DAYS)).isoformat())
        except Exception as e:  # noqa: BLE001 — no ▲/▼ this time
            print(f"[plan] snapshot unavailable: {e!r}")
            notes.append(SOURCE_NOTE["snapshot"])
            snap = None
        track = brief_mod.plan_track(ctx, {"goals": goals, "retirement": retirement}, snap)
        empty = not goals and retirement is None
        headline = brief_mod.plan_headline(track)
        if scope is None and not empty:
            headline += " · family plan"   # §7.8
        try:
            funding = self._funding(scope, settings)   # the same object the retirement row was funded from (K21)
        except Exception as e:  # noqa: BLE001
            print(f"[plan] funding skipped: {e!r}")
            notes.append(SOURCE_NOTE["funding"])
            funding = None
        try:
            cushion = brief_mod.cushion_state(port, settings, today)
        except Exception as e:  # noqa: BLE001
            print(f"[plan] cushion skipped: {e!r}")
            notes.append(SOURCE_NOTE["cushion"])
            cushion = None
        return {
            "status": {"status": "unset" if empty else track["status"], "headline": headline},
            "rows": track["rows"],
            "goals": goals,
            "retirement": retirement,
            "funding": funding,
            "cushion": cushion,
            "sip": self._plan_sip(ctx["sips"], goals, retirement),
            "counts": self._plan_counts(goals, retirement),
            "deltas": {("retirement" if r["kind"] == "retirement" else str(r["id"])): r["delta"]
                       for r in track["rows"] if r.get("delta") is not None},
            "assumptions": brief_mod.assumptions_block(port, settings),
            "empty": empty,
            "notes": notes,
        }

    # ── scenarios: compare and sensitivities (§6.10, AMENDMENTS R5–R7) ──
    def _scenario_inputs(self, scope: str | None, settings: dict) -> dict:
        """What every compare column reads (R6): the context's port and ledger, the plans, the saved targets, the
        slab, the base Book, the saved retirementPlan (unmerged, L5), /plan's funding, the unachieved goals, the
        projection's default inflation and the ALL metrics only when already warm (never builds history, as /plan)."""
        ctx = self.context(scope, settings)
        data = ctx["data"]
        book = self.base_book(settings)
        try:
            funding = self._funding(scope, settings)
        except Exception as e:  # noqa: BLE001 — retirement then uses the whole portfolio
            print(f"[compare] funding unavailable: {e!r}")
            funding = None
        goals = [g for g in ctx["goals"] if (g.get("projection") or {}).get("status") != "achieved"]
        return {"port": ctx["port"], "perf": self._peek_metrics(scope), "sips": ctx["sips"],
                "txns": data["transactions"], "instruments": data["instruments"],
                "targets": settings.get("targetAllocation") or None, "slab_rate": self._slab(settings), "book": book,
                "today": date.today(), "saved": self._saved_plan(settings), "funding": funding, "goals": goals,
                "inflation": self._inflation(settings, book)}

    def scenario_baseline(self, scope: str | None, settings: dict) -> dict:
        """"Today's plan" as a resolved PlanScenario (R5)."""
        return scen_mod.baseline(self._saved_plan(settings), self.monthly_sip_total(self.ledger.sips(scope)))

    def resolve_scenarios(self, scope: str | None, settings: dict, raw: list) -> list[dict]:
        """POST /plan/compare's `scenarios` → resolved PlanScenarios (R5, R6). An int is a 0-based index into the
        saved `planScenarios`; an object is an inline partial scenario (null or absent = the baseline's value).
        Raises ValueError (the route's 400) for a bad index, a wrong type or a field out of range; the message
        names the scenario (1-based) and the field."""
        saved_list = settings.get("planScenarios") if isinstance(settings.get("planScenarios"), list) else []
        base = self.scenario_baseline(scope, settings)
        out = []
        for n, item in enumerate(raw, start=1):
            if isinstance(item, int) and not isinstance(item, bool):
                if not 0 <= item < len(saved_list):
                    raise ValueError(f"Scenario {n}: no saved scenario at index {item}")
                item = saved_list[item]
            elif not isinstance(item, dict):
                raise ValueError(f"Scenario {n}: must be a saved scenario's index or a scenario object")
            try:
                sc = scen_mod.validate_scenario(item, partial=True)
            except scen_mod.ScenarioError as e:
                raise ValueError(f"Scenario {n}: {e}") from None
            out.append(scen_mod.resolve(sc, base, n))
        return out

    def _columns(self, scope: str | None, settings: dict, inp: dict, base: dict, scenarios: list[dict], years: int,
                 sims: int) -> list[dict]:
        """Each scenario's column as its three parts (`scenarios.run_projection`, `run_retirement`, `run_goals`), each
        memoised on the fields that part reads (`PROJECTION_FIELDS`, every field, `GOAL_FIELDS`), plus the
        baseline, sims, the date, the Book hash and perf_ready (and the horizon for the projection). So the baseline
        is shared by every compare and by the sensitivities of the same day, and a column that changes only
        `retire_age` or `inflation_pct` re-runs only its retirement (A5: the sims are never cut). Retirement runs
        first, so a column whose ages do not work fails before anything else is simulated."""
        common = (scen_mod.compute_key(base), sims, inp["today"], self._hash(scope, settings), inp["perf"] is not None)
        out = []
        for sc in scenarios:
            ret = self._memo("compare_ret", scope, settings, scen_mod.compute_key(sc), *common,
                             fn=lambda sc=sc: scen_mod.run_retirement(sc, base, inp, sims=sims))
            proj = self._memo("compare_proj", scope, settings, scen_mod.part_key(sc, scen_mod.PROJECTION_FIELDS),
                              years, *common,
                              fn=lambda sc=sc: scen_mod.run_projection(sc, base, inp, years=years, sims=sims))
            goals = self._memo("compare_goals", scope, settings, scen_mod.part_key(sc, scen_mod.GOAL_FIELDS), *common,
                               fn=lambda sc=sc: scen_mod.run_goals(sc, base, inp, sims=sims))
            out.append({"projection": proj, "retirement": ret, "goals": goals})
        return out

    def compare(self, scope: str | None, settings: dict, scenarios: list[dict], sims: int) -> dict:
        """POST /plan/compare (§6.10, AMENDMENTS R6): the baseline ("Today's plan") in column 0 and each resolved
        scenario after it, all on the baseline's seeds (CRN) over one shared horizon. Memoised on ('compare', scope,
        settings, resolved scenarios, sims, today, hash, perf_ready). Raises ValueError when a column's ages do not
        work (retire_age ≤ current_age)."""
        today = date.today()
        perf_ready = self._perf_ready(scope)

        def build() -> dict:
            inp = self._scenario_inputs(scope, settings)
            base = self.scenario_baseline(scope, settings)
            cols_sc = [base, *scenarios]
            years = scen_mod.horizon_years(cols_sc, saved=inp["saved"], goals=inp["goals"], today=today)
            cols = self._columns(scope, settings, inp, base, cols_sc, years, sims)
            return scen_mod.build_compare(cols_sc, cols, goals=inp["goals"], years=years, sims=sims, today=today,
                                          honesty=forecast._honesty(cols[0]["projection"]["sims"]))
        return self._memo("compare", scope, settings, scenarios, sims, today, self._hash(scope, settings), perf_ready,
                          fn=build)

    def plan_detail(self, scope: str | None, settings: dict) -> dict:
        """GET /plan?detail=1 (§6.10, AMENDMENTS R7): the /plan payload plus `baseline` and the four `sensitivities`
        (SIP up, retire 2 years later, returns 1 point lower, inflation 1 point higher), from one compare at 500 sims
        for every role. Memoised apart from /plan (which stays fast) on ('plan_detail', scope, settings, today,
        hash, perf_ready). A failure leaves `sensitivities` null and adds a note."""
        today = date.today()

        def build() -> dict:
            out = dict(self.plan(scope, settings))
            base = self.scenario_baseline(scope, settings)
            out["baseline"] = base
            try:
                out["sensitivities"] = self._sensitivities(scope, settings, base)
            except Exception as e:  # noqa: BLE001 — the plan still answers without them
                print(f"[plan] sensitivities skipped: {e!r}")
                out["sensitivities"] = None
                out["notes"] = [*out.get("notes", []), SOURCE_NOTE["sensitivities"]]
            return out
        return self._memo("plan_detail", scope, settings, today, self._hash(scope, settings), self._perf_ready(scope),
                          fn=build)

    def _sensitivities(self, scope: str | None, settings: dict, base: dict) -> list[dict]:
        inp = self._scenario_inputs(scope, settings)
        saved = inp["saved"]
        a = forecast.blended_assumptions(inp["port"]["segments"], inp["perf"], positions=inp["port"].get("positions"),
                                         book=inp["book"])
        requested = round(a["mu"] * 100, 2)   # the baseline projection's requested_return_pct (μ*)
        raw_infl = (saved or {}).get("inflation_pct")
        try:
            infl = float(raw_infl) if raw_infl not in (None, "") else forecast.book_inflation_pct(inp["book"])
        except (TypeError, ValueError):
            infl = forecast.book_inflation_pct(inp["book"])
        items = scen_mod.sensitivity_scenarios(base, saved=saved, requested_return_pct=requested, inflation_pct=infl)
        cols_sc = [base, *[it["scenario"] for it in items]]
        sims = scen_mod.SENSITIVITY_SIMS
        years = scen_mod.horizon_years(cols_sc, saved=saved, goals=inp["goals"], today=inp["today"])
        cols = self._columns(scope, settings, inp, base, cols_sc, years, sims)
        cmp = scen_mod.build_compare(cols_sc, cols, goals=inp["goals"], years=years, sims=sims, today=inp["today"],
                                     honesty=forecast._honesty(sims))
        return scen_mod.sensitivities(items, cmp, retirement_saved=saved is not None)

    def _plan_sip(self, sips: list[dict], goals: list[dict], retirement: dict | None) -> dict:
        """H6: what the plans invest a month against what the goals and retirement need. Achieved goals and a
        required_sip of None are skipped."""
        live = [g for g in goals if (g.get("projection") or {}).get("status") != "achieved"
                and (g.get("projection") or {}).get("required_sip") is not None]

        def funded(g: dict) -> float:
            # K15: a goal funded by linked plans is projected on their monthly total, so that is its contribution
            proj = g.get("projection") or {}
            if proj.get("contribution_source") == "linked":
                return float(proj.get("linked_monthly") or 0)
            return float(g.get("monthly_contribution") or 0)

        contribution = sum(funded(g) for g in live)
        needed = sum(float(g["projection"]["required_sip"]) for g in live)
        gap = sum(max(0.0, float(g["projection"]["required_sip"]) - funded(g)) for g in live)
        if retirement and retirement.get("required_sip") is not None:
            req = float(retirement["required_sip"])
            needed += req
            gap += max(0.0, req - float((retirement.get("inputs") or {}).get("monthly_sip") or 0))
        return {"plans_monthly_total": round(self.monthly_sip_total(sips), 2),
                "goals_monthly_contribution": round(contribution, 2), "needed_monthly": round(needed, 2),
                "gap_monthly": round(gap, 2)}

    @staticmethod
    def _plan_counts(goals: list[dict], retirement: dict | None) -> dict:
        """H6: engine statuses over the goals and the retirement plan; a missing status counts as unknown."""
        counts = dict.fromkeys(("on_track", "at_risk", "off_track", "achieved", "unknown"), 0)
        statuses = [(g.get("projection") or {}).get("status") for g in goals]
        if retirement is not None:
            statuses.append(retirement.get("status"))
        for s in statuses:
            counts[s if s in counts and s != "unknown" else "unknown"] += 1
        return {**counts, "total": len(statuses)}

    def assumptions_view(self, scope: str | None, settings: dict, mix: dict[str, float] | None = None) -> dict:
        """GET /assumptions (§6.1, AMENDMENTS H7, D2). Memoised on ('assumptions', scope, hash, mix).

        `mix` is {segment: pct} already validated by the route (segment names, 0–100, Σ 100 ± 0.5). Its Mutual
        Funds weight is split into MF_DEBT by the portfolio's current debt share of MF value (as optimizer._stats
        does, E16), and `proposed` is that mix's chip.

        `calibration` (K17, K21, R3) is `calibration.coverage(kpi_snapshots(snapshot owner), the ALL performance
        series, today)` only when the ALL performance is already warm (never built here), else null; so perf_ready
        and the date join the memo key. RETURNED OBJECTS ARE SHARED AND READ-ONLY."""
        bk = self.book(scope, settings)
        mix_key = sorted((mix or {}).items()) or None
        perf = self._peek("performance", scope, "ALL", None)
        today = date.today()

        def build() -> dict:
            out = self._build_assumptions(scope, settings, bk, mix)
            out["calibration"] = self._calibration(scope, perf, today)
            return out
        return self._memo("assumptions", scope, bk["hash"], mix_key, perf is not None, today, fn=build)

    def _calibration(self, scope: str | None, perf: dict | None, today: date) -> dict | None:
        """How the stored one-year bands held up (K17), or None when performance is cold or the read fails."""
        if perf is None:
            return None
        try:
            snaps = self.ledger.kpi_snapshots(self.snapshot_owner(scope))
            return calibration_mod.coverage(snaps, perf.get("series") or [], today)
        except Exception as e:  # noqa: BLE001 — the Book still shows without its track record
            print(f"[assumptions] calibration unavailable: {e!r}")
            return None

    def _build_assumptions(self, scope: str | None, settings: dict, bk: dict, mix: dict[str, float] | None) -> dict:
        port, _ = self.portfolio(scope, settings)
        positions = port.get("positions") or []
        book = bk["book"]
        weights = A.weights_from_positions(positions)
        values: dict[str, float] = defaultdict(float)
        for p in positions:
            v = float(p.get("value") or 0)
            if p.get("is_open", True) and v > 0:
                values[A.book_key(p)] += v
        rows = []
        for key in A.KEYS:
            r = (book.get("segments") or {}).get(key) or {}
            mu, sigma = float(r.get("return_pct") or 0) / 100, float(r.get("vol_pct") or 0) / 100
            row = {"key": key, "label": "Mutual Funds (debt)" if key == A.MF_DEBT else key,
                   "value": round(values.get(key, 0.0), 2), "weight_pct": round(weights.get(key, 0.0) * 100, 2),
                   "return_pct": round(mu * 100, 2), "typical_pct": round(A.typical(mu, sigma) * 100, 2),
                   "volatility_pct": round(sigma * 100, 2), "source": r.get("source") or "default"}
            if r.get("capped"):
                row["capped"] = True
            rows.append(row)
        # nothing valued yet: the bands are the diversified mutual fund forecast assumes, not 0% ± 0% (W4 review)
        mu, sigma = A.mu_sigma(weights or A.NO_HOLDINGS_MIX, book)
        keys = list(A.KEYS)
        out = {
            "segments": rows,
            "corr": {"keys": keys, "labels": ["Mutual Funds (debt)" if k == A.MF_DEBT else k for k in keys],
                     "matrix": [[round(A.CORR[a][b], 2) for b in keys] for a in keys], "note": A.CORR_NOTE},
            "portfolio": brief_mod.assumptions_block(port, settings),
            "inflation_pct": round(float(book.get("inflation_pct", A.INFLATION * 100)), 2),
            "risk_free_pct": round(A.RISK_FREE * 100, 2),
            "typical_bands": [{"years": y, **A.typical_band(mu, sigma, y)} for y in (1, 3, 5)],
            "hash": bk["hash"],
            "honesty": A.honesty_view(SNAP_PROJECTION_SIMS),
            "note": "Long-run assumptions, not predictions.",
        }
        if mix:
            seg_w = {k: float(v) / 100 for k, v in mix.items() if float(v) > 0}
            w = optimizer._split_mf(seg_w, optimizer._debt_share(positions))
            c = A.chip(book, w)
            out["proposed"] = {**c, "basis": "proposed mix", "chip": c["text"]}
        return out

    def what_if(self, scope: str | None, settings: dict, iid: int, qty: float, price: float | None = None,
                sell_date: str | None = None) -> dict:
        """GET /tax/what-if (§6.9, AMENDMENTS H8): tax.what_if_sale unchanged. Raises tax.WhatIfError (a
        ValueError), which the route turns into a 400. Memoised on ('whatif', scope, slab, iid, qty, price, date,
        today); an error is never memoised."""
        today = date.today()
        slab = self._slab(settings)

        def build() -> dict:
            ctx = self.context(scope, settings)
            data = ctx["data"]
            return tax_mod.what_if_sale(ctx["port"], data["transactions"], data["instruments"], iid, qty, price,
                                        sell_date, slab, today=today)
        return self._memo("whatif", scope, slab, iid, qty, price, sell_date, today, fn=build)

    def sips_view(self, scope: str | None, settings: dict, owner: str | None = None) -> dict:
        """GET /sips (AMENDMENTS H9): {plans, monthly_total, adherence (6 months, or None), arriving, arriving_total}.
        `arriving` is Services.deploy's sources (the money brief.deploy totals), so `arriving_total` equals
        brief.deploy.suggested and Recurring's "Extra to invest" can send net=deploy as Actions does (A15)."""
        rows = self.ledger.sips(scope)
        try:
            adh = self.adherence(scope, settings, owner)
        except Exception as e:  # noqa: BLE001 — the plans still list
            print(f"[sips] adherence unavailable: {e!r}")
            adh = None
        try:
            dep = self.deploy(scope, settings)
        except Exception as e:  # noqa: BLE001
            print(f"[sips] deploy unavailable: {e!r}")
            dep = {"suggested": 0.0, "sources": []}
        arriving = [{"kind": s.get("kind"), "label": s.get("label"), "date": s.get("date"), "amount": s.get("amount"),
                     "instrument_id": s.get("instrument_id"), "link": ARRIVING_LINK.get(s.get("kind"), "/actions")}
                    for s in dep.get("sources") or []]
        try:
            history = self._sip_history(self.adherence(scope, settings, owner, months=12), date.today())
        except Exception as e:  # noqa: BLE001 — Recurring falls back to the 6-month block
            print(f"[sips] history unavailable: {e!r}")
            history = None
        return {"plans": rows, "monthly_total": self.monthly_sip_total(rows), "adherence": adh,
                "arriving": arriving, "arriving_total": dep.get("suggested") or 0.0, "history": history}

    @staticmethod
    def _sip_history(adh12: dict, today: date, months: int = 12) -> list[dict]:
        """GET /sips `history` (R3): [{month 'YYYY-MM', planned, invested}] for the last `months` calendar months
        ending this month, oldest first: the sum over plans of `sip_adherence(months=12)`'s instalments due in
        that month. A skipped instalment adds nothing to `planned`, as in `planned_this_month`."""
        keys = []
        y, m = today.year, today.month
        for _ in range(months):
            keys.append(f"{y}-{m:02d}")
            y, m = (y, m - 1) if m > 1 else (y - 1, 12)
        keys.reverse()
        acc = {k: [0.0, 0.0] for k in keys}
        for p in adh12.get("plans") or []:
            for inst in p.get("months") or []:
                k = str(inst.get("due") or inst.get("month") or "")[:7]
                if k not in acc:
                    continue
                if inst.get("status") != "skipped":
                    acc[k][0] += float(inst.get("planned") or 0)
                acc[k][1] += float(inst.get("invested") or 0)
        return [{"month": k, "planned": round(v[0], 2), "invested": round(v[1], 2)} for k, v in acc.items()]

    def emergency_suggest(self, scope: str | None, settings: dict) -> dict:
        """GET /settings `emergencyFundSuggest` (§7.7, AMENDMENTS H10), read-only and for the request's scope:
        the cushion candidates (wallet, liquid then other debt funds, FDs within a year) and a monthly-expenses hint
        from the saved retirement plan."""
        port, _ = self.portfolio(scope, settings)
        c = brief_mod.cushion_state(port, settings, date.today())
        rp = settings.get("retirementPlan") if isinstance(settings.get("retirementPlan"), dict) else {}
        hint = rp.get("monthly_expenses")
        try:
            hint = float(hint) if hint not in (None, "") else None
        except (TypeError, ValueError):
            hint = None
        return {"candidates": c["candidates"], "candidates_amount": c["candidates_amount"],
                "monthly_expenses_hint": hint}

    # ── action status (E10, E11) ──
    def _owner_for_id(self, aid: str, ctx: dict) -> str | None:
        """E10 steps 2 and 3: the owner of the instrument an id ends in, or of the plan an sip:* id names."""
        insts = {i["id"]: i for i in ctx["data"]["instruments"]}
        iid = actions_mod._parse_iid(aid)
        if iid is not None:
            return (insts.get(iid) or {}).get("owner")
        parts = aid.split(":")
        if parts[0] == "sip" and len(parts) >= 3:
            plan = next((s for s in ctx.get("sips") or [] if str(s.get("id")) == parts[2]), None)
            if plan:
                return (insts.get(plan.get("instrument_id")) or {}).get("owner") or plan.get("owner")
        return None

    def set_action_status(self, scope: str | None, settings: dict, aid: str, status: str, fields: dict,
                          owner: str | None = None) -> dict:
        """POST /actions/<id>/status (E10). The route has validated `aid`, `status` and `fields`.

        Owner: the current action's, else the instrument's (an id ending in one), else the SIP plan's, else the
        settings owner. A known action first records its first sighting (so a manual done on a row never persisted
        still counts toward follow-through), then the status is upserted (bumps actions_rev only). Returns the
        action re-read after the bump, or, when it is now hidden, the pre-POST action merged with the new row."""
        owner = owner or self.owner()
        built = self._actions_build(scope, settings, owner)
        p = built["payload"]
        pre = next((a for lst in (p["actions"], p["planned"], p["done"], p["snoozed"]) for a in lst if a["id"] == aid), None)
        row_owner = (pre or {}).get("owner") or self._owner_for_id(aid, built["ctx"]) or owner
        if pre is not None:
            imp = pre.get("impact") or {}
            self.ledger.upsert_action_seen(row_owner, [{
                "id": aid, "first_seen": pre.get("first_seen") or date.today().isoformat(),
                "tier_first": pre.get("tier"), "category": pre.get("category"), "title": pre.get("title"),
                "impact": imp.get("amount"), "impact_kind": imp.get("kind"), "due": pre.get("due")}])
        row = self.ledger.set_action_status(row_owner, aid, status, **fields)
        after = self._actions_build(scope, settings, owner)["payload"]
        now = next((a for lst in (after["actions"], after["planned"]) for a in lst
                    if a["id"] == aid and a.get("owner") == row_owner), None)
        if now is not None:
            return now
        base = dict(pre) if pre is not None else actions_mod.action_from_row({**row, "owner": row_owner},
                                                                             None, date.today())
        base.update({k: row.get(k) for k in ("status", "snooze_until", "planned_for", "done_at", "done_via", "evidence",
                                             "reason", "note")})
        base["owner"] = row_owner
        return base

    def dismiss_insight(self, scope: str | None, settings: dict, insight_id: str, days: int,
                        owner: str | None = None) -> dict:
        """The /insights/<id>/dismiss alias (E11): a snooze of the insight's action (period-keyed id, A8)."""
        today = date.today()
        aid = actions_mod.action_id_for_insight(insight_id, today, self.context(scope, settings)["sips"])
        until = (today + timedelta(days=days)).isoformat()
        self.set_action_status(scope, settings, aid, "snoozed", {"snooze_until": until}, owner)
        return {"dismissed": insight_id, "until": until, "action_id": aid}

    def income(self, scope: str | None, months: int = 24) -> dict:
        """Passive income (dividends, P2P interest, FD interest) per month."""
        from collections import defaultdict
        data = self.ledger.load(scope)
        inst = {i["id"]: i for i in data["instruments"]}
        by_month: dict[str, dict] = defaultdict(lambda: {"dividends": 0.0, "p2p_interest": 0.0, "fd_interest": 0.0})
        for t in data["transactions"]:
            m = str(t["date"])[:7]
            amt = float(t["amount"] or 0)
            if t["type"] == d.DIVIDEND:
                by_month[m]["dividends"] += amt
            elif t["type"] == d.REPAYMENT:
                by_month[m]["p2p_interest"] += amt - float(t["principal"] or 0)
            elif t["type"] == d.INTEREST:
                by_month[m]["fd_interest"] += amt
            elif t["type"] == d.MATURITY:
                by_month[m]["fd_interest"] += amt - float(t["principal"] or 0)
        today = date.today()
        keys = []
        y, mo = today.year, today.month
        for _ in range(months):
            keys.append(f"{y}-{mo:02d}")
            mo -= 1
            if mo == 0:
                y, mo = y - 1, 12
        keys.reverse()
        rows = [{"month": k, **{kk: round(v, 2) for kk, v in by_month.get(k, {"dividends": 0.0, "p2p_interest": 0.0, "fd_interest": 0.0}).items()}} for k in keys]
        for r in rows:
            r["total"] = round(r["dividends"] + r["p2p_interest"] + r["fd_interest"], 2)
        last12 = rows[-12:]
        by_holding: dict[int, float] = defaultdict(float)
        for t in data["transactions"]:
            if t["type"] == d.DIVIDEND and str(t["date"])[:7] >= last12[0]["month"]:
                by_holding[t["instrument_id"]] += float(t["amount"] or 0)
        top = sorted(by_holding.items(), key=lambda kv: -kv[1])[:6]
        return {"months": rows, "last_12m": round(sum(r["total"] for r in last12), 2),
                "monthly_avg": round(sum(r["total"] for r in last12) / 12, 2),
                "top_payers": [{"instrument_id": i, "name": inst[i]["name"], "amount": round(a, 2)} for i, a in top if i in inst]}

    def instrument_history(self, scope: str | None, iid: int) -> dict:
        from datetime import timedelta
        inst = self.ledger.instrument(iid, scope)
        txns = [t for t in self.ledger.load(scope)["transactions"] if t["instrument_id"] == iid]
        if not inst.get("symbol") or not txns:
            return {"symbol": inst.get("symbol"), "currency": inst.get("currency"), "points": [], "trades": []}
        start = min(to_date(t["date"]) for t in txns) - timedelta(days=30)
        pts = px.ensure_history(self.ledger.db, [inst["symbol"]], start).get(inst["symbol"], [])
        trades = [{"date": t["date"], "type": t["type"], "quantity": t["quantity"], "amount": t["amount"],
                   "price": (float(t["amount_fc"] or t["amount"]) / float(t["quantity"])) if t["quantity"] else None}
                  for t in txns if t["type"] in (d.BUY, d.SELL)]
        return {"symbol": inst["symbol"], "currency": inst.get("currency"), "points": pts, "trades": trades}
