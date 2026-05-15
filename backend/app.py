import os
import signal
import subprocess
from flask import Flask, request, jsonify
from flask_cors import CORS
from db_service import DbService

app = Flask(__name__)
CORS(app)


@app.errorhandler(Exception)
def handle_exception(e):
    return jsonify({"error": str(e)}), 500

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(_BASE_DIR, "investments.db"))
TURSO_URL = os.environ.get("TURSO_DATABASE_URL")
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")

db_service = DbService(DB_PATH, turso_url=TURSO_URL, turso_token=TURSO_TOKEN)


def _handle_add(sheet_name):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row(sheet_name, data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["upserted"]:
        return jsonify({"message": "Existing entry updated", "id": result["id"], "upserted": True}), 200
    return jsonify({"message": "Entry added", "id": result["id"], "upserted": False}), 201

# â”€â”€ Equity Endpoints â”€â”€

@app.route("/api/equity", methods=["GET"])
def get_equity():
    rows = db_service.get_all("Equity")
    return jsonify(rows)


@app.route("/api/equity", methods=["POST"])
def add_equity():
    return _handle_add("Equity")


@app.route("/api/equity/<int:row_id>", methods=["PUT"])
def update_equity(row_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    success = db_service.update_row("Equity", row_id, data)
    if success:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/equity/<int:row_id>", methods=["DELETE"])
def delete_equity(row_id):
    success = db_service.delete_row("Equity", row_id)
    if success:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# â”€â”€ Mutual Funds Endpoints â”€â”€

@app.route("/api/mutual-funds", methods=["GET"])
def get_mutual_funds():
    rows = db_service.get_all("Mutual Funds")
    return jsonify(rows)


@app.route("/api/mutual-funds", methods=["POST"])
def add_mutual_fund():
    return _handle_add("Mutual Funds")


@app.route("/api/mutual-funds/<int:row_id>", methods=["PUT"])
def update_mutual_fund(row_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    success = db_service.update_row("Mutual Funds", row_id, data)
    if success:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/mutual-funds/<int:row_id>", methods=["DELETE"])
def delete_mutual_fund(row_id):
    success = db_service.delete_row("Mutual Funds", row_id)
    if success:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# â”€â”€ Commodity Endpoints â”€â”€

@app.route("/api/commodity", methods=["GET"])
def get_commodity():
    rows = db_service.get_all("Commodity")
    return jsonify(rows)


@app.route("/api/commodity", methods=["POST"])
def add_commodity():
    return _handle_add("Commodity")


@app.route("/api/commodity/<int:row_id>", methods=["PUT"])
def update_commodity(row_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    success = db_service.update_row("Commodity", row_id, data)
    if success:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/commodity/<int:row_id>", methods=["DELETE"])
def delete_commodity(row_id):
    success = db_service.delete_row("Commodity", row_id)
    if success:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# â”€â”€ P2P Endpoints â”€â”€

@app.route("/api/p2p", methods=["GET"])
def get_p2p():
    rows = db_service.get_all("P2P")
    return jsonify(rows)


@app.route("/api/p2p", methods=["POST"])
def add_p2p():
    return _handle_add("P2P")


@app.route("/api/p2p/<int:row_id>", methods=["PUT"])
def update_p2p(row_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    success = db_service.update_row("P2P", row_id, data)
    if success:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/p2p/<int:row_id>", methods=["DELETE"])
def delete_p2p(row_id):
    # Get the lending_id before deleting so we can cascade-delete repayments
    rows = db_service.get_all("P2P")
    lending_id = None
    for r in rows:
        if r.get("id") == row_id:
            lending_id = r.get("lending_id")
            break
    success = db_service.delete_row("P2P", row_id)
    if success:
        # Cascade-delete all repayments with this lending_id
        if lending_id:
            repayments = db_service.get_all("P2P Repayments")
            # Delete in reverse order so row indices don't shift
            to_delete = [r["id"] for r in repayments if r.get("lending_id") == lending_id]
            for rid in sorted(to_delete, reverse=True):
                db_service.delete_row("P2P Repayments", rid)
        return jsonify({"message": "Entry and related repayments deleted"})
    return jsonify({"error": "Row not found"}), 404


# â”€â”€ P2P Repayments Endpoints â”€â”€

@app.route("/api/p2p-repayments", methods=["GET"])
def get_p2p_repayments():
    rows = db_service.get_all("P2P Repayments")
    return jsonify(rows)


@app.route("/api/p2p-repayments", methods=["POST"])
def add_p2p_repayment():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.add_row("P2P Repayments", data)
    return jsonify({"message": "Repayment added", "id": result["id"]}), 201


@app.route("/api/p2p-repayments/<int:row_id>", methods=["PUT"])
def update_p2p_repayment(row_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    success = db_service.update_row("P2P Repayments", row_id, data)
    if success:
        return jsonify({"message": "Repayment updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/p2p-repayments/<int:row_id>", methods=["DELETE"])
def delete_p2p_repayment(row_id):
    success = db_service.delete_row("P2P Repayments", row_id)
    if success:
        return jsonify({"message": "Repayment deleted"})
    return jsonify({"error": "Row not found"}), 404


# â”€â”€ Fixed Deposits Endpoints â”€â”€

@app.route("/api/fixed-deposits", methods=["GET"])
def get_fixed_deposits():
    rows = db_service.get_all("Fixed Deposits")
    return jsonify(rows)


@app.route("/api/fixed-deposits", methods=["POST"])
def add_fixed_deposit():
    return _handle_add("Fixed Deposits")


@app.route("/api/fixed-deposits/<int:row_id>", methods=["PUT"])
def update_fixed_deposit(row_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    success = db_service.update_row("Fixed Deposits", row_id, data)
    if success:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/fixed-deposits/<int:row_id>", methods=["DELETE"])
def delete_fixed_deposit(row_id):
    success = db_service.delete_row("Fixed Deposits", row_id)
    if success:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# â”€â”€ Summary Endpoint â”€â”€

@app.route("/api/summary", methods=["GET"])
def get_summary():
    summary = db_service.get_summary()
    return jsonify(summary)


# â”€â”€ Forex Endpoints â”€â”€

@app.route("/api/forex", methods=["GET"])
def get_forex():
    rows = db_service.get_all("Forex")
    return jsonify(rows)


@app.route("/api/forex", methods=["POST"])
def add_forex():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    # Compute rate = INR / USD
    try:
        inr = float(data.get("inr_amount", 0))
        usd = float(data.get("usd_amount", 0))
        if usd > 0:
            data["rate"] = round(inr / usd, 4)
        else:
            data["rate"] = 0
    except (ValueError, TypeError):
        data["rate"] = 0
    result = db_service.add_row("Forex", data)
    return jsonify({"message": "Entry added", "id": result["id"]}), 201


@app.route("/api/forex/<int:row_id>", methods=["PUT"])
def update_forex(row_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        inr = float(data.get("inr_amount", 0))
        usd = float(data.get("usd_amount", 0))
        if usd > 0:
            data["rate"] = round(inr / usd, 4)
        else:
            data["rate"] = 0
    except (ValueError, TypeError):
        data["rate"] = 0
    success = db_service.update_row("Forex", row_id, data)
    if success:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/forex/<int:row_id>", methods=["DELETE"])
def delete_forex(row_id):
    success = db_service.delete_row("Forex", row_id)
    if success:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# ── AI Analysis Endpoint ──

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

@app.route("/api/ai/analyze", methods=["POST"])
def ai_analyze():
    api_key = GEMINI_API_KEY
    if not api_key:
        return jsonify({"error": "AI service not configured"}), 503

    # Gather all portfolio data
    summary = db_service.get_summary()
    equity = db_service.get_all("Equity")
    commodity = db_service.get_all("Commodity")
    mutual_funds = db_service.get_all("Mutual Funds")
    p2p = db_service.get_all("P2P")
    fixed_deposits = db_service.get_all("Fixed Deposits")

    # Build portfolio context
    portfolio_context = f"""
PORTFOLIO SUMMARY:
{_format_summary(summary)}

EQUITY HOLDINGS ({len(equity)} entries):
{_format_equity(equity)}

MUTUAL FUNDS ({len(mutual_funds)} entries):
{_format_mf(mutual_funds)}

COMMODITY ({len(commodity)} entries):
{_format_commodity(commodity)}

P2P LENDING ({len(p2p)} entries):
{_format_p2p(p2p)}

FIXED DEPOSITS ({len(fixed_deposits)} entries):
{_format_fd(fixed_deposits)}

TARGET ALLOCATION: Equity India 35%, Equity USA 30%, Mutual Funds 20%, Commodity 10%, P2P 5%
"""

    prompt = f"""You are an expert investment advisor. Analyze the following portfolio and provide actionable insights.

{portfolio_context}

Provide your analysis in the following sections (use markdown formatting):

## Portfolio Health Score
Give a score out of 10 with brief justification.

## Asset Allocation Analysis
Compare current allocation vs target. Identify over/under-allocated categories.

## Risk Assessment
Identify concentration risks, sector overexposure, and diversification gaps.

## Recommendations
Provide 3-5 specific, actionable suggestions (rebalancing, new sectors to explore, positions to trim/add).

## Key Metrics
- Total Portfolio Value
- Diversification Score (1-10)
- Risk Level (Low/Medium/High)

Keep the response concise and actionable. Use bullet points."""

    # Call Gemini API
    try:
        gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}"
        resp = requests.post(gemini_url, json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.7, "maxOutputTokens": 2048}
        }, timeout=30)

        if resp.status_code != 200:
            return jsonify({"error": f"Gemini API error: {resp.status_code}"}), 502

        data = resp.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        return jsonify({"analysis": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _format_summary(summary):
    lines = []
    for cat, data in summary.items():
        lines.append(f"  {cat}: Invested ₹{data['total_buy']:,.0f}, Sold ₹{data['total_sell']:,.0f}, Net ₹{data['net']:,.0f}")
    return "\n".join(lines)


def _format_equity(entries):
    if not entries:
        return "  No entries"
    holdings = {}
    for e in entries:
        name = e.get("name", "Unknown")
        if name not in holdings:
            holdings[name] = {"market": e.get("market", ""), "sector": e.get("sector", ""), "market_cap": e.get("market_cap", ""), "buy_qty": 0, "buy_val": 0, "sell_qty": 0, "sell_val": 0}
        holdings[name]["buy_qty"] += (e.get("buy_quantity") or 0)
        holdings[name]["buy_val"] += (e.get("buy_value") or 0)
        holdings[name]["sell_qty"] += (e.get("sell_quantity") or 0)
        holdings[name]["sell_val"] += (e.get("sell_value") or 0)
    lines = []
    for name, h in holdings.items():
        net_qty = h["buy_qty"] - h["sell_qty"]
        if net_qty > 0:
            lines.append(f"  {name} ({h['market']}/{h['market_cap']}/{h['sector']}): Qty {net_qty:.4f}, Invested ₹{h['buy_val'] - h['sell_val']:,.0f}")
    return "\n".join(lines) or "  No current holdings"


def _format_mf(entries):
    if not entries:
        return "  No entries"
    holdings = {}
    for e in entries:
        name = e.get("name", "Unknown")
        if name not in holdings:
            holdings[name] = {"category": e.get("category", ""), "fund_type": e.get("fund_type", ""), "buy_val": 0, "sell_val": 0}
        holdings[name]["buy_val"] += (e.get("buy_value") or 0)
        holdings[name]["sell_val"] += (e.get("sell_value") or 0)
    lines = []
    for name, h in holdings.items():
        net = h["buy_val"] - h["sell_val"]
        if net > 0:
            lines.append(f"  {name} ({h['category']}/{h['fund_type']}): Invested ₹{net:,.0f}")
    return "\n".join(lines) or "  No current holdings"


def _format_commodity(entries):
    if not entries:
        return "  No entries"
    holdings = {}
    for e in entries:
        name = e.get("name", "Unknown")
        if name not in holdings:
            holdings[name] = {"commodity": e.get("commodity", ""), "buy_qty": 0, "buy_val": 0, "sell_qty": 0, "sell_val": 0}
        holdings[name]["buy_qty"] += (e.get("buy_quantity") or 0)
        holdings[name]["buy_val"] += (e.get("buy_value") or 0)
        holdings[name]["sell_qty"] += (e.get("sell_quantity") or 0)
        holdings[name]["sell_val"] += (e.get("sell_value") or 0)
    lines = []
    for name, h in holdings.items():
        net_qty = h["buy_qty"] - h["sell_qty"]
        if net_qty > 0:
            lines.append(f"  {name} ({h['commodity']}): Qty {net_qty:.4f}, Invested ₹{h['buy_val'] - h['sell_val']:,.0f}")
    return "\n".join(lines) or "  No current holdings"


def _format_p2p(entries):
    if not entries:
        return "  No entries"
    lines = []
    for e in entries:
        if e.get("status") == "Active":
            lines.append(f"  {e.get('name', 'Unknown')} ({e.get('platform', '')}): ₹{e.get('amount', 0):,.0f}, Tenure {e.get('tenure', 0)}mo, Maturity {e.get('maturity_date', 'N/A')}")
    return "\n".join(lines) or "  No active lendings"


def _format_fd(entries):
    if not entries:
        return "  No entries"
    lines = []
    for e in entries:
        lines.append(f"  {e.get('bank_name', 'Unknown')} ({e.get('platform', '')}): ₹{e.get('fd_value', 0):,.0f}, Interest {e.get('interest', 0)}%, Maturity {e.get('maturity_date', 'N/A')}")
    return "\n".join(lines) or "  No entries"


# â”€â”€ Shutdown Endpoint â”€â”€

@app.route("/api/shutdown", methods=["POST"])
def shutdown():
    # Kill Angular dev server on port 4200
    try:
        result = subprocess.run(
            'netstat -aon | findstr ":4200 " | findstr "LISTENING"',
            capture_output=True, text=True, shell=True
        )
        for line in result.stdout.strip().splitlines():
            pid = line.strip().split()[-1]
            if pid.isdigit():
                subprocess.run(f"taskkill /f /pid {pid}", shell=True,
                               capture_output=True)
    except Exception:
        pass

    # Stop Flask after responding
    os.kill(os.getpid(), signal.SIGTERM)
    return jsonify({"message": "Shutting down"})


if __name__ == "__main__":
    app.run(debug=True, port=5001, host="0.0.0.0")
