import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from dotenv import load_dotenv
load_dotenv()
from db_service import DbService
from datetime import date

TURSO_URL = os.environ.get("TURSO_DATABASE_URL")
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")
db_svc = DbService("investments.db", turso_url=TURSO_URL, turso_token=TURSO_TOKEN)

db = db_svc._connect()

rows = db.execute("SELECT id, lending_id, name, amount, tenure, date, status FROM p2p WHERE status = 'Active'").fetchall()
reps = db.execute("SELECT lending_id, date, amount, principal, interest FROM p2p_repayments").fetchall()

rep_map = {}
for r in reps:
    lid = r[0]
    rep_map.setdefault(lid, []).append({'date': r[1], 'amount': r[2], 'principal': r[3], 'interest': r[4]})

TARGET_MONTH = 6
TARGET_YEAR = 2026

print(f"{'Name':<30} {'PP':>10} {'JuneActual':>12} {'Diff':>10}")
print('-' * 70)

total_expected = 0
total_actual = 0

for row in rows:
    lid = row[1]; name = row[2]; amount = row[3]; tenure = row[4]; start_str = row[5]
    if not amount or not tenure or not start_str:
        continue
    pp = amount / tenure
    tenure = int(tenure)

    start = date.fromisoformat(start_str)
    base_offset = 2 if start.day > 20 else 1

    june_due = False
    for i in range(1, tenure + 1):
        raw_month = (start.month - 1) + base_offset + (i - 1)  # 0-indexed
        y = start.year + raw_month // 12
        m = raw_month % 12 + 1  # convert back to 1-indexed
        if m == TARGET_MONTH and y == TARGET_YEAR:
            june_due = True
            break

    if not june_due:
        continue

    rlist = sorted(rep_map.get(lid, []), key=lambda r: r['date'])
    cumulative = 0
    june_actual = 0
    for idx, r in enumerate(rlist):
        rdate = date.fromisoformat(r['date'][:10])
        p = r['principal']
        if p is None:
            ra = r['amount'] or 0
            remaining = amount - cumulative
            if ra >= remaining:
                p = remaining
            else:
                p = min(ra, pp)
        cumulative += p
        if rdate.month == TARGET_MONTH and rdate.year == TARGET_YEAR:
            june_actual += p

    diff = june_actual - pp
    total_expected += pp
    total_actual += june_actual
    print(f"{name:<30} {pp:>10.4f} {june_actual:>12.4f} {diff:>10.4f}")

print('-' * 70)
print(f"{'TOTAL':<30} {total_expected:>10.4f} {total_actual:>12.4f} {total_actual - total_expected:>10.4f}")
