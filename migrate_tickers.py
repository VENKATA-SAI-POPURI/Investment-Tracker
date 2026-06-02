import requests, warnings
warnings.filterwarnings('ignore')
url = 'https://investments-venkata-sai-popuri.aws-ap-south-1.turso.io/v2/pipeline'
tok = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzg3ODQxMTAsImlkIjoiMDE5ZTI3YzktZmQwMS03ZTgzLWI0ZmYtYjk0YmIwNTQxZDg2IiwicmlkIjoiNzM0OTVmZTctNmRlNy00NTQwLTk1ZmQtNDI4YzFlNjU3Mzc1In0.Ww9rXlMmvIbjxuNGkgznlN6G2QY_4It_y0ay0IIjKWkCM2TpU5oiVFK1O0-PiXiU_EU9yjym3QJTARWQI2njBg'
hdrs = {'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'}

def query(sql, params=None):
    stmt = {'sql': sql}
    if params:
        args = []
        for v in params:
            if v is None:
                args.append({'type': 'null'})
            elif isinstance(v, float):
                args.append({'type': 'float', 'value': v})
            elif isinstance(v, int):
                args.append({'type': 'integer', 'value': str(v)})
            else:
                args.append({'type': 'text', 'value': str(v)})
        stmt['args'] = args
    r = requests.post(url, json={'requests':[{'type':'execute','stmt':stmt},{'type':'close'}]}, headers=hdrs, verify=False)
    res = r.json()['results'][0]
    if res['type'] == 'error':
        raise Exception(res['error']['message'])
    return res['response']['result']

def cell(row, i):
    c = row[i]
    if isinstance(c, dict):
        return None if c.get('type') == 'null' else c.get('value')
    return c

# Read distinct name -> ticker from mutual_funds
print('=== Reading mutual_funds Ticker Symbol ===')
res = query('SELECT DISTINCT name, [Ticker Symbol] FROM mutual_funds WHERE [Ticker Symbol] IS NOT NULL AND [Ticker Symbol] != \'\'')
mf_tickers = {}
for row in res['rows']:
    name, ticker = cell(row, 0), cell(row, 1)
    if name and ticker:
        mf_tickers[name] = ticker
        print(f'  {name} -> {ticker}')
if not mf_tickers:
    print('  (none found)')

# Read distinct name -> ticker from commodity
print('\n=== Reading commodity Ticker Symbol ===')
res = query('SELECT DISTINCT name, [Ticker Symbol] FROM commodity WHERE [Ticker Symbol] IS NOT NULL AND [Ticker Symbol] != \'\'')
commodity_tickers = {}
for row in res['rows']:
    name, ticker = cell(row, 0), cell(row, 1)
    if name and ticker:
        commodity_tickers[name] = ticker
        print(f'  {name} -> {ticker}')
if not commodity_tickers:
    print('  (none found)')

# Migrate to mf_tickers
if mf_tickers:
    print('\n=== Migrating to mf_tickers ===')
    for name, ticker in mf_tickers.items():
        query('INSERT INTO mf_tickers (name, ticker) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET ticker = excluded.ticker', (name, ticker))
        print(f'  Upserted: {name} -> {ticker}')

# Migrate to commodity_tickers
if commodity_tickers:
    print('\n=== Migrating to commodity_tickers ===')
    for name, ticker in commodity_tickers.items():
        query('INSERT INTO commodity_tickers (name, ticker) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET ticker = excluded.ticker', (name, ticker))
        print(f'  Upserted: {name} -> {ticker}')

print('\nDone.')
