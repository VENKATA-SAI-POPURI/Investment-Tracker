import glob
import os
import shutil
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("JWT_SECRET", "test-secret-that-is-long-enough-for-hs256")
for var in ("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "GROQ_API_KEY", "GEMINI_API_KEY"):
    os.environ.pop(var, None)

from tracker import create_app  # noqa: E402
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


@pytest.fixture
def legacy_copy(tmp_path):
    backups = sorted(glob.glob(os.path.join(BACKUP_DIR, "turso-*.sqlite")))
    if not backups:
        pytest.skip("no legacy backup available")
    dst = tmp_path / "legacy.sqlite"
    shutil.copy(backups[-1], dst)
    return str(dst)
