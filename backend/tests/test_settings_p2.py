"""P2 settings (SPEC §7.7; AMENDMENTS R4, R5, R8, R11, D14, D15): assumption overrides, saved scenarios, the
digest flag, and the per-member write path with its GET /settings meta.

These read the ledger directly (L().get_settings), so they hold whichever Services.settings is in place."""
import pytest

from conftest import ADMIN, GUEST, OTHER, USER, auth
from tracker.analytics import assumptions as A

GLOBAL = "__global__"
FIXTURE = {"name": "Retire at 55", "sip": 60000, "step": 10, "return": None, "retire_age": 55,
           "lump_sums": [{"date": "2030-01-01", "amount": 500000}], "inflation_pct": 7, "mix": None}


def put(client, h, key, value):
    return client.put(f"/api/settings/{key}", headers=h, json={"value": value})


def ledger(client):
    return client.application.extensions["ledger"]


# ── assumptions (R4) ──

def test_assumption_overrides_are_validated_stored_and_cleared(client):
    h = auth(ADMIN, "admin")
    value = {"segments": {"Equity (India)": {"return_pct": 10, "vol_pct": 20}, "MF_DEBT": {"return_pct": 6.5, "vol_pct": 2}},
             "inflation_pct": 5}
    r = put(client, h, "assumptions", value)
    assert r.status_code == 200 and r.json["value"] == value
    saved = client.get("/api/settings", headers=h).json["assumptions"]
    assert saved == value
    book = A.effective_book(ledger(client).get_settings(ADMIN, "admin"))
    assert book["segments"]["Equity (India)"] == {"return_pct": 10.0, "vol_pct": 20.0, "source": "override"}
    assert book["inflation_pct"] == 5.0
    for clear in (None, {}):
        r = put(client, h, "assumptions", clear)
        assert r.status_code == 200 and r.json["value"] == {}
        assert client.get("/api/settings", headers=h).json["assumptions"] == {}
        assert A.effective_book(ledger(client).get_settings(ADMIN, "admin")) == A.effective_book(None)


@pytest.mark.parametrize("bad", [
    "high",
    {"segments": {"Gold": {"return_pct": 8, "vol_pct": 15}}},
    {"segments": {"Equity (India)": {"return_pct": 26, "vol_pct": 18}}},
    {"segments": {"Equity (India)": {"return_pct": -5.1, "vol_pct": 18}}},
    {"segments": {"Equity (India)": {"return_pct": 12, "vol_pct": 61}}},
    {"segments": {"Equity (India)": {"return_pct": 12, "vol_pct": -1}}},
    {"segments": {"Equity (India)": {"return_pct": 12}}},
    {"segments": {"Equity (India)": {"return_pct": "12", "vol_pct": 18}}},
    {"segments": {"Equity (India)": {"return_pct": True, "vol_pct": 18}}},
    {"segments": {"Equity (India)": 12}},
    {"segments": [1, 2]},
    {"inflation_pct": 16},
    {"inflation_pct": -1},
    {"inflation_pct": "6"},
    {"inflation": 6},
    {"segments": {}, "volatility": 1},
])
def test_assumption_overrides_reject_bad_values(client, bad):
    r = put(client, auth(ADMIN, "admin"), "assumptions", bad)
    assert r.status_code == 400, bad
    assert "assumptions" not in ledger(client).get_settings(ADMIN, "admin")


def test_assumption_overrides_reject_non_finite_numbers(client):
    raw = '{"value": {"segments": {"Equity (India)": {"return_pct": NaN, "vol_pct": 18}}}}'
    r = client.put("/api/settings/assumptions", headers={**auth(ADMIN, "admin"), "Content-Type": "application/json"},
                   data=raw)
    assert r.status_code == 400


def test_guests_cannot_write_assumptions(client):
    assert put(client, auth(GUEST, "guest"), "assumptions", {"inflation_pct": 5}).status_code == 403


# ── planScenarios (R5) ──

def test_plan_scenarios_accept_the_shared_fixture(client):
    h = auth(USER, "user")
    r = put(client, h, "planScenarios", [{**FIXTURE, "name": "  Retire at 55  ", "colour": "red"}])
    assert r.status_code == 200
    (saved,) = r.json["value"]
    assert saved == {"name": "Retire at 55", "sip": 60000.0, "step": 10.0, "return": None, "retire_age": 55,
                     "lump_sums": [{"date": "2030-01-01", "amount": 500000.0}], "inflation_pct": 7.0, "mix": None}
    assert client.get("/api/settings", headers=h).json["planScenarios"] == [saved]
    # optional fields may be absent; a mix within ± 0.5 of 100 is kept
    lean = put(client, h, "planScenarios", [{"name": "Lean", "sip": 0, "step": 0,
                                             "mix": {"Equity (India)": 60.2, "Fixed Deposits": 39.5}}]).json["value"][0]
    assert lean["return"] is None and lean["retire_age"] is None and lean["lump_sums"] == [] and lean["inflation_pct"] is None
    assert lean["mix"] == {"Equity (India)": 60.2, "Fixed Deposits": 39.5}
    assert put(client, h, "planScenarios", [FIXTURE] * 5).status_code == 200
    assert put(client, h, "planScenarios", None).json["value"] == []


@pytest.mark.parametrize("change, field", [
    ({"name": ""}, "name"),
    ({"name": "   "}, "name"),
    ({"name": "x" * 41}, "name"),
    ({"name": None}, "name"),
    ({"sip": -1}, "sip"),
    ({"sip": None}, "sip"),
    ({"sip": "60000"}, "sip"),
    ({"step": 51}, "step"),
    ({"return": 31}, "return"),
    ({"return": -10.5}, "return"),
    ({"retire_age": 14.5}, "retire_age"),
    ({"retire_age": 14}, "retire_age"),
    ({"retire_age": 55.5}, "retire_age"),
    ({"lump_sums": [{"date": "2030-01-01", "amount": 1}] * 11}, "lump_sums"),
    ({"lump_sums": [{"date": "2030-01-01", "amount": -1}]}, "lump_sums[0].amount"),
    ({"lump_sums": [{"date": "01/01/2030", "amount": 1}]}, "lump_sums[0].date"),
    ({"lump_sums": {"date": "2030-01-01"}}, "lump_sums"),
    ({"inflation_pct": 16}, "inflation_pct"),
    ({"mix": {"Equity (India)": 60, "Fixed Deposits": 39}}, "mix"),
    ({"mix": {"Gold": 100}}, "mix"),
    ({"mix": {"Equity (India)": 101}}, "mix"),
    ({"mix": [100]}, "mix"),
])
def test_plan_scenarios_reject_the_shared_fixtures(client, change, field):
    h = auth(USER, "user")
    r = put(client, h, "planScenarios", [FIXTURE, {**FIXTURE, **change}])
    assert r.status_code == 400, change
    assert r.json["error"].startswith(f"Scenario 2: {field} "), r.json["error"]
    assert "planScenarios" not in ledger(client).get_settings(USER, "user")


def test_plan_scenarios_reject_six_and_non_lists(client):
    h = auth(USER, "user")
    r = put(client, h, "planScenarios", [FIXTURE] * 6)
    assert r.status_code == 400 and "5" in r.json["error"]
    assert put(client, h, "planScenarios", FIXTURE).status_code == 400
    assert put(client, h, "planScenarios", ["Retire at 55"]).status_code == 400


def test_seen_notices_is_not_a_setting(client):
    assert put(client, auth(USER, "user"), "seenNotices", {"x": "2026-11-14"}).status_code == 400   # D15


# ── the digest flag (R8) ──

def test_market_alerts_digest_flag(client):
    h = auth(USER, "user")
    r = put(client, h, "marketAlerts", {"enabled": True, "push": True, "day": 5, "week": 10, "digest": True})
    assert r.status_code == 200 and r.json["value"]["digest"] is True
    assert client.get("/api/settings", headers=h).json["marketAlerts"]["digest"] is True
    # the object is rebuilt whole: a PUT without digest stores false
    assert put(client, h, "marketAlerts", {"enabled": True, "day": 6}).json["value"] == \
        {"enabled": True, "push": True, "day": 6.0, "week": 10.0, "digest": False}
    assert put(client, h, "marketAlerts", {"digest": "yes"}).status_code == 400
    assert put(client, h, "marketAlerts", {"digest": True, "day": 50}).status_code == 400


# ── per-member settings (R11) and GET /settings meta (R8) ──

def test_admin_viewing_a_member_writes_and_reads_the_members_row(client):
    me = auth(ADMIN, "admin")
    member = {**me, "X-Portfolio": OTHER}
    assert put(client, me, "taxSlabRate", 20).status_code == 200                       # the family plan
    assert put(client, me, "riskProfile", "growth").status_code == 200
    targets = {"Equity (India)": 70, "Fixed Deposits": 30}
    assert put(client, member, "targetAllocation", targets).status_code == 200          # OTHER's own row
    L = ledger(client)
    assert L.get_settings(OTHER, "user")["targetAllocation"] == targets
    assert "targetAllocation" not in L.get_settings(ADMIN, "admin")                      # __global__ untouched
    assert L.setting_keys(OTHER) == {"targetAllocation"}
    # OTHER reads it; the keys OTHER never set come from __global__ and are listed as inherited
    mine = client.get("/api/settings", headers=auth(OTHER, "user")).json
    assert mine["targetAllocation"] == targets and mine["taxSlabRate"] == "20"
    assert mine["settings_owner"] == OTHER and mine["inherited"] == ["riskProfile", "taxSlabRate"]
    # the admin's member view shows the same, and the family view is unchanged
    view = client.get("/api/settings", headers=member).json
    assert view["settings_owner"] == OTHER and view["inherited"] == ["riskProfile", "taxSlabRate"]
    assert view["targetAllocation"] == targets
    fam = client.get("/api/settings", headers=me).json
    assert fam["settings_owner"] == GLOBAL and fam["inherited"] == [] and "targetAllocation" not in fam


def test_family_view_and_users_write_their_usual_owner(client):
    me, user = auth(ADMIN, "admin"), auth(USER, "user")
    assert put(client, me, "targetAllocation", {"Equity (India)": 100}).status_code == 200
    assert put(client, {**me, "X-Portfolio": "family"}, "riskProfile", "growth").status_code == 200
    L = ledger(client)
    assert {"targetAllocation", "riskProfile"} <= L.setting_keys(GLOBAL)
    assert put(client, user, "targetAllocation", {"Mutual Funds": 100}).status_code == 200
    assert L.get_settings(USER, "user")["targetAllocation"] == {"Mutual Funds": 100}
    got = client.get("/api/settings", headers=user).json
    assert got["settings_owner"] == USER and got["inherited"] == ["riskProfile"]
    # a user's X-Portfolio is ignored: they cannot write someone else's row
    assert put(client, {**user, "X-Portfolio": OTHER}, "riskProfile", "aggressive").status_code == 200
    assert "riskProfile" not in L.setting_keys(OTHER) and L.get_settings(USER, "user")["riskProfile"] == "aggressive"


def test_guest_viewing_a_member_reads_that_members_settings_and_cannot_write(client):
    put(client, {**auth(ADMIN, "admin"), "X-Portfolio": OTHER}, "riskProfile", "conservative")
    view = {**auth(GUEST, "guest"), "X-Portfolio": OTHER}
    got = client.get("/api/settings", headers=view).json
    assert got["settings_owner"] == OTHER and got["riskProfile"] == "conservative"
    assert put(client, view, "riskProfile", "growth").status_code == 403
    assert client.get("/api/settings", headers=auth(GUEST, "guest")).json["settings_owner"] == GLOBAL


def test_review_complete_writes_the_members_review(client):
    me = auth(ADMIN, "admin")
    r = client.post("/api/review/complete", headers={**me, "X-Portfolio": OTHER})
    assert r.status_code == 200
    L = ledger(client)
    assert L.get_settings(OTHER, "user")["lastReviewDate"] == r.json["lastReviewDate"]
    assert {"lastReviewDate", "reviewSnapshot"} <= L.setting_keys(OTHER)
    assert "lastReviewDate" not in L.setting_keys(GLOBAL)
    assert client.post("/api/review/complete", headers=me).status_code == 200
    assert "lastReviewDate" in L.setting_keys(GLOBAL)
    assert client.post("/api/review/complete", headers=auth(GUEST, "guest")).status_code == 403


# ── W7 integrator ──

@pytest.mark.parametrize("bad", ["thirty", None, [30], {"rate": 30}])
def test_tax_slab_rate_refuses_non_numbers_with_a_400(client, bad):
    h = auth(USER, "user")
    r = put(client, h, "taxSlabRate", bad)
    assert r.status_code == 400 and "number" in r.json["error"]
    assert put(client, h, "taxSlabRate", 50).status_code == 400
    assert put(client, h, "taxSlabRate", 30).status_code == 200


def test_saved_scenarios_and_compare_share_one_validator(client):
    """R2: PUT planScenarios runs scenarios.validate_saved, so a saved entry the compare route would refuse is
    refused at save time with the same field text."""
    from tracker.analytics import scenarios as scen
    bad = {**FIXTURE, "mix": {"Equity (India)": 60}}
    with pytest.raises(scen.ScenarioError) as e:
        scen.validate_saved([bad])
    r = put(client, auth(USER, "user"), "planScenarios", [bad])
    assert r.status_code == 400 and r.json["error"] == str(e.value)
