"""history_fast: reads never wait on the network for data that is already stored."""
import threading
import time
from datetime import date, datetime, timedelta, timezone

from tracker import prices as px
from tracker.db import SqliteDatabase
from tracker.migrations import run_migrations


def db_with(tmp_path, fetched_hours_ago):
    db = SqliteDatabase(str(tmp_path / "h.db"))
    run_migrations(db, log=lambda *_: None)
    stamp = (datetime.now(timezone.utc) - timedelta(hours=fetched_hours_ago)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    db.execute("INSERT INTO price_history (symbol, date, close) VALUES ('X.NS', '2025-01-02', 100)")
    db.execute("INSERT INTO price_meta (symbol, fetched_at, first_date, last_date) VALUES ('X.NS', ?, '2025-01-01', '2025-01-02')", (stamp,))
    return db


def test_stale_history_is_returned_at_once_and_refreshed_in_the_background(tmp_path, monkeypatch):
    db = db_with(tmp_path, fetched_hours_ago=48)
    started, release, done = threading.Event(), threading.Event(), threading.Event()

    def slow_fetch(db_, syms, start, max_age_hours=12):
        started.set()
        release.wait(5)
        return {}
    monkeypatch.setattr(px, "ensure_history", slow_fetch)
    t0 = time.time()
    out = px.history_fast(db, ["X.NS"], date(2025, 1, 1), on_refreshed=done.set)
    assert time.time() - t0 < 1.0 and out["X.NS"] == [("2025-01-02", 100.0)]
    assert started.wait(2)
    # a second read while the refresh runs doesn't start another
    px.history_fast(db, ["X.NS"], date(2025, 1, 1))
    release.set()
    assert done.wait(2)


def test_missing_history_is_fetched_before_answering(tmp_path, monkeypatch):
    db = db_with(tmp_path, fetched_hours_ago=1)
    calls = []
    monkeypatch.setattr(px, "ensure_history", lambda db_, syms, start, max_age_hours=12: calls.append(list(syms)) or {})
    px.history_fast(db, ["X.NS", "NEW.NS"], date(2025, 1, 1))
    assert calls == [["NEW.NS"]]     # X.NS is fresh and covered: no fetch at all
