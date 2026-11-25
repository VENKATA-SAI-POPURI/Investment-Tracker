import glob
import math
import os
import random
import shutil
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("JWT_SECRET", "test-secret-that-is-long-enough-for-hs256")
for var in ("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "GROQ_API_KEY", "GEMINI_API_KEY"):
    os.environ.pop(var, None)
# Set (not just removed) so a developer's .env can't fill them in: push stays off, the job has a known token
os.environ.update(VAPID_PUBLIC_KEY="", VAPID_PRIVATE_KEY="", JOB_TOKEN="test-job-token")

from tracker import create_app  # noqa: E402
from tracker import prices as px  # noqa: E402
from tracker.db import SqliteDatabase  # noqa: E402
from tracker.security import issue_token  # noqa: E402

ADMIN, USER, GUEST, OTHER = "admin@example.com", "user@example.com", "guest@example.com", "other@example.com"
BACKUP_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "backups")


@pytest.fixture
def app(tmp_path):
    db = SqliteDatabase(str(tmp_path / "test.db"))
    application = create_app(db)
    for email, role in ((ADMIN, "admin"), (USER, "user"), (GUEST, "guest"), (OTHER, "user")):
        db.execute("INSERT INTO allowlist (email, added_date, role) VALUES (?, '2026-01-01', ?)", (email, role))
    application.testing = True
    return application


@pytest.fixture
def client(app):
    return app.test_client()


def auth(email, role, view_as=None):
    h = {"Authorization": f"Bearer {issue_token(email, role)}"}
    if view_as:
        h["X-View-As"] = view_as
    return h


def walk(start_price: float, days: int, drift: float = 0.0005, vol: float = 0.015, seed: int = 1, end: date | None = None):
    """Weekday closes ending today (or `end`), a geometric random walk."""
    rng = random.Random(seed)
    end = end or date.today()
    out, p = [], start_price
    day = end - timedelta(days=int(days * 1.45))
    while day <= end:
        if day.weekday() < 5:
            p *= math.exp(rng.gauss(drift, vol))
            out.append((day.isoformat(), round(p, 4)))
        day += timedelta(days=1)
    return out


@pytest.fixture
def offline_prices(monkeypatch):
    """No network: synthetic daily history for the test symbols and benchmarks, and every live quote fails."""
    hist = {"TCS.NS": walk(3000, 800, seed=5), "INFY.NS": walk(1500, 800, seed=6), "^NSEI": walk(24000, 800, vol=0.009, seed=7),
            "USDINR=X": walk(84, 800, drift=0.0, vol=0.003, seed=8), "^CRSLDX": walk(22000, 800, vol=0.009, seed=9),
            "^GSPC": walk(5000, 800, vol=0.01, seed=10), "GOLDBEES.NS": walk(60, 800, vol=0.008, seed=11)}
    monkeypatch.setattr(px, "ensure_history", lambda db, syms, start, max_age_hours=12: {s: hist.get(s, []) for s in syms})
    monkeypatch.setattr(px, "history_fast", lambda db, syms, start, max_age_hours=12, on_refreshed=None: {s: hist.get(s, []) for s in syms})
    monkeypatch.setattr(px, "fetch_quotes", lambda syms, timeout=15: {s: None for s in syms})
    return hist


@pytest.fixture
def legacy_copy(tmp_path):
    backups = sorted(glob.glob(os.path.join(BACKUP_DIR, "turso-*.sqlite")))
    if not backups:
        pytest.skip("no legacy backup available")
    dst = tmp_path / "legacy.sqlite"
    shutil.copy(backups[-1], dst)
    return str(dst)
