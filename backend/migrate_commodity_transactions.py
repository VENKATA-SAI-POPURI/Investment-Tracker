"""One-time script: replace commodity Turso DB with transaction-level data."""
import warnings, requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

TURSO_URL   = "https://investments-venkata-sai-popuri.aws-ap-south-1.turso.io"
TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzg3ODQxMTAsImlkIjoiMDE5ZTI3YzktZmQwMS03ZTgzLWI0ZmYtYjk0YmIwNTQxZDg2IiwicmlkIjoiNzM0OTVmZTctNmRlNy00NTQwLTk1ZmQtNDI4YzFlNjU3Mzc1In0.Ww9rXlMmvIbjxuNGkgznlN6G2QY_4It_y0ay0IIjKWkCM2TpU5oiVFK1O0-PiXiU_EU9yjym3QJTARWQI2njBg"
API_URL = TURSO_URL + "/v2/pipeline"
HEADERS = {"Authorization": f"Bearer {TURSO_TOKEN}", "Content-Type": "application/json"}

def run(sql, params=None):
    stmt = {"sql": sql}
    if params:
        args = []
        for v in params:
            if v is None:              args.append({"type": "null"})
            elif isinstance(v, float): args.append({"type": "float",   "value": v})
            elif isinstance(v, int):   args.append({"type": "integer", "value": str(v)})
            else:                      args.append({"type": "text",    "value": str(v)})
        stmt["args"] = args
    body = {"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        resp = requests.post(API_URL, json=body, headers=HEADERS, timeout=15, verify=False)
    if resp.status_code != 200:
        raise Exception(f"HTTP {resp.status_code}: {resp.text}")
    result = resp.json()["results"][0]
    if result["type"] == "error":
        raise Exception(result["error"]["message"])
    return result["response"]["result"]

# columns: year, commodity, name, date, buy_quantity, buy_value,
#          sell_quantity, sell_value, buy_sell, remarks
ROWS = [
    ("FY27", "Gold",   "Goldbees",   "2026-05-13",  23, 3015.99, None, None, "Buy", ""),
    ("FY27", "Silver", "Silverbees", "2026-05-13",  19, 5082.12, None, None, "Buy", ""),
    ("FY27", "Gold",   "Goldbees",   "2026-05-14",  37, 4884.74, None, None, "Buy", ""),
    ("FY27", "Silver", "Silverbees", "2026-05-14",  11, 2988.81, None, None, "Buy", ""),
    ("FY27", "Silver", "Silverbees", "2026-05-15",   7, 1812.02, None, None, "Buy", ""),
    ("FY27", "Silver", "Silverbees", "2026-05-18",  10,  2519.8, None, None, "Buy", ""),
]

INSERT = """INSERT INTO commodity
  (year, commodity, name, date, buy_quantity, buy_value, sell_quantity, sell_value, buy_sell, remarks)
  VALUES (?,?,?,?,?,?,?,?,?,?)"""

if __name__ == "__main__":
    print("Deleting existing commodity rows...")
    run("DELETE FROM commodity")
    print("  Done")

    print(f"Inserting {len(ROWS)} rows...")
    for i, row in enumerate(ROWS, 1):
        run(INSERT, list(row))
        print(f"  [{i}/{len(ROWS)}] {row[3]}  {row[1]:6s}  {row[2]}  qty={row[4]}  val={row[5]}")

    res = run("SELECT COUNT(*) FROM commodity")
    cnt = res["rows"][0][0]["value"]
    print(f"\nDone — {cnt} rows in commodity table.")
