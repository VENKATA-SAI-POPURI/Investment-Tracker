import os
import signal
import subprocess
import requests
import urllib3
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeoutError
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
    create_user_session, require_auth, get_allowlist, set_db_service,
    update_user_role, remove_from_allowlist, create_impersonation_token
)

app = Flask(__name__)

# Restrict CORS to known frontend origins
_ALLOWED_ORIGINS = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
    "https://investment-tracker-nrm5.onrender.com",
    "https://my-investment-tracker.netlify.app",
]
CORS(app, origins=_ALLOWED_ORIGINS, allow_headers=["Authorization", "Content-Type", "X-View-As"])


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
    request.user_role = payload.get("role", "user")

    # Admin "View As" — if admin sends X-View-As header, scope data to that user
    if request.user_role == "admin":
        view_as = request.headers.get("X-View-As", "").strip()
        if view_as:
            request.user_email = view_as
            request.user_role = db_service.get_user_role(view_as) or "user"
            request.is_impersonating = True


def _handle_add(sheet_name):
    if getattr(request, 'user_role', 'user') == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row(sheet_name, data, created_by=getattr(request, 'user_email', None))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["upserted"]:
        return jsonify({"message": "Existing entry updated", "id": result["id"], "upserted": True}), 200
    return jsonify({"message": "Entry added", "id": result["id"], "upserted": False}), 201

def _auto_create_capital_flows(sheet_name, transaction_data, created_by=None):
    """Automatically create capital flow entries for investment transactions.
    
    - Mutual Funds: buy_value -> Deposit, sell_value -> Withdrawal
    - Fixed Deposits: fd_value -> Deposit
    - P2P Lending: amount -> Deposit
    - P2P Repayments: amount -> Withdrawal
    - Forex: inr_amount -> Deposit or Withdrawal (Equity USA)
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
                db_service.add_row("Capital Flows", capital_flow, created_by=created_by)
            
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
                db_service.add_row("Capital Flows", capital_flow, created_by=created_by)
        
        elif sheet_name == "Fixed Deposits":
            fd_value = transaction_data.get("fd_value")
            bank_name = transaction_data.get("bank_name", "FD")
            if fd_value and float(fd_value) > 0:
                capital_flow = {
                    "date": transaction_data.get("date", ""),
                    "amount": float(fd_value),
                    "type": "Deposit",
                    "category": "Fixed Deposits",
                    "remarks": f"FD at {bank_name}"
                }
                db_service.add_row("Capital Flows", capital_flow, created_by=created_by)

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
                db_service.add_row("Capital Flows", capital_flow, created_by=created_by)
                # Auto-create matching Escrow deposit
                lending_id = transaction_data.get("lending_id", "")
                escrow_entry = {
                    "date": transaction_data.get("date", ""),
                    "type": "Deposit",
                    "amount": float(amount),
                    "platform": transaction_data.get("platform", ""),
                    "remarks": f"Auto: {lending_id} - {transaction_data.get('name', 'P2P')} lending"
                }
                db_service.add_row("P2P Escrow", escrow_entry, created_by=created_by)
        
        elif sheet_name == "P2P Repayments":
            # Create Withdrawal for P2P repayment (platform fee is informational only)
            principal = transaction_data.get("principal")
            interest = transaction_data.get("interest")
            if principal is not None and interest is not None:
                net_credited = float(principal) + float(interest)
            else:
                # Legacy fallback: use gross amount
                net_credited = float(transaction_data.get("amount") or 0)
            if net_credited > 0:
                capital_flow = {
                    "date": transaction_data.get("date", ""),
                    "amount": net_credited,
                    "type": "Withdrawal",
                    "category": "P2P",
                    "remarks": f"P2P repayment"
                }
                db_service.add_row("Capital Flows", capital_flow, created_by=created_by)
        
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
                    "category": "Equity USA",
                    "remarks": f"Forex deposit: ${usd_amount} at ₹{rate}/USD"
                }
                db_service.add_row("Capital Flows", capital_flow, created_by=created_by)
            
            elif forex_type == "withdrawal" and inr_amount and float(inr_amount) > 0:
                # Forex withdrawal = capital outflow
                capital_flow = {
                    "date": transaction_data.get("date", ""),
                    "amount": float(inr_amount),
                    "type": "Withdrawal",
                    "category": "Equity USA",
                    "remarks": f"Forex withdrawal: ${usd_amount} at ₹{rate}/USD"
                }
                db_service.add_row("Capital Flows", capital_flow, created_by=created_by)
    except Exception as e:
        print(f"[Warning] Failed to auto-create capital flow: {e}")
        # Don't fail the main transaction if capital flow creation fails
# â”€â”€ Equity Endpoints â”€â”€

def _fetch_prices_parallel(symbols: list) -> dict:
    """Fetch Yahoo Finance prices for a list of symbols in parallel. Returns {symbol: price}."""
    if not symbols:
        return {}
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(pool_connections=30, pool_maxsize=30)
    session.mount("https://", adapter)
    session.verify = False
    session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})

    def _fetch_one(symbol):
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1d"
            resp = session.get(url, timeout=5)
            if resp.status_code == 200:
                results = resp.json().get("chart", {}).get("result") or []
                if results:
                    meta = results[0].get("meta", {})
                    price = meta.get("regularMarketPrice") or meta.get("previousClose")
                    return symbol, round(price, 4) if price is not None else None
            return symbol, None
        except Exception as e:
            print(f"[prices] Failed for {symbol}: {e}")
            return symbol, None

    prices = {}
    executor = ThreadPoolExecutor(max_workers=min(len(symbols), 30))
    try:
        futures = {executor.submit(_fetch_one, s): s for s in symbols}
        try:
            for future in as_completed(futures, timeout=12):
                try:
                    sym, price = future.result()
                    prices[sym] = price
                except Exception:
                    prices[futures[future]] = None
        except FuturesTimeoutError:
            print(f"[prices] Timed out; partial results for {len(prices)}/{len(symbols)} symbols")
            for future, sym in futures.items():
                if sym not in prices:
                    prices[sym] = None
    finally:
        executor.shutdown(wait=False)
    return prices


@app.route("/api/equity", methods=["GET"])
def get_equity():
    rows = db_service.get_all("Equity", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/equity", methods=["POST"])
def add_equity():
    if getattr(request, 'user_role', 'user') == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row("Equity", data, created_by=request.user_email)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["upserted"]:
        return jsonify({"message": "Existing entry updated", "id": result["id"], "upserted": True}), 200
    return jsonify({"message": "Entry added", "id": result["id"], "upserted": False}), 201


@app.route("/api/equity/<int:row_id>", methods=["PUT"])
def update_equity(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.update_row("Equity", row_id, data, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    if result:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/equity/<int:row_id>", methods=["DELETE"])
def delete_equity(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403
    result = db_service.delete_row("Equity", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403
    if result:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# ── Equity Dividends Endpoints ──

@app.route("/api/equity/dividends", methods=["GET"])
def get_equity_dividends():
    rows = db_service.get_all("Equity Dividends", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/equity/dividends", methods=["POST"])
def add_equity_dividend():
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
    data = request.get_json()
    if not data or not data.get("name") or not data.get("date") or not data.get("amount"):
        return jsonify({"error": "name, date, and amount are required"}), 400
    try:
        amount = float(data["amount"])
    except (ValueError, TypeError):
        return jsonify({"error": "amount must be a number"}), 400

    # Auto-create capital flow entry (dividend received = Withdrawal from equity pool)
    cf_data = {
        "date": data["date"],
        "amount": amount,
        "type": "Withdrawal",
        "category": "Equity/Commodity",
        "remarks": f"{data['name']} dividend",
    }
    cf_result = db_service.add_row("Capital Flows", cf_data, created_by=request.user_email)
    capital_flow_id = cf_result.get("id")

    dividend_data = {
        "name": data["name"],
        "date": data["date"],
        "amount": amount,
        "remarks": data.get("remarks", ""),
        "capital_flow_id": capital_flow_id,
    }
    result = db_service.add_row("Equity Dividends", dividend_data, created_by=request.user_email)
    db_service._cache.invalidate("rows:Equity Dividends", "rows:Capital Flows")
    return jsonify({"message": "Dividend added", "id": result["id"]}), 201


@app.route("/api/equity/dividends/<int:row_id>", methods=["PUT"])
def update_equity_dividend(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        amount = float(data["amount"])
    except (ValueError, TypeError):
        return jsonify({"error": "amount must be a number"}), 400

    # Fetch existing dividend to get capital_flow_id
    all_divs = db_service.get_all("Equity Dividends", user_email=request.user_email, role=request.user_role)
    existing = next((d for d in all_divs if d["id"] == row_id), None)
    if not existing:
        return jsonify({"error": "Dividend not found"}), 404

    # Update the linked capital flow if present
    capital_flow_id = existing.get("capital_flow_id")
    if capital_flow_id:
        cf_update = {
            "date": data.get("date", existing["date"]),
            "amount": amount,
            "type": "Withdrawal",
            "category": "Equity/Commodity",
            "remarks": f"{existing['name']} dividend",
        }
        db_service.update_row("Capital Flows", int(capital_flow_id), cf_update,
                              user_email=request.user_email, role='admin')

    update_data = {
        "name": existing["name"],
        "date": data.get("date", existing["date"]),
        "amount": amount,
        "remarks": data.get("remarks", existing.get("remarks", "")),
        "capital_flow_id": capital_flow_id,
    }
    result = db_service.update_row("Equity Dividends", row_id, update_data,
                                   user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    db_service._cache.invalidate("rows:Equity Dividends", "rows:Capital Flows")
    return jsonify({"message": "Dividend updated"})


@app.route("/api/equity/dividends/<int:row_id>", methods=["DELETE"])
def delete_equity_dividend(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403

    # Fetch existing dividend to get capital_flow_id before deleting
    all_divs = db_service.get_all("Equity Dividends", user_email=request.user_email, role=request.user_role)
    existing = next((d for d in all_divs if d["id"] == row_id), None)
    if not existing:
        return jsonify({"error": "Dividend not found"}), 404

    capital_flow_id = existing.get("capital_flow_id")

    result = db_service.delete_row("Equity Dividends", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403

    # Delete the linked capital flow
    if capital_flow_id:
        db_service.delete_row("Capital Flows", int(capital_flow_id), user_email=request.user_email, role='admin')

    db_service._cache.invalidate("rows:Equity Dividends", "rows:Capital Flows")
    return jsonify({"message": "Dividend deleted"})


@app.route("/api/equity/tickers", methods=["GET"])
def get_equity_tickers():
    tickers = db_service.get_all_tickers()
    return jsonify(tickers)


@app.route("/api/equity/tickers/<string:name>", methods=["PUT"])
def save_equity_ticker(name):
    data = request.get_json()
    if not data or not data.get("ticker", "").strip():
        return jsonify({"error": "ticker is required"}), 400
    db_service.upsert_ticker(name, data["ticker"].strip())
    return jsonify({"message": "Ticker saved"})


@app.route("/api/equity/prices", methods=["GET"])
def get_equity_prices():
    symbols_param = request.args.get("symbols", "").strip()
    if not symbols_param:
        return jsonify({"error": "symbols parameter required"}), 400
    symbols = [s.strip() for s in symbols_param.split(",") if s.strip()]
    if not symbols:
        return jsonify({}), 200
    prices = _fetch_prices_parallel(symbols)
    try:
        db_service.update_ticker_prices({sym: p for sym, p in prices.items() if p is not None})
    except Exception as e:
        print(f"[equity/prices] Failed to persist prices: {e}")
    return jsonify(prices)


@app.route("/api/mutual-funds/tickers", methods=["GET"])
def get_mf_tickers():
    return jsonify(db_service.get_all_mf_tickers())


@app.route("/api/mutual-funds/tickers/<string:name>", methods=["PUT"])
def save_mf_ticker(name):
    data = request.get_json()
    if not data or not data.get("ticker", "").strip():
        return jsonify({"error": "ticker is required"}), 400
    db_service.upsert_mf_ticker(name, data["ticker"].strip())
    return jsonify({"message": "Ticker saved"})


@app.route("/api/mutual-funds/prices", methods=["GET"])
def get_mf_prices():
    symbols_param = request.args.get("symbols", "").strip()
    if not symbols_param:
        return jsonify({"error": "symbols parameter required"}), 400
    symbols = [s.strip() for s in symbols_param.split(",") if s.strip()]
    if not symbols:
        return jsonify({}), 200
    prices = _fetch_prices_parallel(symbols)
    try:
        db_service.update_mf_ticker_prices({sym: p for sym, p in prices.items() if p is not None})
    except Exception as e:
        print(f"[mutual-funds/prices] Failed to persist prices: {e}")
    return jsonify(prices)


# ── Mutual Funds Endpoints ──

@app.route("/api/mutual-funds", methods=["GET"])
def get_mutual_funds():
    rows = db_service.get_all("Mutual Funds", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/mutual-funds", methods=["POST"])
def add_mutual_fund():
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row("Mutual Funds", data, created_by=request.user_email)
        # Auto-create capital flows for this transaction
        _auto_create_capital_flows("Mutual Funds", data, created_by=request.user_email)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["upserted"]:
        return jsonify({"message": "Existing entry updated", "id": result["id"], "upserted": True}), 200
    return jsonify({"message": "Entry added", "id": result["id"], "upserted": False}), 201


@app.route("/api/mutual-funds/<int:row_id>", methods=["PUT"])
def update_mutual_fund(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.update_row("Mutual Funds", row_id, data, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    if result:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/mutual-funds/<int:row_id>", methods=["DELETE"])
def delete_mutual_fund(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403
    result = db_service.delete_row("Mutual Funds", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403
    if result:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/commodity/tickers", methods=["GET"])
def get_commodity_tickers():
    return jsonify(db_service.get_all_commodity_tickers())


@app.route("/api/commodity/tickers/<string:name>", methods=["PUT"])
def save_commodity_ticker(name):
    data = request.get_json()
    if not data or not data.get("ticker", "").strip():
        return jsonify({"error": "ticker is required"}), 400
    db_service.upsert_commodity_ticker(name, data["ticker"].strip())
    return jsonify({"message": "Ticker saved"})


@app.route("/api/commodity/prices", methods=["GET"])
def get_commodity_prices():
    symbols_param = request.args.get("symbols", "").strip()
    if not symbols_param:
        return jsonify({"error": "symbols parameter required"}), 400
    symbols = [s.strip() for s in symbols_param.split(",") if s.strip()]
    if not symbols:
        return jsonify({}), 200
    prices = _fetch_prices_parallel(symbols)
    try:
        db_service.update_commodity_ticker_prices({sym: p for sym, p in prices.items() if p is not None})
    except Exception as e:
        print(f"[commodity/prices] Failed to persist prices: {e}")
    return jsonify(prices)


@app.route("/api/prices/bulk", methods=["GET"])
def get_prices_bulk():
    """Fetch prices for all three asset classes in parallel in a single HTTP call."""
    equity_param = request.args.get("equity", "").strip()
    mf_param = request.args.get("mf", "").strip()
    commodity_param = request.args.get("commodity", "").strip()

    equity_symbols = [s.strip() for s in equity_param.split(",") if s.strip()] if equity_param else []
    mf_symbols = [s.strip() for s in mf_param.split(",") if s.strip()] if mf_param else []
    commodity_symbols = [s.strip() for s in commodity_param.split(",") if s.strip()] if commodity_param else []

    all_symbols = list(set(equity_symbols + mf_symbols + commodity_symbols))
    all_prices = _fetch_prices_parallel(all_symbols)

    equity_prices = {s: all_prices.get(s) for s in equity_symbols}
    mf_prices = {s: all_prices.get(s) for s in mf_symbols}
    commodity_prices = {s: all_prices.get(s) for s in commodity_symbols}

    # Persist prices asynchronously (fire-and-forget errors)
    try:
        db_service.update_ticker_prices({s: p for s, p in equity_prices.items() if p is not None})
    except Exception as e:
        print(f"[prices/bulk] Failed to persist equity prices: {e}")
    try:
        db_service.update_mf_ticker_prices({s: p for s, p in mf_prices.items() if p is not None})
    except Exception as e:
        print(f"[prices/bulk] Failed to persist mf prices: {e}")
    try:
        db_service.update_commodity_ticker_prices({s: p for s, p in commodity_prices.items() if p is not None})
    except Exception as e:
        print(f"[prices/bulk] Failed to persist commodity prices: {e}")

    return jsonify({"equity": equity_prices, "mf": mf_prices, "commodity": commodity_prices})


@app.route("/api/commodity", methods=["GET"])
def get_commodity():
    rows = db_service.get_all("Commodity", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/commodity", methods=["POST"])
def add_commodity():
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row("Commodity", data, created_by=request.user_email)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["upserted"]:
        return jsonify({"message": "Existing entry updated", "id": result["id"], "upserted": True}), 200
    return jsonify({"message": "Entry added", "id": result["id"], "upserted": False}), 201


@app.route("/api/commodity/<int:row_id>", methods=["PUT"])
def update_commodity(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.update_row("Commodity", row_id, data, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    if result:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/commodity/<int:row_id>", methods=["DELETE"])
def delete_commodity(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403
    result = db_service.delete_row("Commodity", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403
    if result:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# â”€â”€ P2P Endpoints â”€â”€

@app.route("/api/p2p", methods=["GET"])
def get_p2p():
    rows = db_service.get_all("P2P", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/p2p", methods=["POST"])
def add_p2p():
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row("P2P", data, created_by=request.user_email)
        # Auto-create capital flows for this transaction
        _auto_create_capital_flows("P2P", data, created_by=request.user_email)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["upserted"]:
        return jsonify({"message": "Existing entry updated", "id": result["id"], "upserted": True}), 200
    return jsonify({"message": "Entry added", "id": result["id"], "upserted": False}), 201


@app.route("/api/p2p/<int:row_id>", methods=["PUT"])
def update_p2p(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.update_row("P2P", row_id, data, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    if result:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/p2p/<int:row_id>", methods=["DELETE"])
def delete_p2p(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403
    # Get the lending_id before deleting so we can cascade-delete repayments
    rows = db_service.get_all("P2P")
    lending_id = None
    for r in rows:
        if r.get("id") == row_id:
            lending_id = r.get("lending_id")
            break
    result = db_service.delete_row("P2P", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403
    if result:
        # Cascade-delete all repayments with this lending_id
        if lending_id:
            repayments = db_service.get_all("P2P Repayments")
            # Delete in reverse order so row indices don't shift
            to_delete = [r["id"] for r in repayments if r.get("lending_id") == lending_id]
            for rid in sorted(to_delete, reverse=True):
                db_service.delete_row("P2P Repayments", rid)
            # Cascade-delete auto-created escrow deposits for this lending
            escrow_rows = db_service.get_all("P2P Escrow")
            escrow_to_delete = [
                r["id"] for r in escrow_rows
                if str(r.get("remarks", "")).startswith(f"Auto: {lending_id}")
            ]
            for rid in sorted(escrow_to_delete, reverse=True):
                db_service.delete_row("P2P Escrow", rid)
        return jsonify({"message": "Entry and related repayments deleted"})
    return jsonify({"error": "Row not found"}), 404


# â”€â”€ P2P Repayments Endpoints â”€â”€

@app.route("/api/p2p-repayments", methods=["GET"])
def get_p2p_repayments():
    rows = db_service.get_all("P2P Repayments", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/p2p-repayments", methods=["POST"])
def add_p2p_repayment():
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row("P2P Repayments", data, created_by=request.user_email)
        # Auto-create capital flows for this transaction
        _auto_create_capital_flows("P2P Repayments", data, created_by=request.user_email)
        return jsonify({"message": "Repayment added", "id": result["id"]}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/p2p-repayments/<int:row_id>", methods=["PUT"])
def update_p2p_repayment(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.update_row("P2P Repayments", row_id, data, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    if result:
        return jsonify({"message": "Repayment updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/p2p-repayments/<int:row_id>", methods=["DELETE"])
def delete_p2p_repayment(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403
    result = db_service.delete_row("P2P Repayments", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403
    if result:
        return jsonify({"message": "Repayment deleted"})
    return jsonify({"error": "Row not found"}), 404


# ── P2P Escrow Endpoints ──

@app.route("/api/p2p-escrow", methods=["GET"])
def get_p2p_escrow():
    rows = db_service.get_all("P2P Escrow", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/p2p-escrow", methods=["POST"])
def add_p2p_escrow():
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.add_row("P2P Escrow", data, created_by=request.user_email)
    return jsonify({"message": "Escrow transaction added", "id": result["id"]}), 201


@app.route("/api/p2p-escrow/<int:row_id>", methods=["PUT"])
def update_p2p_escrow(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.update_row("P2P Escrow", row_id, data, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    if result:
        return jsonify({"message": "Escrow transaction updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/p2p-escrow/<int:row_id>", methods=["DELETE"])
def delete_p2p_escrow(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403
    result = db_service.delete_row("P2P Escrow", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403
    if result:
        return jsonify({"message": "Escrow transaction deleted"})
    return jsonify({"error": "Row not found"}), 404


# ── P2P LenDen Statement Import ──

@app.route("/api/p2p/parse-statement", methods=["POST"])
def parse_lenden_statement():
    """Parse a LenDen Excel statement and return suggested repayment postings."""
    if request.user_role == 'guest':
        return jsonify({"error": "Permission denied"}), 403
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    import io, re
    try:
        import openpyxl
    except ImportError:
        return jsonify({"error": "openpyxl not installed on server"}), 500

    file = request.files['file']
    try:
        wb = openpyxl.load_workbook(io.BytesIO(file.read()), data_only=True)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
    except Exception as e:
        return jsonify({"error": f"Failed to read Excel: {str(e)}"}), 400

    # --- Parse header section ---
    from_date = None
    to_date = None
    data_header_row = None
    for i, row in enumerate(rows):
        first = str(row[0]).strip() if row[0] else ""
        if first == "From Date" and row[1]:
            from_date = str(row[1]).strip()
        elif first == "To Date" and row[1]:
            to_date = str(row[1]).strip()
        elif first == "Order ID" and row[1] == "Loan ID":
            data_header_row = i
            break

    if data_header_row is None:
        return jsonify({"error": "Could not find loan data table in statement"}), 400

    # Map headers to column indices
    headers = [str(c).strip() if c else "" for c in rows[data_header_row]]
    def col(name):
        try: return headers.index(name)
        except ValueError: return None

    idx = {
        "order_id":         col("Order ID"),
        "loan_id":          col("Loan ID"),
        "disbursement_date":col("Disbursement Date"),
        "disbursed_amount": col("Disbursed Amount (₹)"),
        "loan_status":      col("Loan Status"),
        "principal_recv":   col("Principal Received (₹)"),
        "interest_recv":    col("Interest Received (₹)"),
        "platform_fee":     col("Platform Fee (₹)"),
        "total_recv":       col("Total Amount Received (₹)"),
        "closure_date":     col("Loan Closure/NPA Date"),
    }

    def safe_float(val):
        try: return round(float(val or 0), 4)
        except: return 0.0

    def parse_date_dd_mm_yyyy(s):
        """Convert DD/MM/YYYY → YYYY-MM-DD."""
        if not s: return None
        s = str(s).strip()
        m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
        if m: return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}"
        return s  # already in YYYY-MM-DD or unexpected format

    # Parse date range from statement
    from_dt = parse_date_dd_mm_yyyy(from_date) or from_date
    to_dt   = parse_date_dd_mm_yyyy(to_date)   or to_date

    # --- Load existing P2P data from DB ---
    p2p_entries   = db_service.get_all("P2P", user_email=request.user_email, role=request.user_role)
    p2p_repayments = db_service.get_all("P2P Repayments", user_email=request.user_email, role=request.user_role)

    # Build lookup: loan_id → lending entry (case-insensitive)
    loan_id_to_entry = {}
    for e in p2p_entries:
        lid = (e.get("loan_id") or "").strip().upper()
        if lid:
            loan_id_to_entry[lid] = e

    # Build existing repayment sums per lending_id
    rep_sums = {}  # lending_id → {principal, interest, platform_fee}
    for r in p2p_repayments:
        lid = r.get("lending_id", "")
        if lid not in rep_sums:
            rep_sums[lid] = {"principal": 0.0, "interest": 0.0, "platform_fee": 0.0}
        rep_sums[lid]["principal"]    += safe_float(r.get("principal"))
        rep_sums[lid]["interest"]     += safe_float(r.get("interest"))
        rep_sums[lid]["platform_fee"] += safe_float(r.get("platform_fee"))

    today = __import__("datetime").date.today().isoformat()

    suggested = []
    warnings_list = []

    for row in rows[data_header_row + 1:]:
        if not any(row):
            continue
        loan_id = str(row[idx["loan_id"]] or "").strip() if idx["loan_id"] is not None else ""
        if not loan_id:
            continue

        disbursement_date = parse_date_dd_mm_yyyy(row[idx["disbursement_date"]]) if idx["disbursement_date"] is not None else None

        stmt_principal   = safe_float(row[idx["principal_recv"]]   if idx["principal_recv"]   is not None else 0)
        stmt_interest    = safe_float(row[idx["interest_recv"]]    if idx["interest_recv"]    is not None else 0)
        stmt_platform_fee= safe_float(row[idx["platform_fee"]]     if idx["platform_fee"]     is not None else 0)
        stmt_total       = safe_float(row[idx["total_recv"]]       if idx["total_recv"]       is not None else 0)
        stmt_status      = str(row[idx["loan_status"]] or "").strip().upper() if idx["loan_status"] is not None else ""
        stmt_closure_date= str(row[idx["closure_date"]] or "").strip() if idx["closure_date"] is not None else None

        # Map statement status → DB status
        status_map = {"ACTIVE": "Active", "CLOSED": "Closed", "NPA": "Defaulted"}
        db_status = status_map.get(stmt_status, stmt_status.capitalize())

        entry = loan_id_to_entry.get(loan_id.upper())
        if not entry:
            warnings_list.append({
                "type": "unmatched",
                "loan_id": loan_id,
                "message": f"Loan ID '{loan_id}' not found in your P2P entries. Add this lending entry first."
            })
            continue

        lending_id = entry.get("lending_id", "")
        existing = rep_sums.get(lending_id, {"principal": 0.0, "interest": 0.0, "platform_fee": 0.0})

        delta_principal    = round(stmt_principal    - existing["principal"],    4)
        delta_interest     = round(stmt_interest     - existing["interest"],     4)
        delta_platform_fee = round(stmt_platform_fee - existing["platform_fee"], 4)
        delta_total        = round(delta_principal + delta_interest, 4)  # fee not in capital flow

        # Status change warning
        current_status = (entry.get("status") or "").strip()
        if db_status and db_status != current_status:
            warnings_list.append({
                "type": "status_change",
                "loan_id": loan_id,
                "lending_id": lending_id,
                "entry_id": entry.get("id"),
                "old_status": current_status,
                "new_status": db_status,
                "message": f"Loan '{loan_id}': status in DB is '{current_status}' but statement shows '{db_status}'"
            })

        if delta_total == 0 and delta_principal == 0 and delta_interest == 0 and delta_platform_fee == 0:
            continue  # Nothing new to post

        suggested.append({
            "loan_id": loan_id,
            "lending_id": lending_id,
            "entry_id": entry.get("id"),
            "platform": entry.get("platform", ""),
            "name": entry.get("name", ""),
            "date": today,
            "stmt_principal":    stmt_principal,
            "stmt_interest":     stmt_interest,
            "stmt_platform_fee": stmt_platform_fee,
            "already_posted_principal":    existing["principal"],
            "already_posted_interest":     existing["interest"],
            "already_posted_platform_fee": existing["platform_fee"],
            "delta_principal":    delta_principal,
            "delta_interest":     delta_interest,
            "delta_platform_fee": delta_platform_fee,
            "delta_total":        delta_total,
            "remarks": f"LenDen statement import – as on {to_dt or today}",
            "selected": True,
        })

    return jsonify({
        "to_date": to_dt,
        "from_date": from_dt,
        "suggested": suggested,
        "warnings": warnings_list,
    })


@app.route("/api/p2p/import-statement", methods=["POST"])
def import_lenden_statement():
    """Commit selected repayment rows from a LenDen statement parse result."""
    if request.user_role == 'guest':
        return jsonify({"error": "Permission denied"}), 403
    data = request.get_json()
    if not data or "rows" not in data:
        return jsonify({"error": "No rows provided"}), 400

    today = __import__("datetime").date.today().isoformat()
    results = []

    for row in data["rows"]:
        loan_id     = row.get("loan_id", "")
        lending_id  = row.get("lending_id", "")
        platform    = row.get("platform", "LenDen")
        to_date     = row.get("to_date", today)
        delta_principal    = float(row.get("delta_principal", 0) or 0)
        delta_interest     = float(row.get("delta_interest", 0) or 0)
        delta_platform_fee = float(row.get("delta_platform_fee", 0) or 0)
        delta_total        = round(delta_principal + delta_interest, 4)
        remarks     = row.get("remarks") or f"LenDen statement import – as on {to_date}"
        entry_id    = row.get("entry_id")
        new_status  = row.get("new_status")  # optional status update

        if delta_total == 0 and delta_principal == 0 and delta_interest == 0 and delta_platform_fee == 0:
            results.append({"loan_id": loan_id, "success": True, "skipped": True, "reason": "nothing_to_post"})
            continue

        try:
            # 1. Insert p2p_repayments row
            repayment = {
                "lending_id":   lending_id,
                "date":         today,
                "principal":    delta_principal,
                "interest":     delta_interest,
                "platform_fee": delta_platform_fee,
                "amount":       round(delta_principal + delta_interest + delta_platform_fee, 4),
                "source":       "statement_import",
                "remarks":      remarks,
            }
            rep_result = db_service.add_row("P2P Repayments", repayment, created_by=request.user_email)

            # 2. Insert p2p_escrow (Repayment type)
            escrow_entry = {
                "date":     today,
                "type":     "Repayment",
                "amount":   delta_total,
                "platform": platform,
                "remarks":  f"LenDen repayment – {loan_id}",
            }
            db_service.add_row("P2P Escrow", escrow_entry, created_by=request.user_email)

            # 3. Insert capital_flows (Withdrawal)
            capital_flow = {
                "date":     today,
                "amount":   delta_total,
                "type":     "Withdrawal",
                "category": "P2P",
                "remarks":  f"LenDen repayment – {loan_id}",
            }
            db_service.add_row("Capital Flows", capital_flow, created_by=request.user_email)

            # 4. Update lending status if changed
            if new_status and entry_id:
                db_service.update_row("P2P", entry_id, {"status": new_status},
                                      user_email=request.user_email, role=request.user_role)

            results.append({"loan_id": loan_id, "success": True, "repayment_id": rep_result.get("id")})
        except Exception as e:
            results.append({"loan_id": loan_id, "success": False, "error": str(e)})

    return jsonify({"results": results})


# ── Fixed Deposits Endpoints ──

@app.route("/api/fixed-deposits", methods=["GET"])
def get_fixed_deposits():
    rows = db_service.get_all("Fixed Deposits", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/fixed-deposits", methods=["POST"])
def add_fixed_deposit():
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    try:
        result = db_service.add_row("Fixed Deposits", data, created_by=request.user_email)
        if not result.get("upserted"):
            _auto_create_capital_flows("Fixed Deposits", data, created_by=request.user_email)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["upserted"]:
        return jsonify({"message": "Existing entry updated", "id": result["id"], "upserted": True}), 200
    return jsonify({"message": "Entry added", "id": result["id"], "upserted": False}), 201


@app.route("/api/fixed-deposits/<int:row_id>", methods=["PUT"])
def update_fixed_deposit(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.update_row("Fixed Deposits", row_id, data, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    if result:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/fixed-deposits/<int:row_id>", methods=["DELETE"])
def delete_fixed_deposit(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403
    result = db_service.delete_row("Fixed Deposits", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403
    if result:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# â”€â”€ Summary Endpoint â”€â”€

@app.route("/api/summary", methods=["GET"])
def get_summary():
    summary = db_service.get_summary(user_email=request.user_email, role=request.user_role)
    return jsonify(summary)



def _compute_unrealized_pnl_data(eq_rows, fx_rows, eq_tickers, mf_rows, mf_tickers, cmd_rows, cmd_tickers):
    """Pure function: compute unrealized P&L from pre-fetched data."""
    def cat():
        return {"unrealized": 0.0, "total_cost": 0.0, "has_prices": False}
    cats = {"equity_india": cat(), "equity_usa": cat(), "mutual_funds": cat(), "commodity": cat()}

    usd_inr_rate = 0.0
    for fx in fx_rows:
        rate = float(fx.get("rate") or 0)
        if rate > 0:
            usd_inr_rate = rate

    eq_holdings = {}
    eq_market = {}
    for r in eq_rows:
        name = r.get("name", "")
        qty = float(r.get("quantity") or 0)
        val = float(r.get("value") or 0)
        val_usd = float(r.get("value_usd") or 0)
        bs = r.get("buy_sell", "Buy")
        market = r.get("market", "India")
        if name not in eq_holdings:
            eq_holdings[name] = {"buy_qty": 0.0, "buy_val_inr": 0.0, "buy_val_usd": 0.0, "sell_qty": 0.0}
            eq_market[name] = market
        if bs == "Buy":
            eq_holdings[name]["buy_qty"] += qty
            eq_holdings[name]["buy_val_inr"] += val
            eq_holdings[name]["buy_val_usd"] += val_usd
        else:
            eq_holdings[name]["sell_qty"] += qty
    for name, h in eq_holdings.items():
        net_qty = h["buy_qty"] - h["sell_qty"]
        if net_qty <= 0:
            continue
        t = eq_tickers.get(name, {})
        price = t.get("price") if isinstance(t, dict) else None
        if not price or price <= 0:
            continue
        market = eq_market.get(name, "India")
        if market == "USA":
            if usd_inr_rate <= 0:
                continue
            avg_cost_usd = h["buy_val_usd"] / h["buy_qty"] if h["buy_qty"] > 0 and h["buy_val_usd"] > 0 else (
                (h["buy_val_inr"] / h["buy_qty"] / usd_inr_rate) if h["buy_qty"] > 0 else 0
            )
            net_cost_usd = avg_cost_usd * net_qty
            pnl_inr = (price * net_qty - net_cost_usd) * usd_inr_rate
            cost_inr = net_cost_usd * usd_inr_rate
            cats["equity_usa"]["unrealized"] += pnl_inr
            cats["equity_usa"]["total_cost"] += cost_inr
            cats["equity_usa"]["has_prices"] = True
        else:
            avg_cost = h["buy_val_inr"] / h["buy_qty"] if h["buy_qty"] > 0 else 0
            net_cost = avg_cost * net_qty
            cats["equity_india"]["unrealized"] += price * net_qty - net_cost
            cats["equity_india"]["total_cost"] += net_cost
            cats["equity_india"]["has_prices"] = True

    mf_holdings = {}
    for r in mf_rows:
        name = r.get("name", "")
        bq = float(r.get("buy_quantity") or 0)
        bv = float(r.get("buy_value") or 0)
        sq = float(r.get("sell_quantity") or 0)
        if name not in mf_holdings:
            mf_holdings[name] = {"buy_qty": 0.0, "buy_val": 0.0, "sell_qty": 0.0}
        mf_holdings[name]["buy_qty"] += bq
        mf_holdings[name]["buy_val"] += bv
        mf_holdings[name]["sell_qty"] += sq
    for name, h in mf_holdings.items():
        net_qty = h["buy_qty"] - h["sell_qty"]
        if net_qty <= 0:
            continue
        avg_cost = h["buy_val"] / h["buy_qty"] if h["buy_qty"] > 0 else 0
        net_cost = avg_cost * net_qty
        t = mf_tickers.get(name, {})
        price = t.get("price") if isinstance(t, dict) else None
        if price and price > 0:
            cats["mutual_funds"]["unrealized"] += price * net_qty - net_cost
            cats["mutual_funds"]["total_cost"] += net_cost
            cats["mutual_funds"]["has_prices"] = True

    cmd_holdings = {}
    for r in cmd_rows:
        name = r.get("name", "")
        bq = float(r.get("buy_quantity") or 0)
        bv = float(r.get("buy_value") or 0)
        sq = float(r.get("sell_quantity") or 0)
        if name not in cmd_holdings:
            cmd_holdings[name] = {"buy_qty": 0.0, "buy_val": 0.0, "sell_qty": 0.0}
        cmd_holdings[name]["buy_qty"] += bq
        cmd_holdings[name]["buy_val"] += bv
        cmd_holdings[name]["sell_qty"] += sq
    for name, h in cmd_holdings.items():
        net_qty = h["buy_qty"] - h["sell_qty"]
        if net_qty <= 0:
            continue
        avg_cost = h["buy_val"] / h["buy_qty"] if h["buy_qty"] > 0 else 0
        net_cost = avg_cost * net_qty
        t = cmd_tickers.get(name, {})
        price = t.get("price") if isinstance(t, dict) else None
        if price and price > 0:
            cats["commodity"]["unrealized"] += price * net_qty - net_cost
            cats["commodity"]["total_cost"] += net_cost
            cats["commodity"]["has_prices"] = True

    by_category = {}
    total_unrealized = 0.0
    total_cost = 0.0
    has_prices = False
    for key, c in cats.items():
        u = round(c["unrealized"], 2)
        tc = round(c["total_cost"], 2)
        pct = round(u / tc * 100, 2) if tc > 0 else 0.0
        by_category[key] = {"unrealized": u, "total_cost": tc, "unrealized_pct": pct, "has_prices": c["has_prices"]}
        total_unrealized += u
        total_cost += tc
        if c["has_prices"]:
            has_prices = True

    return {
        "unrealized": round(total_unrealized, 2),
        "unrealized_pct": round(total_unrealized / total_cost * 100, 2) if total_cost > 0 else 0.0,
        "total_cost": round(total_cost, 2),
        "has_prices": has_prices,
        "by_category": by_category,
    }


@app.route("/api/unrealized-pnl", methods=["GET"])
def get_unrealized_pnl():
    """Compute unrealized P&L per category from stored ticker prices."""
    try:
        eq_tickers = db_service.get_all_tickers()
        eq_rows = db_service.get_all("Equity")
        fx_rows = db_service.get_all("Forex")
        mf_tickers = db_service.get_all_mf_tickers()
        mf_rows = db_service.get_all("Mutual Funds")
        cmd_tickers = db_service.get_all_commodity_tickers()
        cmd_rows = db_service.get_all("Commodity")
        result = _compute_unrealized_pnl_data(eq_rows, fx_rows, eq_tickers, mf_rows, mf_tickers, cmd_rows, cmd_tickers)
    except Exception as e:
        print(f"[unrealized-pnl] Error: {e}")
        result = {
            "unrealized": 0.0, "unrealized_pct": 0.0, "total_cost": 0.0, "has_prices": False,
            "by_category": {k: {"unrealized": 0.0, "total_cost": 0.0, "unrealized_pct": 0.0, "has_prices": False}
                            for k in ("equity_india", "equity_usa", "mutual_funds", "commodity")}
        }
    return jsonify(result)



@app.route("/api/bulk-load", methods=["GET"])
def bulk_load():
    """Fetch all dashboard data in parallel using a single backend request."""
    # Capture request context values BEFORE entering threads — Flask's request
    # proxy is thread-local and is NOT available inside ThreadPoolExecutor workers.
    _user_email = request.user_email
    _user_role = request.user_role
    tasks = {
        "summary":              lambda: db_service.get_summary(user_email=_user_email, role=_user_role),
        "equity":               lambda: db_service.get_all("Equity", user_email=_user_email, role=_user_role),
        "commodity":            lambda: db_service.get_all("Commodity", user_email=_user_email, role=_user_role),
        "mutual_funds":         lambda: db_service.get_all("Mutual Funds", user_email=_user_email, role=_user_role),
        "p2p":                  lambda: db_service.get_all("P2P", user_email=_user_email, role=_user_role),
        "p2p_repayments":       lambda: db_service.get_all("P2P Repayments", user_email=_user_email, role=_user_role),
        "fixed_deposits":       lambda: db_service.get_all("Fixed Deposits", user_email=_user_email, role=_user_role),
        "forex":                lambda: db_service.get_all("Forex", user_email=_user_email, role=_user_role),
        "capital_flows_summary": lambda: db_service.get_capital_flows_summary(user_email=_user_email, role=_user_role),
        "capital_flows":        lambda: db_service.get_all("Capital Flows", user_email=_user_email, role=_user_role),
        "equity_tickers":       lambda: db_service.get_all_tickers(),
        "mf_tickers":           lambda: db_service.get_all_mf_tickers(),
        "commodity_tickers":    lambda: db_service.get_all_commodity_tickers(),
        "equity_dividends":     lambda: db_service.get_all("Equity Dividends", user_email=_user_email, role=_user_role),
    }
    result = {}
    with ThreadPoolExecutor(max_workers=len(tasks)) as executor:
        futures = {executor.submit(fn): key for key, fn in tasks.items()}
        for future in as_completed(futures):
            key = futures[future]
            try:
                result[key] = future.result()
            except Exception as e:
                result[key] = None
                print(f"[bulk-load] Error fetching {key}: {e}")

    try:
        result["unrealized_pnl"] = _compute_unrealized_pnl_data(
            result.get("equity") or [],
            result.get("forex") or [],
            result.get("equity_tickers") or {},
            result.get("mutual_funds") or [],
            result.get("mf_tickers") or {},
            result.get("commodity") or [],
            result.get("commodity_tickers") or {},
        )
    except Exception as e:
        print(f"[bulk-load] Error computing unrealized PnL: {e}")
        result["unrealized_pnl"] = None

    return jsonify(result)


# â”€â”€ Forex Endpoints â”€â”€

@app.route("/api/forex", methods=["GET"])
def get_forex():
    rows = db_service.get_all("Forex", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/forex", methods=["POST"])
def add_forex():
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to add entries"}), 403
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
    result = db_service.add_row("Forex", data, created_by=request.user_email)
    _auto_create_capital_flows("Forex", data, created_by=request.user_email)
    return jsonify({"message": "Entry added", "id": result["id"]}), 201


@app.route("/api/forex/<int:row_id>", methods=["PUT"])
def update_forex(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
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
    result = db_service.update_row("Forex", row_id, data, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    if result:
        _auto_create_capital_flows("Forex", data)
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/forex/<int:row_id>", methods=["DELETE"])
def delete_forex(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403
    result = db_service.delete_row("Forex", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403
    if result:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


# ── Capital Flows Endpoints ──

@app.route("/api/capital-flows", methods=["GET"])
def get_capital_flows():
    rows = db_service.get_all("Capital Flows", user_email=request.user_email, role=request.user_role)
    return jsonify(rows)


@app.route("/api/capital-flows", methods=["POST"])
def add_capital_flow():
    return _handle_add("Capital Flows")


@app.route("/api/capital-flows/<int:row_id>", methods=["PUT"])
def update_capital_flow(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to update entries"}), 403
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    result = db_service.update_row("Capital Flows", row_id, data, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only edit your own entries"}), 403
    if result:
        return jsonify({"message": "Entry updated"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/capital-flows/<int:row_id>", methods=["DELETE"])
def delete_capital_flow(row_id):
    if request.user_role == 'guest':
        return jsonify({"error": "Guests do not have permission to delete entries"}), 403
    result = db_service.delete_row("Capital Flows", row_id, user_email=request.user_email, role=request.user_role)
    if result == 'forbidden':
        return jsonify({"error": "You can only delete your own entries"}), 403
    if result:
        return jsonify({"message": "Entry deleted"})
    return jsonify({"error": "Row not found"}), 404


@app.route("/api/capital-flows/summary", methods=["GET"])
def get_capital_flows_summary():
    summary = db_service.get_capital_flows_summary(user_email=request.user_email, role=request.user_role)
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
    role = check_allowlist(email)  # now returns role string or None
    if not role:
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
            "role": role,
        }
    }), 200


@app.route("/api/auth/verify", methods=["GET"])
@require_auth
def verify_auth():
    """Verify token validity"""
    return jsonify({"email": request.user_email, "role": getattr(request, 'user_role', 'user')}), 200


@app.route("/api/auth/me", methods=["GET"])
def get_me():
    """Returns current user info including role"""
    conn = db_service._connect()
    cursor = conn.execute(
        "SELECT name, picture FROM users WHERE email = ? LIMIT 1",
        (request.user_email,)
    )
    row = cursor.fetchone()
    conn.close()
    return jsonify({
        "email": request.user_email,
        "role": getattr(request, 'user_role', 'user'),
        "name": row["name"] if row else None,
        "picture": row["picture"] if row else None,
    }), 200


@app.route("/api/name-suggestions", methods=["GET"])
@require_auth
def name_suggestions():
    """Return distinct names from each table for autocomplete/autofill.
    No financial data (amounts, quantities, prices) is included.
    Available to all authenticated users regardless of role."""
    return jsonify({
        "equity":         db_service.get_distinct_names("Equity"),
        "equity_meta":    db_service.get_name_meta_map("Equity", "name", ["market", "market_cap", "sector"]),
        "mutual_funds":   db_service.get_distinct_names("Mutual Funds"),
        "mf_meta":        db_service.get_name_meta_map("Mutual Funds", "name", ["category", "fund_type"]),
        "commodity":      db_service.get_distinct_names("Commodity"),
        "commodity_meta": db_service.get_name_meta_map("Commodity", "name", ["commodity"]),
        "fixed_deposits": db_service.get_distinct_names("Fixed Deposits"),
        "fd_meta":        db_service.get_name_meta_map("Fixed Deposits", "bank_name", ["platform"]),
        "p2p":            db_service.get_distinct_names("P2P"),
    })


@app.route("/api/auth/allowlist", methods=["GET"])
@require_auth
def get_allowlist_endpoint():
    """Get allowlist (admin only)"""
    if getattr(request, 'user_role', None) != 'admin':
        return jsonify({"error": "Admin access required"}), 403
    allowlist = get_allowlist()
    return jsonify({"allowlist": allowlist}), 200


@app.route("/api/auth/allowlist", methods=["POST"])
@require_auth
def add_allowlist_entry():
    """Add email to allowlist (admin only)"""
    if getattr(request, 'user_role', None) != 'admin':
        return jsonify({"error": "Admin access required"}), 403
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip()
    role = data.get("role", "user").strip()
    if role not in ('admin', 'user', 'guest'):
        return jsonify({"error": "Invalid role. Must be admin, user, or guest"}), 400
    
    if not email:
        return jsonify({"error": "Email is required"}), 400
    
    if add_to_allowlist(email, role=role):
        return jsonify({"message": f"Added {email} to allowlist as {role}"}), 201
    else:
        return jsonify({"error": "Failed to add to allowlist"}), 500


@app.route("/api/auth/allowlist/<path:email>", methods=["PATCH"])
@require_auth
def update_allowlist_role(email):
    """Update role for an allowlist entry (admin only)"""
    if getattr(request, 'user_role', None) != 'admin':
        return jsonify({"error": "Admin access required"}), 403
    data = request.get_json(silent=True) or {}
    role = data.get("role", "").strip()
    if role not in ('admin', 'user', 'guest'):
        return jsonify({"error": "Invalid role. Must be admin, user, or guest"}), 400
    if update_user_role(email, role):
        return jsonify({"message": f"Updated {email} role to {role}"}), 200
    return jsonify({"error": "Failed to update role"}), 500


@app.route("/api/auth/allowlist/<path:email>", methods=["DELETE"])
@require_auth
def delete_allowlist_entry(email):
    """Remove user from allowlist (admin only)"""
    if getattr(request, 'user_role', None) != 'admin':
        return jsonify({"error": "Admin access required"}), 403
    if remove_from_allowlist(email):
        return jsonify({"message": f"Removed {email} from allowlist"}), 200
    return jsonify({"error": "User not found in allowlist"}), 404





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
    app.run(debug=True, port=5002, host="0.0.0.0")
