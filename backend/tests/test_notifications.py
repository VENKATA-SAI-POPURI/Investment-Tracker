"""The bell and the daily digest (SPEC §8.6; AMENDMENTS R9, R10, K7, D15)."""
from datetime import date, timedelta

import pytest

from conftest import ADMIN, GUEST, OTHER, USER, auth
from test_api import buy
from tracker import notices
from tracker import push

NOTICE_KEYS = {"id", "kind", "title", "body", "date", "days", "link", "severity", "seen"}
JOB = {"X-Job-Token": "test-job-token"}
TODAY = date(2026, 11, 14)


def act(aid, *, tier="now", severity="warn", owner=USER, iid=None, due=None, score=1.0, cta=None, link=None, **kw):
    return {"id": aid, "tier": tier, "severity": severity, "owner": owner, "instrument_id": iid, "due": due,
            "score": score, "category": aid.split(":")[0], "title": f"Title {aid}", "detail": f"Detail {aid}",
            "cta": cta, "link": link, "status": "open", **kw}


def event(key, days, kind="personal", note=None, link="/x"):
    when = (TODAY + timedelta(days=days)).isoformat()
    ev = {"key": key, "date": when, "days": days, "kind": kind, "title": f"Event {key}", "link": link}
    if note:
        ev["note"] = note
    return ev


# ── pure pieces ──

def test_action_notice_maps_severity_dates_and_links():
    a = act("fd:maturing:7", severity="crit", due="2026-11-17", cta={"type": "route", "route": "/fixed-deposits",
                                                                      "query": {"id": 7}, "fragment": "row"})
    n = notices.action_notice(a, TODAY)
    assert n == {"id": "act:fd:maturing:7", "kind": "fd", "title": "Title fd:maturing:7", "body": "Detail fd:maturing:7",
                 "date": "2026-11-17", "days": 3, "link": "/fixed-deposits?id=7#row", "severity": "critical"}
    assert notices.action_notice(act("drift:x", severity="warn"), TODAY)["severity"] == "warning"
    assert notices.action_notice(act("perf:xirr", severity="pos"), TODAY)["severity"] == "info"
    assert notices.action_notice(act("review:due:2026-Q4", severity="info"), TODAY)["severity"] == "info"
    # the link falls back from the CTA route to the action's own link, then to its row on Actions
    assert notices.action_notice(act("cash:usd", link="/forex"), TODAY)["link"] == "/forex"
    assert notices.action_notice(act("cash:usd", cta={"type": "status"}), TODAY)["link"] == "/actions?id=cash:usd"
    assert notices.action_notice(act("cash:usd"), TODAY)["days"] is None


def test_coverage_rule():
    visible = [act("fd:maturing:7", iid=7, tier="month"), act("p2p:overdue", iid=9, tier="consider"),
               act("sip:due:3:2026-11-16"), act("sip:missed:4:2026-11-10", tier="month")]
    assert notices.covered(event("fd:7", 2), visible)                 # any tier counts
    assert notices.covered(event("p2p:9", 5), visible)
    assert not notices.covered(event("fd:8", 2), visible)
    assert not notices.covered(event("p2p:2026-12", 2), visible)      # a folded close names no instrument
    assert notices.covered(event("sip:3:2026-11-16", 2), visible)
    assert notices.covered(event("sip:4:2026-11-10", 0), visible)
    assert not notices.covered(event("sip:3:2026-12-16", 2), visible)  # another instalment of the same plan
    assert not notices.covered(event("tax:advance-q3", 1, kind="tax"), visible)


def test_event_notices_keep_a_week_drop_ipos_and_covered_events():
    visible = [act("fd:maturing:7", iid=7)]
    events = [event("fd:7", 2, kind="fd_maturity"), event("fd:8", 3, kind="fd_maturity", note="₹1L back"),
              event("tax:advance-q3", 1, kind="tax"), event("ipo:5:open_date", 1, kind="ipo"),
              event("sip:3:2026-11-22", 8, kind="sip"), event("goal:1", 7)]
    out = notices.event_notices(events, visible)
    assert [n["id"] for n in out] == [f"cal:fd:8:{(TODAY + timedelta(days=3)).isoformat()}",
                                      f"cal:tax:advance-q3:{(TODAY + timedelta(days=1)).isoformat()}",
                                      f"cal:goal:1:{(TODAY + timedelta(days=7)).isoformat()}"]
    assert out[0]["body"] == "₹1L back" and out[0]["severity"] == "info"
    assert out[1]["severity"] == "warning" and out[1]["body"] == ""
    assert set(out[0]) == NOTICE_KEYS - {"seen"}


def test_log_key_maps_ids_to_action_log_rows():
    owners = {"concentration:2": ADMIN}
    assert notices.log_key("act:concentration:2", "__global__", owners) == (ADMIN, "concentration:2")
    assert notices.log_key("act:data:missing-prices", "__global__", owners) == ("__global__", "data:missing-prices")
    assert notices.log_key("mkt:12", USER, owners) == (USER, "notice:mkt:12")
    assert notices.log_key("act:not-an-action", USER, owners) == (USER, "notice:act:not-an-action")
    assert notices.log_key("act:notice:x", USER, owners) == (USER, "notice:act:notice:x")


def test_digest_payload_one_or_many():
    assert notices.digest_payload([]) is None
    one = notices.digest_payload([act("cash:usd", link="/forex")])
    assert one == {"title": "Title cash:usd", "body": "Detail cash:usd", "url": "/forex", "tag": "digest"}
    many = notices.digest_payload([act("a:1"), act("b:2")])
    assert many == {"title": "2 things need you today", "body": "Title a:1 · Title b:2", "url": "/actions",
                    "tag": "digest"}


class FakeServices:
    """The four Services methods notices composes, over a real ledger."""

    def __init__(self, ledger, visible, events, market):
        self.ledger, self._visible, self._events, self._market = ledger, visible, events, market

    def actions(self, scope, settings, owner=None):
        return {"actions": [a for a in self._visible if a["status"] == "open"],
                "planned": [a for a in self._visible if a["status"] == "planned"]}

    def upcoming(self, scope, settings, owner=None):
        return {"events": self._events}

    def _market_notices(self, scope):
        return list(self._market)


def test_composition_order_coverage_and_seen(app):
    ledger = app.extensions["ledger"]
    visible = [act("drift:Equity (India)", tier="month"),
               act("fd:maturing:7", iid=7, severity="info", due=(TODAY + timedelta(days=4)).isoformat(), score=2),
               act("data:missing-prices", severity="crit", score=5),
               act("sip:due:3:2026-11-16", severity="info", due="2026-11-16", status="planned", score=1)]
    events = [event("fd:7", 4, kind="fd_maturity"), event("sip:3:2026-11-16", 2, kind="sip"),
              event("tax:advance-q3", 1, kind="tax"), event("ipo:1:open_date", 1, kind="ipo")]
    market = [{"id": "mkt:1", "kind": "market", "title": "TCS down 6%", "body": "", "date": TODAY.isoformat(),
               "days": 0, "link": "/markets", "severity": "warning"}]
    svc = FakeServices(ledger, visible, events, market)
    res = notices.notifications(svc, USER, {}, USER, TODAY)
    ids = [n["id"] for n in res["items"]]
    # severity first, then days; the month-tier drift is not in the bell; covered events and IPO dates are dropped
    assert ids == ["act:data:missing-prices", "mkt:1", f"cal:tax:advance-q3:{(TODAY + timedelta(days=1)).isoformat()}",
                   "act:sip:due:3:2026-11-16", "act:fd:maturing:7"]
    assert all(set(n) == NOTICE_KEYS for n in res["items"]) and res["unread"] == 5
    ledger.mark_seen(USER, ["data:missing-prices", "notice:mkt:1"])
    again = notices.notifications(svc, USER, {}, USER, TODAY)
    assert again["unread"] == 3 and {n["id"] for n in again["items"] if n["seen"]} == {"act:data:missing-prices", "mkt:1"}


def test_composition_survives_a_failed_source(app):
    class Broken(FakeServices):
        def actions(self, *a, **k):
            raise RuntimeError("boom")

    svc = Broken(app.extensions["ledger"], [], [event("tax:x", 1, kind="tax")], [])
    res = notices.notifications(svc, USER, {}, USER, TODAY)
    assert [n["kind"] for n in res["items"]] == ["tax"] and res["unread"] == 1


# ── the routes ──

def test_get_notifications_shape_and_actions_parity(client, offline_prices):
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    res = client.get("/api/notifications", headers=h)
    assert res.status_code == 200 and set(res.json) == {"items", "unread"}
    items = res.json["items"]
    assert items and all(set(n) == NOTICE_KEYS for n in items)
    acts = client.get("/api/actions", headers=h).json
    now = {a["id"] for a in acts["actions"] + acts["planned"] if a["tier"] == "now"}
    assert {n["id"][4:] for n in items if n["id"].startswith("act:")} == now
    assert res.json["unread"] == sum(1 for n in items if not n["seen"])
    order = {"critical": 0, "warning": 1, "info": 2}
    keys = [(order[n["severity"]], n["days"] if n["days"] is not None else 99) for n in items]
    assert keys == sorted(keys)
    assert client.get("/api/notifications", headers=auth(GUEST, "guest")).status_code == 200


def test_post_seen_lowers_unread_without_bumping(app, client, offline_prices):
    ledger = app.extensions["ledger"]
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    soon = (date.today() + timedelta(days=1)).isoformat()
    assert client.post("/api/ipos", headers=h, json={"name": "Acme", "open_date": soon}).status_code == 201
    first = client.get("/api/notifications", headers=h).json
    ipo = next(n["id"] for n in first["items"] if n["kind"] == "ipo")
    version, rev = ledger._version, ledger.actions_rev
    r = client.post("/api/notifications/seen", headers=h, json={"ids": ["act:data:missing-prices", ipo]})
    assert r.status_code == 200 and r.json == {"unread": first["unread"] - 2}
    assert (ledger._version, ledger.actions_rev) == (version, rev)        # bookkeeping only (K7)
    assert ledger.action_row(USER, "data:missing-prices")["seen_at"]
    row = ledger.action_row(USER, f"notice:{ipo}")
    assert (row["status"], row["done_via"], row["tier_first"]) == ("done", "seen", None)
    after = client.get("/api/notifications", headers=h).json
    assert {n["id"] for n in after["items"] if n["seen"]} == {"act:data:missing-prices", ipo}
    assert after["unread"] == first["unread"] - 2
    # marking again changes nothing; an unknown id is recorded as a seen notice row (K7)
    assert client.post("/api/notifications/seen", headers=h, json={"ids": [ipo, "cal:tax:x:2026-12-15"]}).json == \
        {"unread": after["unread"]}
    assert ledger.action_row(USER, "notice:cal:tax:x:2026-12-15")["seen_at"]
    # seen notice rows are bookkeeping, never listed as done actions
    assert not any(a["id"].startswith("notice:") for a in client.get("/api/actions", headers=h).json["done"])


def test_admin_seen_goes_to_the_action_owner(app, client, offline_prices):
    ledger = app.extensions["ledger"]
    h = auth(ADMIN, "admin")
    buy(client, h, name="INFY", symbol="INFY.NS")
    items = client.get("/api/notifications", headers=h).json["items"]
    assert "act:data:missing-prices" in {n["id"] for n in items}
    assert client.post("/api/notifications/seen", headers=h, json={"ids": ["act:data:missing-prices"]}).status_code == 200
    assert ledger.action_row("__global__", "data:missing-prices")["seen_at"]    # the family's row, not the admin's


def test_post_seen_guards(client):
    h = auth(USER, "user")
    assert client.post("/api/notifications/seen", headers=auth(GUEST, "guest"), json={"ids": ["mkt:1"]}).status_code == 403
    for bad in ({"ids": "mkt:1"}, {"ids": [1]}, {"ids": [""]}, {"ids": ["x" * 201]}, {"ids": ["a"] * 101}, {}):
        assert client.post("/api/notifications/seen", headers=h, json=bad).status_code == 400, bad
    assert client.post("/api/notifications/seen", headers=h, json={"ids": []}).json == {"unread": 0}


# ── the daily digest ──

def _subscribe(app, owner, n=1):
    for i in range(n):
        push.subscribe(app.extensions["db"], owner, {"endpoint": f"https://push.example/{owner}/{i}",
                                                     "keys": {"p256dh": "k", "auth": "a"}}, "test")


def _digest_on(client, h, on=True):
    r = client.put("/api/settings/marketAlerts", headers=h, json={"value": {"enabled": True, "digest": on}})
    assert r.status_code == 200 and r.json["value"]["digest"] is on


def _owner(run, who):
    return next(r for r in run["owners"] if r["owner"] == who)


def test_digest_requires_the_job_token(client):
    assert client.post("/api/jobs/daily-digest").status_code == 403
    assert client.post("/api/jobs/daily-digest", headers={"X-Job-Token": "wrong"}).status_code == 403
    assert client.post("/api/jobs/daily-digest", headers=auth(ADMIN, "admin")).status_code == 403  # a session is not a job
    run = client.post("/api/jobs/daily-digest", headers=JOB)
    assert run.status_code == 200 and run.json["owners"] == [] and run.json["at"]


def test_digest_pushes_once_and_skips_owners_who_opted_out(app, client, offline_prices, monkeypatch):
    ledger = app.extensions["ledger"]
    sent = []
    monkeypatch.setattr(push, "send", lambda db, owner, payload: sent.append((owner, payload)) or 1)
    hu, ho, ha = auth(USER, "user"), auth(OTHER, "user"), auth(ADMIN, "admin")
    buy(client, hu, symbol="TCS.NS")
    buy(client, ho, name="INFY", symbol="INFY.NS")
    _digest_on(client, hu)
    _digest_on(client, ha)
    _digest_on(client, ho, False)   # without a row of their own, a member inherits the family's flag (R11)
    _subscribe(app, USER, 2)
    _subscribe(app, OTHER)
    _subscribe(app, ADMIN)
    _subscribe(app, "stranger@example.com")
    run = client.post("/api/jobs/daily-digest", headers=JOB).json
    assert _owner(run, USER) == {"owner": USER, "new": 1, "pushed": 1}
    assert _owner(run, OTHER) == {"owner": OTHER, "skipped": "digest off"}
    assert _owner(run, "stranger@example.com")["skipped"]
    # the admin's digest is the family view: the family's data action, logged under __global__
    assert _owner(run, ADMIN) == {"owner": ADMIN, "new": 1, "pushed": 1}
    payload = dict(sent)[USER]
    assert payload == {"title": "1 holding has no live price", "body": "TCS is valued at cost.",
                       "url": "/settings#prices", "tag": "digest"}
    assert ledger.action_row(USER, "data:missing-prices")["pushed_at"]
    assert ledger.action_row("__global__", "data:missing-prices")["pushed_at"]
    # a second run the same day finds nothing new and sends nothing
    sent.clear()
    again = client.post("/api/jobs/daily-digest", headers=JOB).json
    assert _owner(again, USER) == {"owner": USER, "new": 0, "pushed": 0}
    assert _owner(again, ADMIN) == {"owner": ADMIN, "new": 0, "pushed": 0}
    assert sent == []
    # pushed and seen are separate: the bell still shows the action unread
    bell = client.get("/api/notifications", headers=hu).json
    assert next(n for n in bell["items"] if n["id"] == "act:data:missing-prices")["seen"] is False


def test_digest_off_after_turning_it_off(app, client, offline_prices, monkeypatch):
    monkeypatch.setattr(push, "send", lambda db, owner, payload: 1)
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    _subscribe(app, USER)
    _digest_on(client, h, False)
    run = client.post("/api/jobs/daily-digest", headers=JOB).json
    assert run["owners"] == [{"owner": USER, "skipped": "digest off"}]
    assert (app.extensions["ledger"].action_row(USER, "data:missing-prices") or {}).get("pushed_at") is None


def test_digest_stamps_nothing_while_push_is_off(app, client, offline_prices):
    ledger = app.extensions["ledger"]
    assert not push.enabled()                  # conftest blanks the VAPID keys: the real send returns 0
    h = auth(USER, "user")
    buy(client, h, symbol="TCS.NS")
    _subscribe(app, USER)
    _digest_on(client, h)
    run = client.post("/api/jobs/daily-digest", headers=JOB).json
    assert run["owners"] == [{"owner": USER, "new": 1, "pushed": 0}]
    assert ledger.action_row(USER, "data:missing-prices")["pushed_at"] is None
    # so a later run, once a device receives it, can still deliver
    again = client.post("/api/jobs/daily-digest", headers=JOB).json
    assert again["owners"] == [{"owner": USER, "new": 1, "pushed": 0}]


def test_digest_takes_at_most_three(app, monkeypatch):
    ledger = app.extensions["ledger"]
    ledger.set_setting(USER, "user", "marketAlerts", {"enabled": True, "push": True, "day": 5, "week": 10, "digest": True})
    visible = [act(f"drift:{i}", score=10 - i) for i in range(5)] + [act("goal:1", tier="month")]
    svc = FakeServices(ledger, visible, [], [])
    sent = []
    monkeypatch.setattr(push, "send", lambda db, owner, payload: sent.append(payload) or 2)
    res = notices.digest_owner(svc, push, USER, "user")
    assert res == {"owner": USER, "new": 3, "pushed": 2}
    assert sent[0]["title"] == "3 things need you today" and sent[0]["body"].count(" · ") == 2
    assert [k for k in ("drift:0", "drift:1", "drift:2", "drift:3") if ledger.action_row(USER, k)] == \
        ["drift:0", "drift:1", "drift:2"]
    assert notices.digest_owner(svc, push, USER, "user")["new"] == 2      # the two left, then nothing
    assert notices.digest_owner(svc, push, USER, "user")["new"] == 0


@pytest.mark.parametrize("path", ["/api/jobs/daily-digest", "/api/jobs/market-scan"])
def test_job_paths_are_public(path):
    from tracker import PUBLIC_PATHS
    assert path in PUBLIC_PATHS
