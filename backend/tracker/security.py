"""Google sign-in, JWT sessions, roles and per-request user scope."""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import wraps

import jwt
import requests
from flask import g, jsonify, request

from .db import Database

ROLES = ("admin", "user", "guest")
TOKEN_DAYS = 180


def jwt_secret() -> str:
    secret = os.environ.get("JWT_SECRET")
    if not secret:
        raise RuntimeError("JWT_SECRET is not configured")
    return secret


def verify_google_token(token: str) -> dict | None:
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    if not client_id:
        print("[auth] GOOGLE_CLIENT_ID not configured")
        return None
    try:
        info = id_token.verify_oauth2_token(token, google_requests.Request(session=requests.Session()), client_id,
                                            clock_skew_in_seconds=10)
    except Exception as e:  # noqa: BLE001
        print(f"[auth] Google token rejected: {e}")
        return None
    if not info.get("email") or not info.get("email_verified"):
        return None
    return {"email": info["email"], "name": info.get("name"), "picture": info.get("picture"), "google_id": info.get("sub")}


def issue_token(email: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"email": email, "role": role, "iat": now, "exp": now + timedelta(days=TOKEN_DAYS)},
                      jwt_secret(), algorithm="HS256")


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, jwt_secret(), algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None


class Directory:
    """Allowlist + user profile access with a short role cache (so revocations apply quickly)."""

    def __init__(self, db: Database, ttl: float = 60):
        self.db = db
        self.ttl = ttl
        self._roles: dict[str, tuple[float, str | None]] = {}
        self._lock = threading.Lock()

    def role(self, email: str) -> str | None:
        with self._lock:
            hit = self._roles.get(email.lower())
            if hit and time.time() - hit[0] < self.ttl:
                return hit[1]
        row = self.db.one("SELECT role FROM allowlist WHERE LOWER(email) = LOWER(?) ORDER BY id LIMIT 1", (email,))
        role = row["role"] if row else None
        with self._lock:
            self._roles[email.lower()] = (time.time(), role)
        return role

    def forget(self, email: str | None = None):
        with self._lock:
            if email:
                self._roles.pop(email.lower(), None)
            else:
                self._roles.clear()

    def list(self) -> list[dict]:
        return self.db.query("SELECT a.email, a.added_date, a.role, u.name, u.picture, u.last_login FROM allowlist a "
                             "LEFT JOIN users u ON LOWER(u.email) = LOWER(a.email) ORDER BY a.added_date DESC")

    def add(self, email: str, role: str):
        if self.db.one("SELECT id FROM allowlist WHERE LOWER(email) = LOWER(?)", (email,)):
            raise ValueError(f"{email} is already on the allowlist")
        self.db.execute("INSERT INTO allowlist (email, added_date, role) VALUES (?, ?, ?)",
                        (email, datetime.now().isoformat(), role))
        self.forget(email)

    def set_role(self, email: str, role: str) -> bool:
        n = self.db.execute("UPDATE allowlist SET role = ? WHERE LOWER(email) = LOWER(?)", (role, email)).rowcount
        self.forget(email)
        return n > 0

    def remove(self, email: str) -> bool:
        n = self.db.execute("DELETE FROM allowlist WHERE LOWER(email) = LOWER(?)", (email,)).rowcount
        self.forget(email)
        return n > 0

    def record_login(self, info: dict):
        now = datetime.now().isoformat()
        if self.db.one("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", (info["email"],)):
            self.db.execute("UPDATE users SET last_login = ?, name = COALESCE(?, name), picture = COALESCE(?, picture) "
                            "WHERE LOWER(email) = LOWER(?)", (now, info.get("name"), info.get("picture"), info["email"]))
        else:
            self.db.execute("INSERT INTO users (email, google_id, name, picture, created_at, last_login) VALUES (?,?,?,?,?,?)",
                            (info["email"], info.get("google_id"), info.get("name"), info.get("picture"), now, now))

    def profile(self, email: str) -> dict:
        return self.db.one("SELECT name, picture FROM users WHERE LOWER(email) = LOWER(?)", (email,)) or {}

    def bootstrap_admin(self, email: str | None):
        """Fresh installs: seed the first admin from ADMIN_EMAIL when the allowlist is empty."""
        if email and not self.db.one("SELECT id FROM allowlist LIMIT 1"):
            self.db.execute("INSERT INTO allowlist (email, added_date, role) VALUES (?, ?, 'admin')",
                            (email, datetime.now().isoformat()))


def authenticate(directory: Directory):
    """before_request hook body: populate g.email / g.role / g.scope or return an error response."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return jsonify({"error": "Missing authorization token"}), 401
    payload = decode_token(header[7:])
    if not payload or not payload.get("email"):
        return jsonify({"error": "Invalid or expired session — please sign in again"}), 401
    role = directory.role(payload["email"])
    if role not in ROLES:
        return jsonify({"error": "Your access has been revoked"}), 401
    g.real_email, g.real_role = payload["email"], role
    g.email, g.role, g.impersonating = payload["email"], role, False
    view_as = request.headers.get("X-View-As", "").strip()
    if view_as and role == "admin" and view_as.lower() != g.email.lower():
        target_role = directory.role(view_as)
        if not target_role:
            return jsonify({"error": f"{view_as} is not on the allowlist"}), 400
        g.email, g.role, g.impersonating = view_as, target_role, True
    # users see their own data; admins and guests see the combined portfolio
    g.scope = g.email if g.role == "user" else None
    return None


def write_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if g.role == "guest":
            return jsonify({"error": "Guests have read-only access"}), 403
        return fn(*a, **kw)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if g.real_role != "admin":
            return jsonify({"error": "Admin access required"}), 403
        return fn(*a, **kw)
    return wrapper
