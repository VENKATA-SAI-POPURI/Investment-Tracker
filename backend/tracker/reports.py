"""Reports centre: every report returns the same shape — title, columns, rows, totals — so one
table renders them all and one exporter turns any of them into an Excel workbook."""
from __future__ import annotations

import io
from collections import defaultdict
from datetime import date, datetime, timedelta

from . import domain as d
from .analytics.portfolio import compute_portfolio, to_date
from .analytics.xirr import xirr

ASSET_LABEL = {d.EQUITY: "Stocks", d.MUTUAL_FUND: "Mutual funds", d.COMMODITY: "Gold & silver", d.P2P: "P2P lending",
               d.FIXED_DEPOSIT: "Fixed deposits", d.CASH: "USD wallet", d.EPF: "EPF", d.NPS: "NPS"}
SEGMENT_LABEL = {d.SEG_EQ_IN: "Indian stocks", d.SEG_EQ_US: "US stocks", d.SEG_MF: "Mutual funds",
                 d.SEG_COMMODITY: "Gold & silver", d.SEG_P2P: "P2P lending", d.SEG_FD: "Fixed deposits",
                 d.SEG_EPF: "EPF", d.SEG_NPS: "NPS"}
TAX_LABEL = {d.TAX_EQUITY: "Equity", d.TAX_FOREIGN: "Foreign equity", d.TAX_DEBT: "Debt", d.TAX_LISTED_OTHER: "Gold/other ETF",
             d.TAX_INCOME: "Interest", d.TAX_EXEMPT: "Exempt"}
TXN_LABEL = {d.BUY: "Buy", d.SELL: "Sell", d.DIVIDEND: "Dividend", d.INTEREST: "Interest", d.REPAYMENT: "Repayment",
             d.MATURITY: "Maturity", d.FX_IN: "USD deposit", d.FX_OUT: "USD withdrawal", d.CREDIT: "Interest credited",
             d.BONUS: "Bonus", d.SPLIT: "Split"}

# Filters each report understands: fy (financial year), period (from/to dates), asset, group, view
CATALOG = [
    {"key": "summary", "group": "Portfolio", "title": "Portfolio summary", "filters": ["group"],
     "description": "Invested, current value, gains and XIRR for each asset class or family member."},
    {"key": "holdings", "group": "Portfolio", "title": "Holdings", "filters": ["asset"],
     "description": "Every open holding with quantity, average cost, price, value and returns."},
    {"key": "performance", "group": "Performance", "title": "Performance review", "filters": ["view"],
     "description": "Returns over standard periods, or month-on-month, quarter-on-quarter and year-on-year."},
    {"key": "capital_gains", "group": "Tax", "title": "Capital gains", "filters": ["fy", "asset"],
     "description": "Realised gains lot by lot (FIFO) with short/long-term classification for the year."},
    {"key": "schedule_112a", "group": "Tax", "title": "Schedule 112A (ITR)", "filters": ["fy"],
     "description": "Long-term gains on listed equity in the column layout of ITR Schedule 112A."},
    {"key": "income", "group": "Tax", "title": "Income", "filters": ["fy"],
     "description": "Dividends, FD and P2P interest, and EPF interest credited during the year."},
    {"key": "transactions", "group": "Transactions", "title": "Transactions", "filters": ["period", "asset"],
     "description": "All transactions in a date range."},
]
CATALOG_BY_KEY = {c["key"]: c for c in CATALOG}


def col(key: str, label: str, typ: str = "text") -> dict:
    return {"key": key, "label": label, "type": typ}


def _r(v, n=2):
    return None if v is None else round(float(v), n)


class ReportContext:
    """Lazily loads (and caches) what a report needs for one scope."""

    def __init__(self, svc, scope: str | None, settings: dict, names: dict[str, str], params: dict):
        self.svc, self.scope, self.settings, self.names, self.params = svc, scope, settings, names, params
        self._port = self._data = self._perf = None
        self._tax: dict[str, dict] = {}

    @property
    def family(self) -> bool:
        return self.scope is None and len({i["owner"] for i in self.data["instruments"]}) > 1

    def load(self):
        if self._port is None:
            self._port, self._data = self.svc.portfolio(self.scope, self.settings)
        return self._port, self._data

    @property
    def port(self):
        return self.load()[0]

    @property
    def data(self):
        return self.load()[1]

    def tax(self, fy: str) -> dict:
        if fy not in self._tax:
            self._tax[fy] = self.svc.tax(self.scope, self.settings, fy)
        return self._tax[fy]

    @property
    def perf(self):
        if self._perf is None:
            self._perf = self.svc.performance(self.scope, "ALL")
        return self._perf

    def member(self, owner: str) -> str:
        return self.names.get(owner.lower(), owner.split("@")[0])

    # ── parameters ──
    def fy(self) -> str:
        return self.params.get("fy") or d.fy_of(date.today().isoformat())

    def period(self) -> tuple[str, str]:
        start, end = d.fy_bounds(d.fy_of(date.today().isoformat()))
        return self.params.get("from") or start, self.params.get("to") or min(end, date.today().isoformat())

    def asset(self) -> str | None:
        a = self.params.get("asset")
        return a if a in d.ASSET_CLASSES else None


def _member_col(ctx) -> list[dict]:
    return [col("member", "Member")] if ctx.family else []


# ── Portfolio ──
def r_summary(ctx: ReportContext) -> dict:
    port, data = ctx.load()
    group = ctx.params.get("group") or "asset"
    cols = [col("name", "Member" if group == "member" else "Asset class"), col("count", "Holdings", "num"),
            col("cost", "Invested", "inr"), col("value", "Current value", "inr"), col("day_change", "Today's gain", "inr"),
            col("unrealized", "Unrealised gain", "inr"), col("unrealized_pct", "Unrealised %", "pct"),
            col("realized", "Realised gain", "inr"), col("income", "Income", "inr"), col("total", "Total gain", "inr"),
            col("xirr", "XIRR", "pct"), col("share", "Allocation", "pct")]
    total_value = port["totals"]["value"] or 0
    rows = []
    if group == "member":
        by_owner = defaultdict(list)
        for i in data["instruments"]:
            by_owner[i["owner"]].append(i)
        for owner, insts in by_owner.items():
            ids = {i["id"] for i in insts}
            sub = compute_portfolio(insts, [t for t in data["transactions"] if t["instrument_id"] in ids],
                                    port.get("usd_inr"))
            t = sub["totals"]
            rows.append({"name": ctx.member(owner), "count": t["open_positions"], "cost": t["cost"], "value": t["value"],
                         "day_change": t["day_change"], "unrealized": t["unrealized"], "unrealized_pct": t["unrealized_pct"],
                         "realized": t["realized"], "income": t["income"], "total": t["total_gain"], "xirr": t["xirr"],
                         "share": _r(t["value"] / total_value * 100 if total_value else 0)})
    else:
        for s in port["segments"]:
            if not s["value"] and not s["total_return"]:
                continue
            rows.append({"name": SEGMENT_LABEL.get(s["segment"], s["segment"]), "count": s["open_count"], "cost": s["cost"],
                         "value": s["value"], "day_change": s["day_change"], "unrealized": s["unrealized"],
                         "unrealized_pct": s["unrealized_pct"], "realized": s["realized"], "income": s["income"],
                         "total": s["total_return"], "xirr": s["xirr"], "share": s["pct"]})
    rows.sort(key=lambda r: -(r["value"] or 0))
    t = port["totals"]
    totals = {"name": "Total", "count": t["open_positions"], "cost": t["cost"], "value": t["value"], "day_change": t["day_change"],
              "unrealized": t["unrealized"], "unrealized_pct": t["unrealized_pct"], "realized": t["realized"],
              "income": t["income"], "total": t["total_gain"], "xirr": t["xirr"], "share": 100.0}
    return {"columns": cols, "rows": rows, "totals": totals}


def r_holdings(ctx: ReportContext) -> dict:
    asset = ctx.asset()
    cols = [col("name", "Holding"), *_member_col(ctx), col("asset", "Asset class"), col("quantity", "Quantity", "qty"),
            col("avg_cost", "Avg cost", "inr"), col("price", "Price", "inr"), col("cost", "Invested", "inr"),
            col("value", "Current value", "inr"), col("unrealized", "Unrealised gain", "inr"),
            col("unrealized_pct", "Return %", "pct"), col("day_change", "Today", "inr"), col("xirr", "XIRR", "pct"),
            col("weight", "Weight", "pct"), col("first_date", "Since", "date")]
    rows = []
    for p in ctx.port["positions"]:
        if not p.get("is_open") or (asset and p["asset_class"] != asset):
            continue
        rows.append({"id": p["id"], "name": p["name"], "member": ctx.member(p["owner"]),
                     "asset": ASSET_LABEL.get(p["asset_class"], p["asset_class"]),
                     "quantity": p.get("quantity"), "avg_cost": p.get("avg_cost"), "price": p.get("price"), "cost": p["cost"],
                     "value": p["value"], "unrealized": p["unrealized"], "unrealized_pct": p.get("unrealized_pct"),
                     "day_change": p["day_change"], "xirr": p.get("xirr"), "weight": p["weight"], "first_date": p.get("first_date")})
    rows.sort(key=lambda r: -(r["value"] or 0))
    totals = {"name": f"{len(rows)} holdings", **_sum(rows, "cost", "value", "unrealized", "day_change", "weight")}
    totals["unrealized_pct"] = _r(totals["unrealized"] / totals["cost"] * 100) if totals["cost"] else None
    return {"columns": cols, "rows": rows, "totals": totals}


def _window(series: list[dict], start_iso: str) -> dict | None:
    pts = [p for p in series if p["date"] >= start_iso]
    before = [p for p in series if p["date"] < start_iso]
    if not pts:
        return None
    first = before[-1] if before else pts[0]
    last = pts[-1]
    added = last["net_invested"] - first["net_invested"]
    gain = last["value"] - first["value"] - added
    twr = last["index"] / first["index"] - 1 if first.get("index") else None
    flows = [(to_date(first["date"]), -first["value"])] if first["value"] > 0 else []
    prev = first
    for p in pts:
        if p is first:
            continue
        f = p["net_invested"] - prev["net_invested"]
        if abs(f) > 0.5:
            flows.append((to_date(p["date"]), -f))
        prev = p
    flows.append((to_date(last["date"]), last["value"]))
    nifty = None
    if first.get("NIFTY50") is not None and last.get("NIFTY50") is not None:
        nifty = last["NIFTY50"] - first["NIFTY50"] - added
    # Indian convention: returns under a year are shown absolute, longer ones annualised
    long_enough = (to_date(last["date"]) - to_date(first["date"])).days >= 365
    return {"from": first["date"], "start": first["value"], "added": _r(added), "end": last["value"], "gain": _r(gain),
            "twr": _r(twr * 100) if twr is not None else None,
            "xirr": _r((xirr(flows) or 0) * 100) if len(flows) > 1 and long_enough else None,
            "nifty_gain": _r(nifty)}


def r_performance(ctx: ReportContext) -> dict:
    series = ctx.perf.get("series") or []
    view = ctx.params.get("view") or "periods"
    if view == "periods":
        today = date.today()
        fy_start = d.fy_bounds(d.fy_of(today.isoformat()))[0]
        periods = [("1 month", today - timedelta(days=30)), ("3 months", today - timedelta(days=91)),
                   ("6 months", today - timedelta(days=182)), ("Calendar year to date", date(today.year, 1, 1)),
                   ("Financial year to date", to_date(fy_start)), ("1 year", today - timedelta(days=365)),
                   ("3 years", today - timedelta(days=1095)), ("Since start", date(1900, 1, 1))]
        cols = [col("period", "Period"), col("from", "From", "date"), col("start", "Start value", "inr"),
                col("added", "Net added", "inr"), col("end", "End value", "inr"), col("gain", "Gain", "inr"),
                col("twr", "Return (TWR)", "pct"), col("xirr", "XIRR", "pct"), col("nifty_gain", "Same money in Nifty 50: gain", "inr")]
        rows = []
        for label, start in periods:
            w = _window(series, start.isoformat())
            if w:
                rows.append({"period": label, **w})
        return {"columns": cols, "rows": rows, "totals": None,
                "note": "XIRR is shown for periods of a year or more and is estimated from the portfolio history; "
                        "shorter periods show the time-weighted return. The XIRR report is exact per holding."}
    # month-on-month / quarter-on-quarter / year-on-year: chain monthly time-weighted returns
    monthly = [m for m in ctx.perf.get("monthly") or [] if m.get("return") is not None]
    month_end = {}
    for p in series:
        month_end[p["date"][:7]] = p

    def bucket(m: str) -> str:
        y, mo = int(m[:4]), int(m[5:7])
        if view == "quarterly":
            fy_start = y if mo >= 4 else y - 1
            q = ((mo - 4) % 12) // 3 + 1
            return f"FY{fy_start}-{str(fy_start + 1)[2:]} Q{q}"
        if view == "yearly":
            return d.fy_of(f"{m}-01")
        return m

    groups: dict[str, dict] = {}
    for m in monthly:
        b = groups.setdefault(bucket(m["month"]), {"ret": 1.0, "months": []})
        b["ret"] *= 1 + m["return"] / 100
        b["months"].append(m["month"])
    cols = [col("label", {"monthly": "Month", "quarterly": "Quarter", "yearly": "Financial year"}[view]),
            col("ret", "Return (TWR)", "pct"), col("value", "Value at end", "inr"), col("gain", "Gain in period", "inr")]
    rows, prev_end = [], None
    for label, b in groups.items():
        end = month_end.get(b["months"][-1])
        start_key = b["months"][0]
        prior = [k for k in month_end if k < start_key]
        start = month_end[prior[-1]] if prior else None
        gain = (end["value"] - start["value"] - (end["net_invested"] - start["net_invested"])) if end and start else None
        rows.append({"label": label, "ret": _r((b["ret"] - 1) * 100), "value": end["value"] if end else None, "gain": _r(gain)})
    rows.reverse()
    return {"columns": cols, "rows": rows, "totals": None}


def r_capital_gains(ctx: ReportContext) -> dict:
    fy, asset = ctx.fy(), ctx.asset()
    tax = ctx.tax(fy)
    cols = [col("name", "Holding"), col("tax_class", "Tax treatment"), col("buy_date", "Bought", "date"),
            col("sell_date", "Sold", "date"), col("holding_days", "Days held", "num"), col("qty", "Quantity", "qty"),
            col("cost", "Cost", "inr"), col("proceeds", "Sale value", "inr"), col("gain", "Gain", "inr"),
            col("term", "Term"), col("rate", "Tax rate", "pct")]
    rows = []
    for l in tax["realized"]:
        if asset and l["asset_class"] != asset:
            continue
        rows.append({"id": l["instrument_id"], "name": l["name"], "tax_class": TAX_LABEL.get(l["tax_class"], l["tax_class"]),
                     "buy_date": l["buy_date"], "sell_date": l["sell_date"], "holding_days": l["holding_days"], "qty": l["qty"],
                     "cost": l["cost"], "proceeds": l["proceeds"], "gain": l["gain"], "term": l["term"],
                     "rate": _r(l["rate"] * 100) if l.get("rate") is not None and l["rate"] <= 1 else l.get("rate")})
    st = sum(r["gain"] for r in rows if r["term"] == "STCG")
    lt = sum(r["gain"] for r in rows if r["term"] == "LTCG")
    return {"columns": cols, "rows": rows, "totals": {"name": "Total", **_sum(rows, "cost", "proceeds", "gain")},
            "note": f"Short-term {_inr(st)} · Long-term {_inr(lt)} · {fy}. Lots are matched first-in, first-out."}


def r_schedule_112a(ctx: ReportContext) -> dict:
    fy = ctx.fy()
    tax = ctx.tax(fy)
    cols = [col("acquired", "Share/unit acquired"), col("name", "Name of the share/unit"), col("qty", "No. of shares/units", "qty"),
            col("sale_price", "Sale price per unit", "inr"), col("full_value", "Full value of consideration", "inr"),
            col("cost", "Cost of acquisition without indexation", "inr"), col("coa", "Cost of acquisition", "inr"),
            col("fmv", "FMV on 31-01-2018", "inr"), col("expenditure", "Expenditure on transfer", "inr"),
            col("deductions", "Total deductions", "inr"), col("balance", "Balance", "inr")]
    rows = []
    for l in tax["realized"]:
        if l["tax_class"] != d.TAX_EQUITY or l["term"] != "LTCG":
            continue
        before = l["buy_date"] <= "2018-01-31"
        rows.append({"id": l["instrument_id"], "acquired": "BE" if before else "AE", "name": l["name"], "qty": l["qty"],
                     "sale_price": _r(l["proceeds"] / l["qty"]) if l["qty"] else None, "full_value": l["proceeds"],
                     "cost": l["cost"], "coa": l["cost"], "fmv": None, "expenditure": 0.0, "deductions": l["cost"],
                     "balance": l["gain"]})
    note = ("AE = acquired after 31 January 2018. For shares bought on or before that date (BE), fill in the 31-Jan-2018 "
            "fair market value and use the higher of cost and the lower of FMV and sale value. ISINs are not stored; "
            "add them from your contract notes when filing.")
    return {"columns": cols, "rows": rows, "totals": {"acquired": "Total", **_sum(rows, "full_value", "cost", "coa", "deductions", "balance")},
            "note": note}


def r_income(ctx: ReportContext) -> dict:
    start, end = d.fy_bounds(ctx.fy())
    inst = {i["id"]: i for i in ctx.data["instruments"]}
    cols = [col("date", "Date", "date"), col("name", "Holding"), *_member_col(ctx), col("kind", "Income type"),
            col("amount", "Amount", "inr"), col("taxable", "Taxable")]
    rows = []
    for t in ctx.data["transactions"]:
        day = str(t["date"])[:10]
        if not (start <= day <= end) or t["instrument_id"] not in inst:
            continue
        i, amt = inst[t["instrument_id"]], float(t["amount"] or 0)
        kind, value = None, 0.0
        if t["type"] == d.DIVIDEND:
            kind, value = "Dividend", amt
        elif t["type"] == d.INTEREST:
            kind, value = "FD interest", amt
        elif t["type"] == d.MATURITY:
            kind, value = "FD interest at maturity", amt - float(t["principal"] or 0)
        elif t["type"] == d.REPAYMENT:
            kind, value = "P2P interest", amt - float(t["principal"] if t["principal"] is not None else amt)
        elif t["type"] == d.CREDIT:
            kind, value = "EPF interest credited", amt
        if kind and value > 0.005:
            rows.append({"id": i["id"], "date": day, "name": i["name"], "member": ctx.member(i["owner"]), "kind": kind,
                         "amount": _r(value), "taxable": "No" if (i.get("tax_class") == d.TAX_EXEMPT) else "Yes"})
    rows.sort(key=lambda r: r["date"], reverse=True)
    by_kind = defaultdict(float)
    for r in rows:
        by_kind[r["kind"]] += r["amount"]
    return {"columns": cols, "rows": rows, "totals": {"date": "Total", **_sum(rows, "amount")},
            "note": " · ".join(f"{k} {_inr(v)}" for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1])) or None}


# ── Transactions ──
def r_transactions(ctx: ReportContext) -> dict:
    start, end = ctx.period()
    asset = ctx.asset()
    inst = {i["id"]: i for i in ctx.data["instruments"]}
    cols = [col("date", "Date", "date"), col("name", "Holding"), *_member_col(ctx), col("asset", "Asset class"),
            col("type", "Type"), col("quantity", "Quantity", "qty"), col("price", "Price", "inr"), col("amount", "Amount", "inr"),
            col("notes", "Notes")]
    rows = []
    for t in ctx.data["transactions"]:
        day = str(t["date"])[:10]
        i = inst.get(t["instrument_id"])
        if not i or not (start <= day <= end) or (asset and i["asset_class"] != asset):
            continue
        q = float(t["quantity"] or 0)
        rows.append({"id": i["id"], "date": day, "name": i["name"], "member": ctx.member(i["owner"]),
                     "asset": ASSET_LABEL.get(i["asset_class"], i["asset_class"]), "type": TXN_LABEL.get(t["type"], t["type"]),
                     "quantity": t["quantity"], "price": _r(float(t["amount"] or 0) / q) if q and t["type"] in (d.BUY, d.SELL) else None,
                     "amount": t["amount"], "notes": t.get("notes")})
    rows.sort(key=lambda r: r["date"], reverse=True)
    out = sum(float(r["amount"] or 0) for r in rows if r["type"] == "Buy")
    back = sum(float(r["amount"] or 0) for r in rows if r["type"] == "Sell")
    return {"columns": cols, "rows": rows, "totals": None,
            "note": f"{len(rows)} transactions · bought {_inr(out)} · sold {_inr(back)}"}


BUILDERS = {"summary": r_summary, "holdings": r_holdings, "performance": r_performance, "capital_gains": r_capital_gains,
            "schedule_112a": r_schedule_112a, "income": r_income, "transactions": r_transactions}


def _sum(rows: list[dict], *keys) -> dict:
    return {k: _r(sum(float(r.get(k) or 0) for r in rows)) for k in keys}


def _inr(v: float) -> str:
    from .analytics.insights import _inr as fmt
    return fmt(v)


def build_report(key: str, ctx: ReportContext) -> dict:
    meta = CATALOG_BY_KEY[key]
    out = BUILDERS[key](ctx)
    sub = []
    if "fy" in meta["filters"]:
        sub.append(ctx.fy())
    if "period" in meta["filters"]:
        s, e = ctx.period()
        sub.append(f"{s} to {e}")
    if ctx.asset() and "asset" in meta["filters"]:
        sub.append(ASSET_LABEL[ctx.asset()])
    return {**meta, **out, "subtitle": " · ".join(sub) or None, "generated_at": datetime.now().isoformat(timespec="seconds")}


# ── Excel export ──
def to_xlsx(report: dict, portfolio_label: str) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = report["title"][:31]
    cols = report["columns"]
    ws.append([report["title"]])
    ws["A1"].font = Font(size=14, bold=True)
    ws.append([" · ".join(x for x in (portfolio_label, report.get("subtitle"), f"Generated {report['generated_at'][:16].replace('T', ' ')}") if x)])
    ws["A2"].font = Font(color="667085")
    ws.append([])
    ws.append([c["label"] for c in cols])
    head = ws.max_row
    for i in range(1, len(cols) + 1):
        cell = ws.cell(row=head, column=i)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="15204A")
        cell.alignment = Alignment(horizontal="right" if cols[i - 1]["type"] not in ("text", "date") else "left", wrap_text=True)
    fmt = {"inr": '"₹"#,##0.00;[Red]-"₹"#,##0.00', "pct": '0.00"%";[Red]-0.00"%"', "qty": "#,##0.####", "num": "#,##0",
           "date": "dd-mmm-yyyy"}

    def put(values: dict, bold=False):
        ws.append([_cell(values.get(c["key"]), c["type"]) for c in cols])
        r = ws.max_row
        for i, c in enumerate(cols, 1):
            cell = ws.cell(row=r, column=i)
            if c["type"] in fmt:
                cell.number_format = fmt[c["type"]]
            if bold:
                cell.font = Font(bold=True)

    for row in report["rows"]:
        put(row)
    if report.get("totals"):
        put(report["totals"], bold=True)
    if report.get("note"):
        ws.append([])
        ws.append([report["note"]])
    for i, c in enumerate(cols, 1):
        width = max([len(c["label"])] + [len(str(r.get(c["key"]) or "")) for r in report["rows"][:200]]) + 2
        ws.column_dimensions[get_column_letter(i)].width = min(max(width, 10), 48)
    ws.freeze_panes = ws.cell(row=head + 1, column=1)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _cell(v, typ):
    if v is None or v == "":
        return None
    if typ == "date":
        try:
            return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()
        except ValueError:
            return v
    return v
