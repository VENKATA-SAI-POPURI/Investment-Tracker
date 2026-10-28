"""Maintenance commands. Uses the same env vars as the app (TURSO_* or DATABASE_PATH).

    python manage.py backup [out_dir]   read-only copy of every table into a local .sqlite file
    python manage.py migrate            apply pending schema migrations
    python manage.py verify             re-check legacy -> ledger control totals
    python manage.py status             applied migrations and row counts
"""
import os
import sqlite3
import sys
from datetime import datetime

from dotenv import load_dotenv

from tracker.db import connect_from_env
from tracker.migrations import run_migrations, verify_legacy_import

BASE = os.path.dirname(os.path.abspath(__file__))


def backup(db, out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"backup-{datetime.now():%Y%m%d-%H%M%S}.sqlite")
    out = sqlite3.connect(path)
    objs = db.query("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
                    "AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%'")
    for o in [o for o in objs if o["type"] == "table"]:
        out.execute(o["sql"])
        rows = db.query(f'SELECT * FROM "{o["name"]}"')
        if rows:
            cols = list(rows[0])
            out.executemany(f'INSERT INTO "{o["name"]}" ({",".join(chr(34) + c + chr(34) for c in cols)}) '
                            f'VALUES ({",".join("?" * len(cols))})', [tuple(r[c] for c in cols) for r in rows])
        print(f"  {o['name']:<22} {len(rows):>6} rows")
    for o in [o for o in objs if o["type"] == "index"]:
        try:
            out.execute(o["sql"])
        except sqlite3.Error:
            pass
    out.commit()
    out.close()
    print("saved", path)


def main():
    load_dotenv(os.path.join(BASE, ".env"))
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    db = connect_from_env(BASE)
    print("database:", "Turso" if os.environ.get("TURSO_DATABASE_URL") else os.environ.get("DATABASE_PATH", "investments.db"))
    if cmd == "backup":
        backup(db, sys.argv[2] if len(sys.argv) > 2 else os.path.join(BASE, "..", "backups"))
    elif cmd == "migrate":
        print("applied:", run_migrations(db) or "nothing pending")
    elif cmd == "verify":
        problems = verify_legacy_import(db)
        print("\n".join(problems) if problems else "OK — ledger totals match the legacy tables")
        sys.exit(1 if problems else 0)
    elif cmd == "status":
        if db.table_exists("schema_migrations"):
            for m in db.query("SELECT * FROM schema_migrations ORDER BY version"):
                print(f"  {m['version']:03d} {m['name']:<16} {m['applied_at']}")
        for t in ("instruments", "transactions", "cash_movements", "goals"):
            if db.table_exists(t):
                print(f"  {t:<16} {db.one(f'SELECT COUNT(*) AS n FROM {t}')['n']} rows")
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
