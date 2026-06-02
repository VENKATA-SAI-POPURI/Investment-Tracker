import requests, warnings
warnings.filterwarnings('ignore')
url = 'https://investments-venkata-sai-popuri.aws-ap-south-1.turso.io/v2/pipeline'
tok = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzg3ODQxMTAsImlkIjoiMDE5ZTI3YzktZmQwMS03ZTgzLWI0ZmYtYjk0YmIwNTQxZDg2IiwicmlkIjoiNzM0OTVmZTctNmRlNy00NTQwLTk1ZmQtNDI4YzFlNjU3Mzc1In0.Ww9rXlMmvIbjxuNGkgznlN6G2QY_4It_y0ay0IIjKWkCM2TpU5oiVFK1O0-PiXiU_EU9yjym3QJTARWQI2njBg'
hdrs = {'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'}

def query(sql):
    r = requests.post(url, json={'requests':[{'type':'execute','stmt':{'sql':sql}},{'type':'close'}]}, headers=hdrs, verify=False)
    res = r.json()['results'][0]
    if res['type'] == 'error':
        print(f"  ERROR: {res['error']['message']}")
        return None
    return res['response']['result']

def cell(row, i):
    c = row[i]
    if isinstance(c, dict):
        return None if c.get('type') == 'null' else c.get('value')
    return c

print('=== mutual_funds columns ===')
res = query('PRAGMA table_info(mutual_funds)')
if res:
    for row in res['rows']:
        print(f"  {cell(row,1)}")

print()
print('=== commodity columns ===')
res = query('PRAGMA table_info(commodity)')
if res:
    for row in res['rows']:
        print(f"  {cell(row,1)}")

print()
print('=== mutual_funds distinct name+ticker (non-null) ===')
res = query('SELECT DISTINCT name, ticker FROM mutual_funds WHERE ticker IS NOT NULL LIMIT 10')
if res:
    if not res['rows']:
        print('  (empty / no ticker column)')
    else:
        for row in res['rows']:
            print(f"  {cell(row,0)} | {cell(row,1)}")

print()
print('=== commodity distinct name+ticker (non-null) ===')
res = query('SELECT DISTINCT name, ticker FROM commodity WHERE ticker IS NOT NULL LIMIT 10')
if res:
    if not res['rows']:
        print('  (empty / no ticker column)')
    else:
        for row in res['rows']:
            print(f"  {cell(row,0)} | {cell(row,1)}")
