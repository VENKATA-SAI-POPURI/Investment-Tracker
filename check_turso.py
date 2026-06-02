import requests, json, warnings
warnings.filterwarnings('ignore')

url = 'https://investments-venkata-sai-popuri.aws-ap-south-1.turso.io/v2/pipeline'
tok = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzg3ODQxMTAsImlkIjoiMDE5ZTI3YzktZmQwMS03ZTgzLWI0ZmYtYjk0YmIwNTQxZDg2IiwicmlkIjoiNzM0OTVmZTctNmRlNy00NTQwLTk1ZmQtNDI4YzFlNjU3Mzc1In0.Ww9rXlMmvIbjxuNGkgznlN6G2QY_4It_y0ay0IIjKWkCM2TpU5oiVFK1O0-PiXiU_EU9yjym3QJTARWQI2njBg'
hdrs = {'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'}

def query(sql):
    r = requests.post(url, json={'requests':[{'type':'execute','stmt':{'sql':sql}},{'type':'close'}]}, headers=hdrs, verify=False)
    return r.json()['results'][0]['response']['result']

# List all tables
print("=== TABLES ===")
res = query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
for row in res['rows']:
    print(row[0]['value'])

# Check mf_tickers
print("\n=== mf_tickers ===")
res = query("SELECT name, ticker, price FROM mf_tickers")
if not res['rows']:
    print("EMPTY")
else:
    for row in res['rows']:
        print(f"  {row[0]['value']} | {row[1]['value']} | {row[2]['value']}")

# Check commodity_tickers
print("\n=== commodity_tickers ===")
res = query("SELECT name, ticker, price FROM commodity_tickers")
if not res['rows']:
    print("EMPTY")
else:
    for row in res['rows']:
        print(f"  {row[0]['value']} | {row[1]['value']} | {row[2]['value']}")

# Check distinct fund names from mutual_funds
print("\n=== distinct fund names in mutual_funds (first 10) ===")
res = query("SELECT DISTINCT name FROM mutual_funds ORDER BY name LIMIT 10")
for row in res['rows']:
    print(f"  {row[0]['value']}")

# Check distinct names from commodity
print("\n=== distinct names in commodity (first 10) ===")
res = query("SELECT DISTINCT name FROM commodity ORDER BY name LIMIT 10")
for row in res['rows']:
    print(f"  {row[0]['value']}")
