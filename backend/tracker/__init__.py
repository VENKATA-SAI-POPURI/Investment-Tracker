"""Investment Tracker API (v2)."""
from __future__ import annotations

import gzip
import os
import traceback

from flask import Flask, jsonify, request
from flask_cors import CORS

from .db import Database, connect_from_env
from .ledger import Forbidden, Ledger, NotFound, ValidationError
from .migrations import run_migrations
from .security import Directory, authenticate
from .services import Services

DEFAULT_ORIGINS = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
    "https://my-investment-tracker.netlify.app",
]
# The market-scan job authenticates with its own token (X-Job-Token), not a user session
PUBLIC_PATHS = {"/api/ping", "/api/auth/google-login", "/api/jobs/market-scan"}


def create_app(db: Database | None = None) -> Flask:
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        from dotenv import load_dotenv
        load_dotenv(os.path.join(base_dir, ".env"))
    except ImportError:
        pass

    app = Flask(__name__)
    app.json.sort_keys = False
    db = db or connect_from_env(base_dir)
    run_migrations(db)

    directory = Directory(db)
    directory.bootstrap_admin(os.environ.get("ADMIN_EMAIL"))
    ledger = Ledger(db)
    app.extensions.update(db=db, directory=directory, ledger=ledger, services=Services(ledger))

    extra = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    CORS(app, resources={r"/api/*": {"origins": DEFAULT_ORIGINS + extra}},
         allow_headers=["Authorization", "Content-Type", "X-View-As", "X-Portfolio"])

    @app.before_request
    def guard():
        if not request.path.startswith("/api/") or request.method == "OPTIONS" or request.path in PUBLIC_PATHS:
            return None
        return authenticate(directory)

    @app.after_request
    def compress(resp):
        # JSON payloads (the portfolio is ~200 KB) shrink 5-10x; most of the wait on a phone is transfer
        if (resp.status_code < 300 and resp.mimetype == "application/json" and not resp.direct_passthrough
                and "gzip" in request.headers.get("Accept-Encoding", "").lower() and "Content-Encoding" not in resp.headers):
            raw = resp.get_data()
            if len(raw) > 1400:
                resp.set_data(gzip.compress(raw, compresslevel=5))
                resp.headers["Content-Encoding"] = "gzip"
                resp.headers["Content-Length"] = str(len(resp.get_data()))
                resp.vary.add("Accept-Encoding")
        return resp

    @app.get("/api/ping")
    def ping():
        return jsonify({"ok": True, "version": 2})

    @app.errorhandler(ValidationError)
    def bad_request(e):
        return jsonify({"error": str(e)}), 400

    @app.errorhandler(NotFound)
    def not_found(e):
        return jsonify({"error": str(e)}), 404

    @app.errorhandler(Forbidden)
    def forbidden(e):
        return jsonify({"error": str(e) or "Not allowed"}), 403

    @app.errorhandler(404)
    def route_missing(_e):
        return jsonify({"error": "Not found"}), 404

    @app.errorhandler(405)
    def method_missing(_e):
        return jsonify({"error": "Method not allowed"}), 405

    @app.errorhandler(Exception)
    def crash(e):
        traceback.print_exc()
        return jsonify({"error": "Something went wrong on the server. Please try again."}), 500

    from .api import analytics_api, auth_api, ledger_api, markets_api, reports_api
    for bp in (auth_api.bp, ledger_api.bp, analytics_api.bp, reports_api.bp, markets_api.bp):
        app.register_blueprint(bp, url_prefix="/api")
    return app
