import os
import jwt
import json
import base64
import requests
from datetime import datetime
from functools import wraps
from flask import request, jsonify
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

# Google OAuth config
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
JWT_SECRET = os.environ.get("JWT_SECRET")
if not JWT_SECRET:
    import warnings
    warnings.warn("JWT_SECRET environment variable is not set — tokens will fail to sign/verify")

# Will be injected from app.py
db_service = None


def set_db_service(service):
    """Inject db_service dependency"""
    global db_service
    db_service = service


def verify_google_token(token):
    """Verify Google OAuth token using Google's public certificates"""
    try:
        if not GOOGLE_CLIENT_ID:
            print("[auth_service] GOOGLE_CLIENT_ID not configured")
            return None

        # Use a session; disable SSL verification only in environments where a corporate
        # proxy intercepts SSL (set GOOGLE_VERIFY_SSL=false in .env for local dev).
        # The token's cryptographic signature is still fully verified against
        # Google's public keys — only the *fetch* of those keys skips SSL.
        import requests as _req
        session = _req.Session()
        session.verify = os.environ.get("GOOGLE_VERIFY_SSL", "true").lower() != "false"
        request_obj = google_requests.Request(session=session)

        idinfo = id_token.verify_oauth2_token(
            token,
            request_obj,
            GOOGLE_CLIENT_ID,
            clock_skew_in_seconds=10
        )

        email = idinfo.get("email")
        if not email:
            print("[auth_service] No email in token")
            return None

        if not idinfo.get("email_verified"):
            print(f"[auth_service] Email not verified: {email}")
            return None

        return {
            "email": email,
            "name": idinfo.get("name"),
            "picture": idinfo.get("picture"),
            "google_id": idinfo.get("sub"),
        }
    except ValueError as e:
        print(f"[auth_service] Token verification failed: {e}")
        return None
    except Exception as e:
        print(f"[auth_service] Token verification error: {e}")
        return None


def check_allowlist(email):
    """Check if email is in allowlist"""
    try:
        conn = db_service._connect()
        cursor = conn.execute(
            "SELECT 1 FROM allowlist WHERE email = ? LIMIT 1",
            (email,)
        )
        result = cursor.fetchone() is not None
        conn.close()
        return result
    except Exception as e:
        print(f"[auth_service] check_allowlist error: {e}")
        return False


def add_to_allowlist(email):
    """Add email to allowlist"""
    try:
        conn = db_service._connect()
        conn.execute(
            "INSERT OR IGNORE INTO allowlist (email, added_date) VALUES (?, ?)",
            (email, datetime.now().isoformat())
        )
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"[auth_service] Error adding to allowlist: {e}")
        return False


def get_allowlist():
    """Get all emails in allowlist"""
    try:
        conn = db_service._connect()
        cursor = conn.execute("SELECT email, added_date FROM allowlist ORDER BY added_date DESC")
        rows = cursor.fetchall()
        conn.close()
        
        result = []
        for row in rows:
            result.append({
                "email": row[0] if isinstance(row, tuple) else row["email"],
                "added_date": row[1] if isinstance(row, tuple) else row["added_date"],
            })
        return result
    except Exception as e:
        print(f"[auth_service] Error getting allowlist: {e}")
        return []


def create_user_session(user_info):
    """Create user in database and return JWT token"""
    try:
        email = user_info["email"]
        
        conn = db_service._connect()
        
        # Check if user exists
        cursor = conn.execute(
            "SELECT id FROM users WHERE email = ? LIMIT 1",
            (email,)
        )
        user_exists = cursor.fetchone() is not None
        
        if not user_exists:
            # Create new user
            conn.execute(
                """INSERT INTO users (email, google_id, name, picture, created_at, last_login) 
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    email,
                    user_info.get("google_id"),
                    user_info.get("name"),
                    user_info.get("picture"),
                    datetime.now().isoformat(),
                    datetime.now().isoformat(),
                )
            )
        else:
            # Update last_login
            conn.execute(
                "UPDATE users SET last_login = ? WHERE email = ?",
                (datetime.now().isoformat(), email)
            )
        
        conn.commit()
        conn.close()
        
        # Create JWT token (no expiry — device is remembered permanently)
        payload = {
            "email": email,
            "iat": datetime.utcnow(),
        }
        
        token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
        return token
    except Exception as e:
        print(f"[auth_service] Error creating session: {e}")
        return None


def verify_jwt_token(token):
    """Verify JWT token and return payload"""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def require_auth(f):
    """Decorator to require JWT authentication on endpoints"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        token = None
        
        # Check Authorization header
        if "Authorization" in request.headers:
            auth_header = request.headers["Authorization"]
            try:
                token = auth_header.split(" ")[1]
            except IndexError:
                return jsonify({"error": "Invalid authorization header"}), 401
        
        if not token:
            return jsonify({"error": "Missing authorization token"}), 401
        
        payload = verify_jwt_token(token)
        if not payload:
            return jsonify({"error": "Invalid or expired token"}), 401
        
        # Inject user email into request
        request.user_email = payload.get("email")
        
        return f(*args, **kwargs)
    
    return decorated_function
