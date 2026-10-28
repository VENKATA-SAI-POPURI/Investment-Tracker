"""Use-cases composed from the ledger, market data and analytics."""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

from . import domain as d
from . import prices as px
from .analytics import goals as goals_mod
from .analytics.calendar import build_calendar
from .analytics.health import health_score
from .analytics.history import build_history
from .analytics.insights import build_insights
from .analytics.portfolio import compute_portfolio, to_date
from .analytics.tax import compute_tax
from .ledger import Ledger

PRICE_TTL_MIN = 15
DEFAULT_SLAB = 0.30


class Services:
    def __init__(self, ledger: Ledger):
        self.ledger = ledger

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
        quotes = px.fetch_quotes(symbols + [px.USDINR])
        fx = quotes.pop(px.USDINR, None)
        self.ledger.store_quotes(quotes)
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if fx:
            self.ledger.set_system_value("fx:USDINR", json.dumps({"price": fx["price"], "at": stamp}))
        self.ledger.set_system_value("prices:last_refresh", stamp)
        failed = [s for s, q in quotes.items() if not q]
        return {"refreshed": True, "last_refresh": stamp, "updated": len(symbols) - len(failed), "failed": failed,
                "usd_inr": fx["price"] if fx else None}

    # ── analytics ──
    def settings(self) -> dict:
        from flask import g
        return self.ledger.get_settings(g.email, g.role)

    def portfolio(self, scope: str | None, settings: dict) -> tuple[dict, dict]:
        data = self.ledger.load(scope)
        targets = settings.get("targetAllocation") or {}
        port = compute_portfolio(data["instruments"], data["transactions"], self.usd_inr(), targets)
        port["contributions"] = self._contributions(data["cash_movements"])
        port["prices"] = self.prices_status()
        return port, data

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

    def performance(self, scope: str | None, rng: str = "ALL", segment: str | None = None) -> dict:
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

    def tax(self, scope: str | None, settings: dict, fy: str | None = None) -> dict:
        port, data = self.portfolio(scope, settings)
        fy = fy or d.fy_of(date.today().isoformat())
        slab = float(settings.get("taxSlabRate") or DEFAULT_SLAB * 100) / 100
        result = compute_tax(port, data["transactions"], data["instruments"], fy, slab)
        years = {d.fy_of(r["sell_date"]) for r in port["realized_lots"]}
        years |= {d.fy_of(str(t["date"])) for t in data["transactions"]
                  if t["type"] in (d.DIVIDEND, d.REPAYMENT, d.INTEREST, d.MATURITY)}
        years.add(d.fy_of(date.today().isoformat()))
        result["years"] = sorted(years, reverse=True)
        return result

    def goals(self, scope: str | None, settings: dict, port: dict | None = None) -> list[dict]:
        port = port or self.portfolio(scope, settings)[0]
        out = []
        for g in self.ledger.goals(scope):
            g = dict(g)
            g["allocation"] = goals_mod.parse_allocation(g.get("allocation"))
            g["projection"] = goals_mod.project_goal(g, port["segments"])
            out.append(g)
        return out

    def insights(self, scope: str | None, settings: dict, with_performance: bool = True) -> dict:
        port, data = self.portfolio(scope, settings)
        fy = d.fy_of(date.today().isoformat())
        slab = float(settings.get("taxSlabRate") or DEFAULT_SLAB * 100) / 100
        tax = compute_tax(port, data["transactions"], data["instruments"], fy, slab)
        goals = self.goals(scope, settings, port)
        perf = None
        if with_performance:
            try:
                perf = self.performance(scope, "ALL")
            except Exception as e:  # noqa: BLE001 — market data outage must not hide other insights
                print(f"[insights] performance unavailable: {e}")
        items = build_insights(port, tax, goals, settings, (perf or {}).get("metrics"), (perf or {}).get("benchmarks"))
        return {"insights": items, "portfolio": port, "tax": tax, "goals": goals, "performance": perf}

    def rebalance(self, scope: str | None, settings: dict, new_money: float, allow_sell: bool) -> dict:
        port, _ = self.portfolio(scope, settings)
        targets = settings.get("targetAllocation") or {}
        if not targets:
            return {"rows": [], "error": "Set a target allocation first"}
        return goals_mod.rebalance_plan(port["segments"], targets, new_money, allow_sell)

    def pulse(self, scope: str | None, settings: dict) -> dict:
        """Health score + money calendar for the overview."""
        res = self.insights(scope, settings)
        return {"health": health_score(res["portfolio"], res["tax"], res["performance"]),
                "calendar": build_calendar(res["portfolio"], res["tax"], res["goals"])}

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
