import os
import signal
import subprocess
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Load .env BEFORE any other imports so env vars are available at module init time
_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
if os.path.exists(_env_path):
    with open(_env_path, encoding='utf-8') as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith('#') and '=' in _line:
                _k, _v = _line.split('=', 1)
                _k, _v = _k.strip(), _v.strip()
                if _v:
                    os.environ[_k] = _v

from flask import Flask, request, jsonify
from flask_cors import CORS
from db_service import DbService
from auth_service import (
    verify_google_token, check_allowlist, add_to_allowlist,
    create_user_session, require_auth, get_allowlist, set_db_service
)

app = Flask(__name__)

# Restrict CORS to known frontend origins
_ALLOWED_ORIGINS = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
    "https://investment-tracker-nrm5.onrender.com",
]
CORS(app, origins=_ALLOWED_ORIGINS)


@app.errorhandler(Exception)
def handle_exception(e):
    return jsonify({"error": str(e)}), 500

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(_BASE_DIR, "investments.db"))
TURSO_URL = os.environ.get("TURSO_DATABASE_URL")
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")

db_service = DbService(DB_PATH, turso_url=TURSO_URL, turso_token=TURSO_TOKEN)

# Initialize auth service
set_db_service(db_service)


# ── Global auth guard — all /api/* routes except /api/auth/* require a valid JWT ──
_AUTH_EXEMPT = {
    "google_login",   # POST /api/auth/google-login
}

@app.before_request
def require_auth_global():
    from auth_service import verify_jwt_token
    # Only guard /api/ routes
    if not request.path.startswith("/api/"):
        return None
    # Allow CORS preflight requests through (handled by Flask-CORS)
    if request.method == "OPTIONS":
        return None
    # Allow auth endpoints through
    if request.path.startswith("/api/auth/google-login"):
        return None
    # All other /api/ routes need a valid JWT
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"error": "Missing authorization token"}), 401
    token = auth_header[7:]
    payload = verify_jwt_token(token)
    if not payload:
        return jsonify({"error": "Invalid or expired token"}), 401
    request.user_email = payload.get("email")


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

def _auto_create_capital_flows(sheet_name, transaction_data):
    """Automatically create capital flow entries for investment transactions.
    
    - Mutual Funds: buy_value -> Deposit, sell_value -> Withdrawal
    - P2P Lending: amount -> Deposit
    - P2P Repayments: amount -> Withdrawal
    """
    try:
        if sheet_name == "Mutual Funds":
            # Create Deposit for buy transactions
            buy_value = transaction_data.get("buy_value")
            if buy_value and float(buy_value) > 0:
                capital_flow = {
                    "date": transaction_data.get("date", ""),
                    "amount": float(buy_value),
                    "type": "Deposit",
                    "category": "Mutual Funds",
                    "remarks": f"{transaction_data.get('name', 'MF')} purchase"
                }
                db_service.add_row("Capital Flows", capital_flow)
            
            # Create Withdrawal for sell transactions
            sell_value = transaction_data.get("sell_value")
            if sell_value and float(sell_value) > 0:
                capital_flow = {
                    "date": transaction_data.get("date", ""),
                    "amount": float(sell_value),
                    "type": "Withdrawal",
                    "category": "Mutual Funds",
                    "remarks": f"{transaction_data.get('name', 'MF')} sale"
                }
                db_service.add_row("Capital Flows", capital_flow)
        
        elif sheet_name == "P2P":
            # Create Deposit for P2P lending
            amount = transaction_data.get("amount")
            if amount and float(amount) > 0:
                capital_flow = {
                    "date": transaction_data.get("date", ""),
                    "amount": float(amount),
                    "type": "Deposit",
                    "category": "P2P",
                    "remarks": f"{transaction_data.get('name', 'P2P')} lending on {transaction_data.get('platform', '')}"
                }
                db_service.add_row("Capital Flows", capital_flow)
        
        elif sheet_name == "P2P Repayments":
            # Create Withdrawal for P2P repayment
            amount = transaction_data.get("amount")
            if amount and float(amount) > 0:
                capital_flow = {
                    "date": transaction_data.get("date", ""),
                    "amount": float(amount),
                    "type": "Withdrawal",
                    "category": "P2P",
                    "remarks": f"P2P repayment"
                }
                db_service.add_row("Capital Flows", capital_flow)
        
        elif sheet_name == "Forex":
            # Create capital flows for Forex transactions (using INR value)
            forex_type = transaction_data.get("type", "").lower()
            inr_amount = transaction_data.get("inr_amount")
            usd_amount = transaction_data.get("usd_amount")
            rate = transaction_data.get("rate", "")
            
            if forex_type == "deposit" and inr_amount and float(inr_amount) > 0:
                # Forex deposit = capital inflow
                capital_flow = {
                    "date": transaction_data.get("date", ""),
                    "amount": float(inr_amount),
                    "type": "Deposit",
                    "category": "Equity/Commodity",
                    "remarks": f"Forex deposit: ${usd_amount} at ₹{rate}/USD"
                }
                db_service.add_row("Capital Flows", capital_flow)
            
            elif forex_type == "withdrawal" and inr_amount and float(inr_amount) > 0:
                # Forex withdrawal = capital outflow
                capital_flow = {
                    "date": transaction_data.get("date", ""),
                    "amount": float(inr_amount),
                    "type": "Withdrawal",
                    "category": "Equity/Commodity",
                    "remarks": f"Forex withdrawal: ${usd_amount} at ₹{rate}/USD"
                }
                db_service.add_row("Capital Flows", capital_flow)
    except Exception as e:
        print(f"[Warning] Failed to auto-create capital flow: {e}")
        # Don't fail the main transaction if capital flow creation fails
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
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row("Mutual Funds", data)
        # Auto-create capital flows for this transaction
        _auto_create_capital_flows("Mutual Funds", data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["upserted"]:
        return jsonify({"message": "Existing entry updated", "id": result["id"], "upserted": True}), 200
    return jsonify({"message": "Entry added", "id": result["id"], "upserted": False}), 201


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
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row("P2P", data)
        # Auto-create capital flows for this transaction
        _auto_create_capital_flows("P2P", data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["upserted"]:
        return jsonify({"message": "Existing entry updated", "id": result["id"], "upserted": True}), 200
    return jsonify({"message": "Entry added", "id": result["id"], "upserted": False}), 201


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
    try:
        result = db_service.add_row("P2P Repayments", data)
        # Auto-create capital flows for this transaction
        _auto_create_capital_flows("P2P Repayments", data)
        return jsonify({"message": "Repayment added", "id": result["id"]}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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


# ── P2P Escrow Endpoints ──

@app.route("/api/p2p-escrow", methods=["GET"])
def get_p2p_escrow():
    rows = db_service.get_all("P2P Escrow")
    return jsonify(rows)


@app.route("/api/p2p-escrow", methods=["POST"])
def add_p2p_escrow():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.add_row("P2P Escrow", data)
    return jsonify({"message": "Escrow transaction added", "id": result["id"]}), 201


@app.route("/api/p2p-escrow/<int:row_id>", methods=["PUT"])
def update_p2p_escrow(row_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    success = db_service.update_row("P2P Escrow", row_id, data)
    if success:
        return jsonify({"message": "Escrow transaction updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/p2p-escrow/<int:row_id>", methods=["DELETE"])
def delete_p2p_escrow(row_id):
    success = db_service.delete_row("P2P Escrow", row_id)
    if success:
        return jsonify({"message": "Escrow transaction deleted"})
    return jsonify({"error": "Row not found"}), 404


# ── Fixed Deposits Endpoints ──

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
    _auto_create_capital_flows("Forex", data)
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
        _auto_create_capital_flows("Forex", data)
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/forex/<int:row_id>", methods=["DELETE"])
def delete_forex(row_id):
    success = db_service.delete_row("Forex", row_id)
    if success:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# ── Capital Flows Endpoints ──

@app.route("/api/capital-flows", methods=["GET"])
def get_capital_flows():
    rows = db_service.get_all("Capital Flows")
    return jsonify(rows)


@app.route("/api/capital-flows", methods=["POST"])
def add_capital_flow():
    return _handle_add("Capital Flows")


@app.route("/api/capital-flows/<int:row_id>", methods=["PUT"])
def update_capital_flow(row_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    success = db_service.update_row("Capital Flows", row_id, data)
    if success:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/capital-flows/<int:row_id>", methods=["DELETE"])
def delete_capital_flow(row_id):
    success = db_service.delete_row("Capital Flows", row_id)
    if success:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/capital-flows/summary", methods=["GET"])
def get_capital_flows_summary():
    summary = db_service.get_capital_flows_summary()
    return jsonify(summary)


# ── Authentication Endpoints ──

@app.route("/api/auth/google-login", methods=["POST"])
def google_login():
    """Verify Google OAuth token and create session"""
    data = request.get_json(silent=True) or {}
    token = data.get("token")
    
    if not token:
        return jsonify({"error": "Token is required"}), 400
    
    # Verify Google token
    user_info = verify_google_token(token)
    if not user_info:
        return jsonify({"error": "Invalid Google token"}), 401
    
    email = user_info.get("email")
    
    # Check if email is in allowlist
    if not check_allowlist(email):
        return jsonify({"error": "Access denied. Your email is not authorized."}), 403
    
    # Create user session
    jwt_token = create_user_session(user_info)
    if not jwt_token:
        return jsonify({"error": "Failed to create session"}), 500
    
    return jsonify({
        "token": jwt_token,
        "user": {
            "email": email,
            "name": user_info.get("name"),
            "picture": user_info.get("picture"),
        }
    }), 200


@app.route("/api/auth/verify", methods=["GET"])
@require_auth
def verify_auth():
    """Verify token validity"""
    return jsonify({"email": request.user_email}), 200


@app.route("/api/auth/allowlist", methods=["GET"])
@require_auth
def get_allowlist_endpoint():
    """Get allowlist (admin only - for now, all authenticated users can view)"""
    allowlist = get_allowlist()
    return jsonify({"allowlist": allowlist}), 200


@app.route("/api/auth/allowlist", methods=["POST"])
@require_auth
def add_allowlist_entry():
    """Add email to allowlist (admin only)"""
    # In a real app, check if user is admin
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip()
    
    if not email:
        return jsonify({"error": "Email is required"}), 400
    
    if add_to_allowlist(email):
        return jsonify({"message": f"Added {email} to allowlist"}), 201
    else:
        return jsonify({"error": "Failed to add to allowlist"}), 500


# ── AI Analysis Endpoint ──

AI_API_KEY = os.environ.get("GROQ_API_KEY") or os.environ.get("GEMINI_API_KEY")
AI_PROVIDER = "groq" if os.environ.get("GROQ_API_KEY") else "gemini"

@app.route("/api/ai/analyze", methods=["POST"])
def ai_analyze():
    api_key = AI_API_KEY
    if not api_key:
        return jsonify({"error": "AI service not configured. Set GROQ_API_KEY in environment."}), 503

    # Gather all portfolio data
    portfolio_context = _build_portfolio_context()

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

    # Call AI API
    try:
        if AI_PROVIDER == "groq":
            resp = requests.post("https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": "llama-3.3-70b-versatile",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.7,
                    "max_tokens": 2048
                }, timeout=30, verify=False)
        else:
            resp = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key={api_key}",
                json={"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.7, "maxOutputTokens": 2048}},
                timeout=30, verify=False)

        if resp.status_code != 200:
            error_detail = resp.text[:500] if resp.text else "No details"
            return jsonify({"error": f"AI API error: {resp.status_code} - {error_detail}"}), 502

        data = resp.json()
        if AI_PROVIDER == "groq":
            text = data["choices"][0]["message"]["content"]
        else:
            text = data["candidates"][0]["content"]["parts"][0]["text"]
        return jsonify({"analysis": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _build_portfolio_context():
    summary = db_service.get_summary()
    equity = db_service.get_all("Equity")
    commodity = db_service.get_all("Commodity")
    mutual_funds = db_service.get_all("Mutual Funds")
    p2p = db_service.get_all("P2P")
    fixed_deposits = db_service.get_all("Fixed Deposits")
    return f"""PORTFOLIO SUMMARY:
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

TARGET ALLOCATION: Equity India 35%, Equity USA 30%, Mutual Funds 20%, Commodity 10%, P2P 5%"""


@app.route("/api/ai/chat", methods=["POST"])
def ai_chat():
    api_key = AI_API_KEY
    if not api_key:
        return jsonify({"error": "AI service not configured. Set GROQ_API_KEY in environment."}), 503

    body = request.get_json(silent=True) or {}
    user_message = (body.get("message") or "").strip()
    history = body.get("history") or []  # list of {role: 'user'|'assistant', content: str}

    if not user_message:
        return jsonify({"error": "Message is required."}), 400

    portfolio_context = _build_portfolio_context()
    system_prompt = f"""You are an expert investment advisor with access to the user's full portfolio data. Answer questions concisely and accurately. Use markdown formatting. Always base your answers on the actual portfolio data provided below.

{portfolio_context}"""

    try:
        if AI_PROVIDER == "groq":
            messages = [{"role": "system", "content": system_prompt}]
            for h in history:
                role = h.get("role", "user")
                if role == "assistant":
                    role = "assistant"
                messages.append({"role": role, "content": h.get("content", "")})
            messages.append({"role": "user", "content": user_message})

            resp = requests.post("https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"model": "llama-3.3-70b-versatile", "messages": messages, "temperature": 0.7, "max_tokens": 1024},
                timeout=30, verify=False)
        else:
            # Gemini uses 'user'/'model' roles and no system message
            contents = [{"role": "user", "parts": [{"text": f"System context:\n{system_prompt}\n\nUser: {user_message}"}]}]
            for h in history:
                role = "model" if h.get("role") == "assistant" else "user"
                contents.append({"role": role, "parts": [{"text": h.get("content", "")}]})
            contents.append({"role": "user", "parts": [{"text": user_message}]})

            resp = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key={api_key}",
                json={"contents": contents, "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024}},
                timeout=30, verify=False)

        if resp.status_code != 200:
            return jsonify({"error": f"AI API error: {resp.status_code} - {resp.text[:300]}"}), 502

        data = resp.json()
        if AI_PROVIDER == "groq":
            reply = data["choices"][0]["message"]["content"]
        else:
            reply = data["candidates"][0]["content"]["parts"][0]["text"]
        return jsonify({"reply": reply})
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
        qty = e.get("quantity") or 0
        val = e.get("value") or 0
        if e.get("buy_sell") == "Sell":
            holdings[name]["sell_qty"] += qty
            holdings[name]["sell_val"] += val
        else:
            holdings[name]["buy_qty"] += qty
            holdings[name]["buy_val"] += val
    lines = []
    for name, h in holdings.items():
        net_qty = h["buy_qty"] - h["sell_qty"]
        net_val = h["buy_val"] - h["sell_val"]
        if net_val > 0:
            lines.append(f"  {name} ({h['market']}/{h['market_cap']}/{h['sector']}): Qty {net_qty:.4f}, Invested ₹{net_val:,.0f}")
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


# ── Settings Endpoints ──

@app.route("/api/settings/<key>", methods=["GET"])
def get_setting(key):
    value = db_service.get_setting(key)
    return jsonify({"key": key, "value": value})

@app.route("/api/settings/<key>", methods=["PUT"])
def set_setting(key):
    data = request.get_json()
    if not data or "value" not in data:
        return jsonify({"error": "Missing value"}), 400
    db_service.set_setting(key, data["value"])
    return jsonify({"message": "Setting saved"})


if __name__ == "__main__":
    app.run(debug=True, port=5001, host="0.0.0.0")
