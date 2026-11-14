"""The bell and the daily digest (SPEC §8.6, AMENDMENTS R9, R10, K7, D15).

A composition over existing `Services` methods only: `actions` (the visible, ranked action list), `upcoming`
(Coming up, 90 days), `_market_notices` (price alerts and IPO dates) and the shared context behind them. It
adds no engine and no memo: the seen state is read live from `action_log` on every call (K7), so it is never
cached, while everything it composes is already memoised.

Notice ids and their action_log rows (K7, R9):
- `act:<action id>` -> (the action's owner, else the settings owner; `<action id>`);
- every other notice id (`cal:…`, `mkt:…`, `ipo:…`) -> (the settings owner; `notice:<notice id>`).
"Seen" is `seen_at IS NOT NULL` on that row (D15: never a setting, because a setting write flushes every memo).
"""
from __future__ import annotations

from datetime import date

from .analytics import actions as actions_mod

ACT, NOTICE = "act:", "notice:"
EVENT_DAYS = 7                      # Coming-up events within a week join the bell
SEVERITY = {"crit": "critical", "warn": "warning"}   # info and pos read 'info'
ORDER = {"critical": 0, "warning": 1, "info": 2}
DIGEST_MAX = 3
MAX_SEEN_IDS = 100
MAX_ID_LEN = 200


# ── pieces (pure) ──

def visible_actions(payload: dict) -> list[dict]:
    """The open and planned actions of an /actions payload in rank order (tier, then score, then id)."""
    rows = [*(payload.get("actions") or []), *(payload.get("planned") or [])]
    return sorted(rows, key=lambda a: (actions_mod.TIER_ORDER.get(a.get("tier"), len(actions_mod.TIER_ORDER)),
                                       -(a.get("score") or 0), a.get("id") or ""))


def action_link(a: dict) -> str:
    """Where a tap goes: the CTA's route, else the action's own link, else its row on Actions."""
    return actions_mod.cta_href(a.get("cta")) or a.get("link") or f"/actions?id={a['id']}"


def _days(due: str | None, today: date) -> int | None:
    try:
        return (date.fromisoformat(str(due)[:10]) - today).days if due else None
    except ValueError:
        return None


def action_notice(a: dict, today: date) -> dict:
    """One tier-now action as a Notice {id act:<id>, kind = category, title, body = detail, date = due, days, link,
    severity}."""
    return {"id": ACT + a["id"], "kind": a.get("category") or "action", "title": a.get("title") or "",
            "body": a.get("detail") or "", "date": a.get("due"), "days": _days(a.get("due"), today),
            "link": action_link(a), "severity": SEVERITY.get(a.get("severity"), "info")}


def covered(event: dict, visible: list[dict]) -> bool:
    """R9: an event an action already speaks for. `fd:<iid>` / `p2p:<iid>` name the instrument of any visible
    action; `sip:<pid>:<date>` matches a visible `sip:due:<pid>:<date>` or `sip:missed:<pid>:<date>`."""
    key = str(event.get("key") or "")
    head, _, rest = key.partition(":")
    if head in ("fd", "p2p"):
        try:
            iid = int(rest)
        except ValueError:          # a folded p2p:<YYYY-MM> close names no instrument
            return False
        return any(a.get("instrument_id") == iid for a in visible)
    if head == "sip" and rest:
        ids = {a.get("id") for a in visible}
        return f"sip:due:{rest}" in ids or f"sip:missed:{rest}" in ids
    return False


def event_notices(events: list[dict], visible: list[dict]) -> list[dict]:
    """Coming-up events within EVENT_DAYS that no visible action covers. IPO dates are left to the market notices,
    which already list them."""
    out = []
    for e in events or []:
        days = e.get("days")
        if days is None or days > EVENT_DAYS or e.get("kind") == "ipo" or covered(e, visible):
            continue
        out.append({"id": f"cal:{e.get('key')}:{e.get('date')}", "kind": e.get("kind"), "title": e.get("title") or "",
                    "body": e.get("note") or "", "date": e.get("date"), "days": days, "link": e.get("link"),
                    "severity": "warning" if e.get("kind") == "tax" else "info"})
    return out


def sort_notices(items: list[dict]) -> list[dict]:
    """By severity (critical, warning, info), then days (undated last); stable, so action rank order holds."""
    return sorted(items, key=lambda n: (ORDER.get(n.get("severity"), 3), n["days"] if n.get("days") is not None else 99))


def log_key(notice_id: str, owner: str, action_owners: dict[str, str]) -> tuple[str, str]:
    """The action_log row of a notice id (K7). `action_owners` maps visible action ids to their owners."""
    if notice_id.startswith(ACT):
        aid = notice_id[len(ACT):]
        if aid.startswith(actions_mod.ACTION_PREFIXES) and not aid.startswith(NOTICE):
            return action_owners.get(aid) or owner, aid
    return owner, NOTICE + notice_id


# ── the composition ──

def _actions(svc, scope, settings, owner) -> list[dict] | None:
    try:
        return visible_actions(svc.actions(scope, settings, owner=owner))
    except Exception as e:  # noqa: BLE001 — the bell must still ring
        print(f"[notifications] actions unavailable: {e!r}")
        return None


def _owners(visible: list[dict] | None, owner: str) -> dict[str, str]:
    return {a["id"]: a.get("owner") or owner for a in visible or []}


def notifications(svc, scope: str | None, settings: dict, owner: str, today: date | None = None) -> dict:
    """GET /notifications: {items: Notice[] (each with `seen`), unread}.

    Items are the visible tier-now actions (`act:` ids, in rank order), Coming-up events within a week that no
    visible action covers, and the market notices unchanged; sorted by severity, then days. A failed source is
    left out (and printed) rather than failing the bell. Not memoised: seen is read live (K7)."""
    today = today or date.today()
    visible = _actions(svc, scope, settings, owner)
    items = [action_notice(a, today) for a in visible or [] if a.get("tier") == "now"]
    try:
        events = svc.upcoming(scope, settings, owner)["events"]
    except Exception as e:  # noqa: BLE001
        print(f"[notifications] coming up unavailable: {e!r}")
        events = []
    items += event_notices(events, visible or [])
    try:
        items += svc._market_notices(scope)
    except Exception as e:  # noqa: BLE001
        print(f"[notifications] market notices unavailable: {e!r}")
    items = sort_notices(items)
    owners = _owners(visible, owner)
    keys = {n["id"]: log_key(n["id"], owner, owners) for n in items}
    stamps = svc.ledger.log_stamps(keys.values())
    out = [{**n, "seen": bool((stamps.get(keys[n["id"]]) or {}).get("seen_at"))} for n in items]
    return {"items": out, "unread": sum(1 for n in out if not n["seen"])}


def validate_ids(raw) -> list[str]:
    """POST /notifications/seen ids: a list of ≤ MAX_SEEN_IDS non-empty strings of ≤ MAX_ID_LEN characters.
    Raises ValueError (a 400)."""
    if not isinstance(raw, list):
        raise ValueError("ids must be a list of notice ids")
    if len(raw) > MAX_SEEN_IDS:
        raise ValueError(f"At most {MAX_SEEN_IDS} ids at a time")
    if not all(isinstance(i, str) and 0 < len(i) <= MAX_ID_LEN for i in raw):
        raise ValueError(f"Each id must be text of 1 to {MAX_ID_LEN} characters")
    return list(dict.fromkeys(raw))


def mark_seen(svc, scope: str | None, settings: dict, owner: str, ids: list[str], today: date | None = None) -> dict:
    """Record these notice ids as seen (R9): each maps to its action_log row as `log_key` says, `mark_seen` runs
    once per row owner, and an unknown id is recorded the K7 way (a `notice:` row closed as seen, or an open row).
    Returns {unread} recounted."""
    owners = _owners(_actions(svc, scope, settings, owner), owner)
    by_owner: dict[str, list[str]] = {}
    for nid in ids:
        row_owner, row_id = log_key(nid, owner, owners)
        by_owner.setdefault(row_owner, []).append(row_id)
    for row_owner, row_ids in by_owner.items():
        svc.ledger.mark_seen(row_owner, row_ids)
    return {"unread": notifications(svc, scope, settings, owner, today)["unread"]}


# ── the daily digest (R10) ──

def digest_payload(picked: list[dict]) -> dict | None:
    """The one push for a digest: the action itself when there is one, else a count with the titles."""
    if not picked:
        return None
    if len(picked) == 1:
        a = picked[0]
        return {"title": a.get("title") or "One thing needs you today", "body": a.get("detail") or "",
                "url": action_link(a), "tag": "digest"}
    return {"title": f"{len(picked)} things need you today", "body": " · ".join(a.get("title") or "" for a in picked),
            "url": "/actions", "tag": "digest"}


def digest_owner(svc, push_mod, owner: str, role: str | None) -> dict:
    """One recipient of the daily digest: ≤ DIGEST_MAX tier-now actions never pushed before, as one push.

    scope = the owner for a user, None (the family Home) for an admin or a guest; the log owner is the settings
    owner. `pushed_at` is stamped only when a device received the push, so a run with push off, or with no device,
    leaves them for a later run. Returns {owner, new, pushed} or {owner, skipped}."""
    if not role:
        return {"owner": owner, "skipped": "not a member"}
    ledger = svc.ledger
    settings = ledger.get_settings(owner, role)
    if (settings.get("marketAlerts") or {}).get("digest") is not True:
        return {"owner": owner, "skipped": "digest off"}
    scope = owner if role == "user" else None
    log_owner = ledger.settings_owner(owner, role)
    now = [a for a in svc.actions(scope, settings, owner=log_owner)["actions"] if a.get("tier") == "now"]
    stamps = ledger.log_stamps((a.get("owner") or log_owner, a["id"]) for a in now)
    picked = [a for a in now if not (stamps.get((a.get("owner") or log_owner, a["id"])) or {}).get("pushed_at")]
    picked = picked[:DIGEST_MAX]
    sent = push_mod.send(ledger.db, owner, digest_payload(picked)) if picked else 0
    if sent > 0:
        by_owner: dict[str, list[str]] = {}
        for a in picked:
            by_owner.setdefault(a.get("owner") or log_owner, []).append(a["id"])
        for row_owner, ids in by_owner.items():
            ledger.mark_pushed(row_owner, ids)
    return {"owner": owner, "new": len(picked), "pushed": sent}
