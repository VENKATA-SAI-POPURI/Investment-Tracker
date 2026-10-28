"""LLM narration on top of the computed analytics (Groq or Gemini, configured by env)."""
from __future__ import annotations

import os

import requests

DISCLAIMER = ("Educational analysis generated from your recorded data. It is not investment advice from a "
              "SEBI-registered adviser; verify before acting.")


def provider() -> tuple[str | None, str | None]:
    if os.environ.get("GROQ_API_KEY"):
        return "groq", os.environ["GROQ_API_KEY"]
    if os.environ.get("GEMINI_API_KEY"):
        return "gemini", os.environ["GEMINI_API_KEY"]
    return None, None


def _inr(v) -> str:
    try:
        return f"₹{float(v):,.0f}"
    except (TypeError, ValueError):
        return "n/a"


def build_context(portfolio: dict, tax: dict | None, insights: list[dict], goals: list[dict],
                  perf: dict | None) -> str:
    t = portfolio["totals"]
    lines = [
        f"As of {portfolio['as_of']} (USD/INR {portfolio.get('usd_inr')}):",
        f"Portfolio value {_inr(t['value'])}, open cost {_inr(t['cost'])}, unrealized {_inr(t['unrealized'])} "
        f"({t.get('unrealized_pct')}%), realized {_inr(t['realized'])}, income {_inr(t['income'])}, XIRR {t.get('xirr')}%.",
        "", "ALLOCATION (segment: value, % now / target, XIRR):",
    ]
    for s in portfolio["segments"]:
        lines.append(f"- {s['segment']}: {_inr(s['value'])}, {s['pct']}% / {s.get('target')}%, XIRR {s.get('xirr')}%, "
                     f"unrealized {_inr(s['unrealized'])}")
    open_pos = sorted([p for p in portfolio["positions"] if p.get("is_open") and p["asset_class"] in ("equity", "mutual_fund", "commodity")],
                      key=lambda p: -p["value"])
    lines += ["", "TOP HOLDINGS (name | segment | sector | weight | unrealized % | XIRR):"]
    for p in open_pos[:25]:
        lines.append(f"- {p['name']} | {p['segment']} | {p.get('sector') or p.get('category') or ''} | {p['weight']}% | "
                     f"{p.get('unrealized_pct')}% | {p.get('xirr')}%")
    p2p = [p for p in portfolio["positions"] if p["asset_class"] == "p2p"]
    if p2p:
        lines.append(f"\nP2P: {sum(1 for p in p2p if p.get('is_open'))} active loans, outstanding "
                     f"{_inr(sum(p['outstanding'] for p in p2p))}, interest earned {_inr(sum(p['interest'] for p in p2p))}, "
                     f"defaulted at risk {_inr(sum(p.get('at_risk') or 0 for p in p2p))}.")
    if perf and perf.get("metrics"):
        m = perf["metrics"]
        lines.append(f"\nPERFORMANCE ({m['start']}→{m['end']}): TWR {m.get('twr')}%, XIRR {m.get('xirr')}%, "
                     f"volatility {m.get('volatility')}%, max drawdown {m.get('max_drawdown')}%, Sharpe {m.get('sharpe')}.")
        for b in perf.get("benchmarks", []):
            lines.append(f"- Same cash flows in {b['label']}: XIRR {b.get('xirr')}% (excess {b.get('excess_xirr')}%)")
    if tax:
        e = tax["estimate"]
        lines.append(f"\nTAX {tax['fy']}: realized {_inr(tax['total_realized'])}, estimated tax {_inr(e['total'])}, "
                     f"equity LTCG exemption left {_inr(tax['equity_exemption']['remaining'])}, "
                     f"harvestable losses {_inr(tax['opportunities']['loss_harvest_total'])}.")
    if goals:
        lines.append("\nGOALS:")
        for g in goals:
            pr = g.get("projection") or {}
            lines.append(f"- {g['name']}: target {_inr(g['target_amount'])} by {g['target_date']}, now {_inr(pr.get('current'))}, "
                         f"probability {pr.get('probability')}%, required SIP {_inr(pr.get('required_sip'))}")
    if insights:
        lines.append("\nRULE-BASED FLAGS:")
        for i in insights[:15]:
            lines.append(f"- [{i['severity']}] {i['title']} — {i['detail']}")
    return "\n".join(lines)


SYSTEM = ("You are a careful portfolio analyst for an Indian retail investor. Use only the data provided; "
          "quote numbers from it. Be specific and concise, use markdown headings and bullet points. "
          "Prefer low-cost, diversified, tax-efficient actions. Never invent prices or facts. "
          "End with one line reminding the user this is educational, not SEBI-registered advice.")

ANALYZE_PROMPT = """Review this portfolio and give:
## Health score
A score out of 10 with a one-line reason.
## What is working
2-3 bullets.
## Risks
Concentration, allocation drift, P2P/credit risk, currency risk — only what the data shows.
## Suggested actions (next 90 days)
3-6 numbered, specific actions with rupee amounts where possible (rebalancing, tax harvesting, SIP changes, goal gaps).
## Tax notes
Anything time-sensitive for this financial year."""


def complete(messages: list[dict], max_tokens: int = 1800) -> str:
    name, key = provider()
    if not key:
        raise RuntimeError("AI is not configured. Set GROQ_API_KEY or GEMINI_API_KEY on the server.")
    if name == "groq":
        resp = requests.post("https://api.groq.com/openai/v1/chat/completions",
                             headers={"Authorization": f"Bearer {key}"},
                             json={"model": os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"), "messages": messages,
                                   "temperature": 0.3, "max_tokens": max_tokens}, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"AI provider error {resp.status_code}: {resp.text[:200]}")
        return resp.json()["choices"][0]["message"]["content"]
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    contents = [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                for m in messages if m["role"] != "system"]
    resp = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/"
                         f"{os.environ.get('GEMINI_MODEL', 'gemini-2.0-flash')}:generateContent",
                         headers={"x-goog-api-key": key},
                         json={"systemInstruction": {"parts": [{"text": system}]}, "contents": contents,
                               "generationConfig": {"temperature": 0.3, "maxOutputTokens": max_tokens}}, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"AI provider error {resp.status_code}: {resp.text[:200]}")
    return resp.json()["candidates"][0]["content"]["parts"][0]["text"]


def analyze(context: str) -> str:
    return complete([{"role": "system", "content": SYSTEM + "\n\nPORTFOLIO DATA:\n" + context},
                     {"role": "user", "content": ANALYZE_PROMPT}])


def chat(context: str, history: list[dict], message: str) -> str:
    msgs = [{"role": "system", "content": SYSTEM + "\n\nPORTFOLIO DATA:\n" + context}]
    for h in history[-10:]:
        if h.get("role") in ("user", "assistant") and h.get("content"):
            msgs.append({"role": h["role"], "content": str(h["content"])[:4000]})
    msgs.append({"role": "user", "content": message[:4000]})
    return complete(msgs, max_tokens=1200)
