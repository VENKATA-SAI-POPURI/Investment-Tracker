"""How one entry flows through the app (Activity › Entry flow) and the data checks (Activity › Checks).

Every step is computed by the same functions the app uses for its numbers (run_fifo, external_flows, tax.rule_for,
the ledger's own cash rules), so the trace shows what the code really does; a step that looks wrong points at the
code named in its `code` field.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date

from .. import domain as d
from .portfolio import EPS, _ORDER, _f, external_flows, run_fifo, to_date, wallet_owners
from .tax import rule_for

TYPE_LABEL = {d.BUY: "Buy", d.SELL: "Sell", d.DIVIDEND: "Dividend", d.INTEREST: "Interest paid out", d.REPAYMENT: "Repayment",
              d.MATURITY: "Maturity", d.FX_IN: "Transfer to US account", d.FX_OUT: "Transfer from US account",
              d.CREDIT: "Interest credited", d.BONUS: "Bonus shares", d.SPLIT: "Split"}


def _inr(v: float) -> str:
    s = f"{abs(v):,.0f}" if abs(v) >= 100 else f"{abs(v):,.2f}"
    # Indian grouping: 1,23,45,678
    if abs(v) >= 1e5:
        whole, _, frac = f"{abs(v):.0f}".partition(".")
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts + [tail])
    return ("−" if v < 0 else "") + "₹" + s


def _q(v: float) -> str:
    return f"{v:,.4f}".rstrip("0").rstrip(".") if v % 1 else f"{v:,.0f}"


def _key(t: dict) -> tuple:
    return (str(t["date"])[:10], _ORDER.get(t["type"], 2), t.get("id") or 0)


def _step(key, title, text, *, tone="brand", icon="layers", formula=None, code=None, items=None) -> dict:
    return {"key": key, "title": title, "text": text, "tone": tone, "icon": icon, "formula": formula, "code": code,
            "items": items or []}


def trace_txn(t: dict, inst: dict, inst_txns: list[dict], port: dict, linked_cash: list[dict], rule: dict | None,
              auto_enabled: bool, today: date) -> dict:
    """The steps one transaction goes through. `inst_txns` are all of the instrument's transactions."""
    ac, typ = inst["asset_class"], t["type"]
    amt = _f(t["amount"])
    qty = _f(t.get("quantity"))
    unit = "shares" if ac == d.EQUITY else "units"
    pos = next((p for p in port["positions"] if p["id"] == inst["id"]), None)
    ordered = sorted(inst_txns, key=_key)
    before = [x for x in ordered if _key(x) < _key(t)]
    upto = [x for x in ordered if _key(x) <= _key(t)]
    steps: list[dict] = []
    unitised = ac in d.UNITISED

    # 1 · saved and checked
    if unitised and typ == d.SELL:
        lots_b, _, _ = run_fifo(inst["id"], before)
        held = sum(l.qty for l in lots_b)
        ok = held + EPS >= qty
        steps.append(_step("saved", "Checked & saved",
                           f"You held {_q(held)} {unit}, so selling {_q(qty)} is allowed" if ok else
                           f"You held only {_q(held)} {unit}: {_q(qty - held)} have no buy behind them",
                           tone="brand" if ok else "warn", icon="shieldCheck", code="ledger.py · Ledger._validate_txn"))
    elif unitised and typ == d.BUY and qty:
        steps.append(_step("saved", "Checked & saved", f"A new lot of {_q(qty)} {unit} at {_inr(amt / qty)} each",
                           icon="shieldCheck", code="ledger.py · Ledger.add_transaction"))
    else:
        steps.append(_step("saved", "Checked & saved", f"{TYPE_LABEL.get(typ, typ)} of {_inr(amt)} on {t['date']}"
                           + (f" · from {t.get('source')}" if t.get("source") and t.get("source") != "manual" else ""),
                           icon="shieldCheck", code="ledger.py · Ledger.add_transaction"))

    # 2 · cash entries (what the app records as money put in or taken out)
    code = f"ledger.py · Ledger._auto_cash ({rule['id']})" if rule else "ledger.py · Ledger._auto_cash"
    if linked_cash:
        items = [f"{c['account'].replace('_', ' ')} · {'in' if c['direction'] == 'in' else 'out'} {_inr(_f(c['amount']))}"
                 f"{' · ' + c['category'] if c.get('category') else ''}" for c in linked_cash]
        steps.append(_step("cash", "Cash entries", f"{len(linked_cash)} made with this entry", icon="wallet2",
                           code=code, items=items))
    else:
        expected = (rule or {}).get("import_entries") if (t.get("source") or "").startswith("import") else (rule or {}).get("entries")
        if expected and not auto_enabled:
            steps.append(_step("cash", "Cash entries", "None: automatic cash entries are switched off in Settings",
                               tone="warn", icon="wallet2", code=code))
        elif expected:
            steps.append(_step("cash", "Cash entries", "None linked, though this rule makes one. The entry may predate "
                               "the rule, or the cash entry was deleted.", tone="warn", icon="wallet2", code=code))
        else:
            steps.append(_step("cash", "Cash entries", "None: " + ((rule or {}).get("note") or "this kind of entry creates none"),
                               tone="warn" if (rule or {}).get("note") else "info", icon="wallet2", code=code))

    # 3 · lots, gain and the holding after (unitised holdings)
    if unitised:
        lots_all, realized_all, _ = run_fifo(inst["id"], ordered)
        if typ == d.BUY and qty:
            lot = next((l for l in lots_all if l.txn_id == t.get("id")), None)
            left = lot.qty if lot else 0.0
            steps.append(_step("lots", "Lot recorded", f"{_q(left)} of {_q(qty)} still open" + (f", {_q(qty - left)} sold since" if qty - left > EPS else ""),
                               formula=f"{_inr(amt)} ÷ {_q(qty)} = {_inr(amt / qty)} each", icon="layers",
                               code="analytics/portfolio.py · run_fifo"))
        elif typ == d.SELL:
            mine = [r for r in realized_all if r.sell_txn_id == t.get("id")]
            cost = sum(r.cost for r in mine)
            items = [f"{_q(r.qty)} from the lot of {r.buy_date} at {_inr(r.cost / r.qty) if r.qty else '—'} = {_inr(r.cost)}"
                     + (" (no buy found)" if r.cost == 0 and r.buy_date == r.sell_date else "") for r in mine]
            steps.append(_step("lots", "Matched to the oldest lots (FIFO)", f"{len(mine)} lot{'s' if len(mine) != 1 else ''} used",
                               formula=f"cost = {_inr(cost)}", icon="layers", code="analytics/portfolio.py · run_fifo", items=items))
            gain = amt - cost
            tc = inst.get("tax_class") or d.default_tax_class(ac, inst.get("market"), inst.get("category"), inst["name"])
            rule_t = rule_for(tc, str(t["date"])[:10])
            terms = {"long-term" if rule_t["lt_days"] and r.holding_days >= rule_t["lt_days"] else "short-term" for r in mine}
            held = max((r.holding_days for r in mine), default=0)
            term = "mixed short- and long-term" if len(terms) > 1 else (terms.pop() if terms else "—")
            if rule_t["lt_days"] is None:
                term = "taxed at your slab rate (no long-term rate for this kind)"
            steps.append(_step("gain", "Gain booked", f"{term[:1].upper() + term[1:]} · held up to {held} days",
                               formula=f"{_inr(amt)} − {_inr(cost)} = {_inr(gain)}", tone="good" if gain >= 0 else "bad",
                               icon="sparkles", code="analytics/portfolio.py · RealizedLot / analytics/tax.py · rule_for"))
        elif typ == d.BONUS:
            steps.append(_step("lots", "Bonus lot", f"{_q(qty)} {unit} added at zero cost, dated {t['date']}",
                               icon="layers", code="analytics/portfolio.py · run_fifo"))
        elif typ == d.SPLIT:
            steps.append(_step("lots", "Split", f"Every open lot now has {_q(qty)}× the units; cost and dates unchanged",
                               icon="layers", code="analytics/portfolio.py · run_fifo"))
        if typ in (d.BUY, d.SELL, d.BONUS, d.SPLIT):
            lb, _, _ = run_fifo(inst["id"], before)
            la, _, _ = run_fifo(inst["id"], upto)
            qb, cb = sum(l.qty for l in lb), sum(l.cost for l in lb)
            qa, ca = sum(l.qty for l in la), sum(l.cost for l in la)
            steps.append(_step("after", "Holding after", f"{_q(qb)} → {_q(qa)} {unit}" + (f" · avg cost {_inr(ca / qa)}" if qa > EPS else ""),
                               formula=f"cost {_inr(cb)} → {_inr(ca)}", icon="pieChart", code="analytics/portfolio.py · _tradable_position"))
    elif ac == d.P2P and typ == d.REPAYMENT:
        principal = t.get("principal")
        if principal is None:
            steps.append(_step("split", "Principal and interest", "No split saved: the app assumes an equal share of the loan "
                               "as principal", tone="warn", icon="pieChart", code="analytics/portfolio.py · _p2p_position"))
        else:
            steps.append(_step("split", "Principal and interest", f"{_inr(_f(principal))} principal back · {_inr(amt - _f(principal))} interest",
                               formula=f"{_inr(amt)} − {_inr(_f(principal))} = {_inr(amt - _f(principal))} interest",
                               icon="pieChart", code="analytics/portfolio.py · _p2p_position"))
    elif ac == d.FIXED_DEPOSIT and typ == d.MATURITY:
        dep = sum(_f(x["amount"]) for x in ordered if x["type"] == d.BUY)
        steps.append(_step("after", "FD closed", "Its value drops to zero; the gain is booked",
                           formula=f"{_inr(amt)} − {_inr(dep)} deposited = {_inr(amt - dep)}", tone="good",
                           icon="pieChart", code="analytics/portfolio.py · _fd_position"))
    elif ac == d.EPF:
        bal = sum(_f(x["amount"]) * (1 if x["type"] in (d.BUY, d.CREDIT) else -1 if x["type"] == d.SELL else 0) for x in upto)
        steps.append(_step("after", "EPF balance after", _inr(bal), icon="piggy", code="analytics/portfolio.py · epf_balance"))

    # 4 · return (XIRR): is it a cash flow, and with which sign?
    if pos is not None:
        owners = wallet_owners(port["positions"])
        fl = external_flows(pos, [t], owners, today)
        if fl:
            v = fl[0][1]
            steps.append(_step("xirr", "Return (XIRR)", f"Counted as {'+' if v > 0 else ''}{_inr(v)} on {fl[0][0].isoformat()} "
                               f"({'money back to you' if v > 0 else 'money you put in'})", tone="info", icon="repeat",
                               code="analytics/portfolio.py · external_flows"))
        else:
            why = ("it happens inside your US broker account; the rupee transfer to that account is the cash flow"
                   if pos["segment"] == d.SEG_EQ_US and pos["owner"] in owners and typ in (d.BUY, d.SELL, d.DIVIDEND, d.INTEREST)
                   else "the loan is funded from your P2P wallet; money you added to the wallet is the cash flow "
                        "(or this amount on this date, if no top-up was recorded before it)"
                   if ac == d.P2P and typ == d.BUY
                   else "no money crossed into or out of the portfolio")
            steps.append(_step("xirr", "Return (XIRR)", f"Not a cash flow: {why}", tone="info", icon="repeat",
                               code="analytics/portfolio.py · external_flows"))

    # 5 · tax
    fy = d.fy_of(str(t["date"])[:10])
    tc = inst.get("tax_class") or d.default_tax_class(ac, inst.get("market"), inst.get("category"), inst["name"])
    if typ == d.SELL and ac in d.TRADABLE:
        r = rule_for(tc, str(t["date"])[:10])
        text = f"{fy} · capital gain" + (" · equity: long-term gains up to ₹1.25 L a year are tax-free" if r["exempt"] else "")
    elif typ == d.BUY and ac in d.TRADABLE:
        r = rule_for(tc, str(t["date"])[:10])
        text = f"No tax on buying. Long-term after {r['lt_days']} days" if r["lt_days"] else "No tax on buying; gains are taxed at your slab rate"
    elif typ in (d.DIVIDEND, d.INTEREST) or (typ == d.REPAYMENT and ac == d.P2P):
        text = f"{fy} · income taxed at your slab rate"
    elif tc == d.TAX_EXEMPT:
        text = "EPF and NPS sit outside capital gains"
    else:
        text = f"{fy} · nothing taxable from this entry by itself"
    steps.append(_step("tax", "Tax", text, tone="info", icon="receiptText", code="analytics/tax.py · compute_tax"))

    # 6 · where it shows
    if pos is not None:
        total = _f(port["totals"]["value"]) or 1.0
        steps.append(_step("now", "In your numbers today",
                           f"{inst['name']} is worth {_inr(_f(pos['value']))} ({_f(pos['value']) / total * 100:.1f}% of everything) "
                           f"in {d.GROUP_LABELS[pos['group']]}", tone="info", icon="pieChart",
                           code="analytics/overview.py · group_view"))
    return {"txn": {**{k: t.get(k) for k in ("id", "date", "type", "quantity", "amount", "amount_fc", "principal", "source", "notes")},
                    "type_label": TYPE_LABEL.get(typ, typ)},
            "instrument": {"id": inst["id"], "name": inst["name"], "asset_class": ac, "group": d.group_of(inst)},
            "steps": steps}


def data_checks(port: dict, txns: list[dict], instruments: list[dict], settings: dict, today: date) -> list[dict]:
    """Things in the data that make numbers wrong or uncertain, each with what to do about it."""
    out = []
    pos = port["positions"]
    inst_map = {i["id"]: i for i in instruments}

    def add(cid, severity, title, detail, items, fix, link=None):
        if items:
            out.append({"id": cid, "severity": severity, "title": title, "detail": detail, "count": len(items),
                        "items": items[:30], "fix": fix, "link": link})

    add("unmatched-sells", "bad", "Sales with no buy behind them",
        "More units were sold than were bought, so part of the sale has zero cost and the gain is overstated.",
        [{"instrument_id": p["id"], "name": p["name"], "detail": f"{_q(p['unmatched_sell_qty'])} units unmatched"}
         for p in pos if p.get("unmatched_sell_qty")], "Add the missing buy, or fix the sale's quantity.")
    add("missing-prices", "warn", "Holdings without a price",
        "These are valued at what you paid until a ticker is added.",
        [{"instrument_id": p["id"], "name": p["name"], "detail": "valued at cost"} for p in pos
         if p.get("is_open") and p["asset_class"] in d.TRADABLE and not p.get("has_price")],
        "Open the holding's details and add its ticker (NSE, US or AMFI code).")
    add("fd-past-maturity", "warn", "FDs past their maturity date",
        "Still counted as open. Mark them matured so the money shows as back with you.",
        [{"instrument_id": p["id"], "name": p["name"], "detail": f"matured {-(p['days_to_maturity'])} days ago"} for p in pos
         if p["asset_class"] == d.FIXED_DEPOSIT and p.get("is_open") and (p.get("days_to_maturity") or 0) < 0],
        "Mark each FD as matured with the amount received.")
    by_inst = defaultdict(list)
    for t in txns:
        by_inst[t["instrument_id"]].append(t)
    unsplit = [t for t in txns if t["type"] == d.REPAYMENT and t.get("principal") is None]
    add("p2p-no-split", "info", "P2P repayments without a principal split",
        "The app assumes an equal share of each loan as principal, so interest and the amount left are estimates.",
        [{"instrument_id": t["instrument_id"], "name": inst_map.get(t["instrument_id"], {}).get("name", "?"),
          "detail": f"{t['date']} · {_inr(_f(t['amount']))}", "txn_id": t["id"]} for t in unsplit],
        "Edit each repayment and enter its interest; imports from LenDenClub fill this in.")
    add("p2p-overdue", "warn", "P2P loans overdue more than 30 days",
        "Still valued at the full amount left. If the platform shows them as defaulted, mark them so.",
        [{"instrument_id": p["id"], "name": p["name"], "detail": f"{p['overdue_days']} days late · {_inr(_f(p.get('outstanding')))} left"}
         for p in pos if p["asset_class"] == d.P2P and (p.get("overdue_days") or 0) > 30],
        "Open the loan and set its status.")
    w = [p for p in pos if p.get("status") == "wallet" and (p.get("wallet") or {}).get("topups", 0) > 1]
    add("p2p-topups-missing", "info", "P2P loans with no wallet top-up recorded before them",
        "Their amount counts as added to the wallet on the loan date. Record your top-ups (+ › P2P wallet) for exact "
        "money-in figures and an exact wallet balance.",
        [{"instrument_id": p["id"], "name": p["name"], "detail": f"{_inr(p['wallet']['topups'])} counted as added on loan dates"}
         for p in w], "Add your bank → wallet top-ups, or your current wallet balance as one top-up.")
    add("wallet-negative", "bad", "USD wallet below zero",
        "US stock buys used more dollars than were sent to the account.",
        [{"instrument_id": p["id"], "name": p["name"], "detail": f"${p.get('balance_usd', 0):,.2f}"} for p in pos
         if p["asset_class"] == d.CASH and (p.get("balance_usd") or 0) < -0.01],
        "Add the missing USD transfer, or check the dollar amounts on US buys.")
    seen = defaultdict(list)
    for t in txns:
        seen[(t["instrument_id"], str(t["date"])[:10], t["type"], round(_f(t["amount"]), 2), round(_f(t.get("quantity")), 6))].append(t)
    dups = [ts for ts in seen.values() if len(ts) > 1]
    add("duplicates", "info", "Entries that look duplicated",
        "Same holding, date, type, amount and quantity more than once. Fine if real; otherwise delete the extra.",
        [{"instrument_id": ts[0]["instrument_id"], "name": inst_map.get(ts[0]["instrument_id"], {}).get("name", "?"),
          "detail": f"{ts[0]['date']} · {ts[0]['type']} · {_inr(_f(ts[0]['amount']))} × {len(ts)}", "txn_id": ts[-1]["id"]} for ts in dups],
        "Open the entries list and remove the extra one.")
    if str(settings.get("autoCapitalFlows", "true")).lower() == "false":
        out.append({"id": "auto-cash-off", "severity": "info", "title": "Automatic cash entries are off",
                    "detail": "New entries don't record money in or out, so 'money invested' figures may lag.",
                    "count": 1, "items": [], "fix": "Turn them back on in Settings.", "link": "/settings"})
    order = {"bad": 0, "warn": 1, "info": 2}
    out.sort(key=lambda c: (order[c["severity"]], -c["count"]))
    return out
