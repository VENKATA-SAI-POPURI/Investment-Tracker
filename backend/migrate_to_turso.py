"""Migrate local SQLite data to Turso via HTTP API."""
import sqlite3
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

TURSO_URL = 'https://investments-venkata-sai-popuri.aws-ap-south-1.turso.io'
TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzg3ODQxMTAsImlkIjoiMDE5ZTI3YzktZmQwMS03ZTgzLWI0ZmYtYjk0YmIwNTQxZDg2IiwicmlkIjoiNzM0OTVmZTctNmRlNy00NTQwLTk1ZmQtNDI4YzFlNjU3Mzc1In0.Ww9rXlMmvIbjxuNGkgznlN6G2QY_4It_y0ay0IIjKWkCM2TpU5oiVFK1O0-PiXiU_EU9yjym3QJTARWQI2njBg'

HEADERS = {'Authorization': f'Bearer {TURSO_TOKEN}', 'Content-Type': 'application/json'}

def run_sql(stmts):
    reqs = [{'type': 'execute', 'stmt': {'sql': s}} for s in stmts]
    reqs.append({'type': 'close'})
    resp = requests.post(f'{TURSO_URL}/v2/pipeline', json={'requests': reqs}, headers=HEADERS, verify=False, timeout=30)
    data = resp.json()
    errors = [r for r in data.get('results', []) if r.get('type') == 'error']
    return errors

TABLES = {
    'equity': ['year','market','market_cap','sector','name','date','buy_quantity','buy_value','sell_quantity','sell_value','buy_sell','remarks'],
    'commodity': ['year','commodity','name','date','buy_quantity','buy_value','sell_quantity','sell_value','buy_sell','remarks'],
    'mutual_funds': ['year','category','fund_type','name','date','buy_quantity','buy_value','sell_quantity','sell_value','buy_sell','remarks'],
    'p2p': ['lending_id','platform','name','date','amount','tenure','maturity_date','status','remarks'],
    'p2p_repayments': ['lending_id','date','amount','remarks'],
    'fixed_deposits': ['year','platform','bank_name','date','fd_value','interest','maturity_date','return_value','remarks'],
    'forex': ['date','type','inr_amount','usd_amount','rate','remarks'],
}

NUMERIC = {'buy_quantity','buy_value','sell_quantity','sell_value','amount','tenure','fd_value','interest','return_value','inr_amount','usd_amount','rate'}

# Step 1: Create tables one at a time
print('Creating tables...')
for table, cols in TABLES.items():
    col_defs = ', '.join(f"{c} {'REAL' if c in NUMERIC else 'TEXT'}" for c in cols)
    sql = f'CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY AUTOINCREMENT, {col_defs})'
    errs = run_sql([sql])
    status = 'ERROR: ' + str(errs) if errs else 'OK'
    print(f'  {table}: {status}')

# Step 2: Insert data row by row
db = sqlite3.connect('investments.db')
db.row_factory = sqlite3.Row

for table, cols in TABLES.items():
    rows = [dict(r) for r in db.execute(f"SELECT {','.join(cols)} FROM {table}")]
    if not rows:
        print(f'{table}: 0 rows (skipped)')
        continue
    for i, row in enumerate(rows):
        vals = []
        for c in cols:
            v = row[c]
            if v is None:
                vals.append('NULL')
            elif c in NUMERIC:
                try:
                    vals.append(str(float(v)))
                except:
                    vals.append('NULL')
            else:
                escaped = str(v).replace("'", "''")
                vals.append(f"'{escaped}'")
        sql = f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join(vals)})"
        errs = run_sql([sql])
        if errs:
            print(f'  {table} row {i+1}: ERROR {errs}')
    print(f'{table}: {len(rows)} rows migrated')

db.close()
print('Done!')
