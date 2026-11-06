import base64

import pytest
from conftest import USER, auth

from tracker.importers import epf_passbook as ep

HEAD = """Member Passbook
Establishment ID/Name ABCDE0000001000 / ACME LLP
Member ID/Name {mid} / TEST PERSON
UAN 100000000001
EPF Passbook [ Financial Year - {fy} ]
"""
# Old account: two contributions, a withdrawal, then everything transferred to the new account
OLD = HEAD.format(mid="ABCDE00000010000000001", fy="2025-2026") + """OB Int. Updated upto 01/04/2025 10,000 20,000 0
Wage Month
Apr-2025 01-05-2025 CR Cont. for the Due-Month
202505 25,000 0 3,000 3,000 0
May-2025 01-06-2025 CR Cont. for Due-Month 062025 25,000 0 3,000 3,000 0
May-2025 20-06-2025 DR Claim Against - PARA 68J 0 0 5,000 0 0
Jun-2025 26-07-2025 DR Claim Against - PARA 57(2) 0 0 11,000 26,000 0
Total Contributions for the year [ 2025 ] 6,000 6,000 0
Int. Updated upto 31/03/2026 0 0 0
Closing Balance as on 31/03/2026 0 0 0
"""
NEW = HEAD.format(mid="ABCDE00000020000000002", fy="2025-2026") + """OB Int. Updated upto 31/03/2025 0 0 0
Jul-2025 01-08-2025 CR
TRANSFER IN - SAME OFFICE
(Old Member Id-
:ABCDE00000010000000001
)
0 0 11,000 26,000 0
Aug-2025 01-09-2025 CR Cont. for the Due-Month
202509 30,000 0 3,600 3,600 0
Total Contributions for the year [ 2025 ] 3,600 3,600 0
Int. Updated upto 31/03/2026 500 1,000 0
Closing Balance as on 31/03/2026 15,100 30,600 0
"""


def test_parse_wrapped_rows_and_check_balances():
    s = ep.parse(NEW)
    assert (s["member_id"], s["uan"], s["fy"], s["establishment"]) == ("ABCDE00000020000000002", "100000000001", "2025-26", "ACME LLP")
    assert [e["kind"] for e in s["entries"]] == ["transfer_in", "contribution"]
    assert s["entries"][0]["counterpart"] == "ABCDE00000010000000001" and s["entries"][1]["amount"] == 7200
    assert s["check"]["ok"]
    broken = ep.parse(NEW.replace("Closing Balance as on 31/03/2026 15,100", "Closing Balance as on 31/03/2026 15,900"))
    assert not broken["check"]["ok"] and broken["check"]["employee"]["computed"] == 15100
    with pytest.raises(ep.PassbookError):
        ep.parse("Hello")


def test_plan_drops_internal_transfers_and_matches_the_closing_balance():
    p = ep.plan([ep.parse(NEW), ep.parse(OLD)])  # order doesn't matter
    kinds = [t["kind"] for t in p["transactions"]]
    assert "transfer_in" not in kinds and "transfer_out" not in kinds
    assert kinds == ["opening", "contribution", "contribution", "withdrawal", "contribution", "interest"]
    bal = sum(t["amount"] if t["type"] in ("BUY", "CREDIT") else -t["amount"] for t in p["transactions"])
    assert bal == p["closing_balance"] == 45700
    assert p["notes"] and "opening balance" in p["notes"][0]
    # Only the new account uploaded: the transfer from the unseen account counts as money coming in
    alone = ep.plan([ep.parse(NEW)])
    assert [t["kind"] for t in alone["transactions"]] == ["transfer_in", "contribution", "interest"]


def test_epf_import_api_creates_one_holding_and_skips_repeats(client, monkeypatch):
    texts = {"old": OLD, "new": NEW}
    monkeypatch.setattr(ep, "pdf_text", lambda data, password=None: texts[data.decode()])
    files = [{"name": f"{k}.pdf", "file_data": base64.b64encode(k.encode()).decode()} for k in texts]
    h = auth(USER, "user")
    pv = client.post("/api/import/epf/preview", headers=h, json={"files": files})
    assert pv.status_code == 200, pv.json
    assert pv.json["new_count"] == 6 and pv.json["account"] is None and all(s["check"]["ok"] for s in pv.json["statements"])
    res = client.post("/api/import/epf/commit", headers=h, json={"files": files}).json
    assert res == {"imported": 6, "skipped": 0, "balance": 45700}
    (epf,) = [p for p in client.get("/api/portfolio", headers=h).json["positions"] if p["asset_class"] == "epf"]
    assert epf["interest_credited"] == 1500 and epf["value"] >= 45700
    again = client.post("/api/import/epf/preview", headers=h, json={"files": files}).json
    assert again["new_count"] == 0 and again["account"]["id"] == epf["id"]
    assert client.post("/api/import/epf/commit", headers=h, json={"files": files}).json["imported"] == 0
