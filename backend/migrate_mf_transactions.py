"""One-time script: replace mutual_funds Turso DB with transaction-level data."""
import os, sys, warnings
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

TURSO_URL   = "https://investments-venkata-sai-popuri.aws-ap-south-1.turso.io"
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzg3ODQxMTAsImlkIjoiMDE5ZTI3YzktZmQwMS03ZTgzLWI0ZmYtYjk0YmIwNTQxZDg2IiwicmlkIjoiNzM0OTVmZTctNmRlNy00NTQwLTk1ZmQtNDI4YzFlNjU3Mzc1In0.Ww9rXlMmvIbjxuNGkgznlN6G2QY_4It_y0ay0IIjKWkCM2TpU5oiVFK1O0-PiXiU_EU9yjym3QJTARWQI2njBg")

API_URL = TURSO_URL + "/v2/pipeline"
HEADERS = {"Authorization": f"Bearer {TURSO_TOKEN}", "Content-Type": "application/json"}

def run(sql, params=None):
    stmt = {"sql": sql}
    if params:
        args = []
        for v in params:
            if v is None:
                args.append({"type": "null"})
            elif isinstance(v, float):
                args.append({"type": "float", "value": v})
            elif isinstance(v, int):
                args.append({"type": "integer", "value": str(v)})
            else:
                args.append({"type": "text", "value": str(v)})
        stmt["args"] = args
    body = {"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        resp = requests.post(API_URL, json=body, headers=HEADERS, timeout=15, verify=False)
    if resp.status_code != 200:
        raise Exception(f"HTTP {resp.status_code}: {resp.text}")
    data = resp.json()
    result = data["results"][0]
    if result["type"] == "error":
        raise Exception(result["error"]["message"])
    return result["response"]["result"]

# ── Transaction data from spreadsheet ─────────────────────────────────────────
# Columns: year, category, fund_type, name, date, buy_quantity, buy_value,
#          sell_quantity, sell_value, buy_sell, remarks
ROWS = [
    # ── Axis ELSS Tax Saver Fund (SIP) ────────────────────────────────────────
    ("FY23", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-03-20", 7.538,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-04-05", 7.266,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-05-05", 6.868,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-06-05", 6.566,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-07-03", 6.318,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-08-02", 6.316,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-09-04", 6.312,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-10-03", 6.212,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-11-02", 6.322,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2023-12-04", 5.857,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-01-02", 5.631,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-02-02", 5.677,  500.0, None, None, "Buy", ""),
    ("FY24", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-03-04", 11.019, 1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-04-02", 10.442, 1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-05-02", 10.343, 1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-06-03", 10.248, 1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-07-02", 9.721,  1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-08-02", 9.408,  1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-10-03", 9.074,  1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-11-04", 9.54,   1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2024-12-02", 9.403,  1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2025-01-02", 9.336,  1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2025-02-03", 9.819,  1000.0,None, None, "Buy", ""),
    ("FY25", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2025-03-05", 10.346, 1000.0,None, None, "Buy", ""),
    ("FY26", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2025-04-07", 10.371, 1000.0,None, None, "Buy", ""),
    ("FY26", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2025-05-05", 9.504,  1000.0,None, None, "Buy", ""),
    ("FY26", "ELSS", "SIP", "Axis ELSS Tax Saver Fund", "2025-06-05", 9.297,  1000.0,None, None, "Buy", ""),
    # ── Other funds ───────────────────────────────────────────────────────────
    ("FY27", "Hybrid",  "Lump Sum", "Kotak Multi Asset Allocation Fund", "2026-05-13", 304.454, 5000.0, None, None, "Buy", ""),
    ("FY27", "Equity",  "Lump Sum", "Quant Flexi Cap Fund",              "2026-05-15",  86.37, 10000.0, None, None, "Buy", ""),
    ("FY27", "Hybrid",  "Lump Sum", "Kotak Multi Asset Allocation Fund", "2026-05-15", 609.726,10000.0, None, None, "Buy", ""),
]

INSERT_SQL = """
INSERT INTO mutual_funds
  (year, category, fund_type, name, date,
   buy_quantity, buy_value, sell_quantity, sell_value, buy_sell, remarks)
VALUES (?,?,?,?,?, ?,?,?,?,?,?)
"""

if __name__ == "__main__":
    print("Connecting to Turso…")

    # 1. Clear existing rows
    print("Deleting existing mutual_funds rows…")
    res = run("DELETE FROM mutual_funds")
    print("  Deleted OK")

    # 2. Insert new rows
    print(f"Inserting {len(ROWS)} rows…")
    for i, row in enumerate(ROWS, 1):
        run(INSERT_SQL, list(row))
        print(f"  [{i:02d}/{len(ROWS)}] {row[4]} {row[3][:30]}")

    # 3. Verify
    res = run("SELECT COUNT(*) as cnt FROM mutual_funds")
    cols = [c["name"] for c in res.get("cols", [])]
    vals = res.get("rows", [[]])[0]
    cnt = vals[0]["value"] if vals else "?"
    print(f"\nDone — {cnt} rows now in mutual_funds table.")
