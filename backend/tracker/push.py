"""Web Push (VAPID) to browsers and phones that opted in. Disabled until VAPID keys are configured:
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, as printed by `python manage.py vapid-keys`) and
VAPID_SUBJECT (a mailto: or https: contact for the push services)."""
from __future__ import annotations

import json
import os

from .migrations import now_iso


def public_key() -> str | None:
    return os.environ.get("VAPID_PUBLIC_KEY") or None


def enabled() -> bool:
    return bool(public_key() and os.environ.get("VAPID_PRIVATE_KEY"))


def generate_keys() -> tuple[str, str]:
    """(public, private) as base64url strings, the form browsers and pywebpush expect."""
    import base64
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    priv = key.private_numbers().private_value.to_bytes(32, "big")
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
    return b64(pub), b64(priv)


def subscribe(db, owner: str, sub: dict, device: str | None):
    keys = sub.get("keys") or {}
    if not (sub.get("endpoint") and keys.get("p256dh") and keys.get("auth")):
        raise ValueError("incomplete push subscription")
    db.execute("INSERT INTO push_subscriptions (owner, endpoint, p256dh, auth, device, created_at) VALUES (?,?,?,?,?,?) "
               "ON CONFLICT(endpoint) DO UPDATE SET owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth, "
               "device = excluded.device", (owner, sub["endpoint"], keys["p256dh"], keys["auth"], (device or "")[:120], now_iso()))


def unsubscribe(db, owner: str, endpoint: str | None, everywhere: bool = False):
    """One device by its endpoint, or every device only when asked explicitly."""
    if endpoint:
        db.execute("DELETE FROM push_subscriptions WHERE owner = ? AND endpoint = ?", (owner, endpoint))
    elif everywhere:
        db.execute("DELETE FROM push_subscriptions WHERE owner = ?", (owner,))


def devices(db, owner: str) -> int:
    return db.one("SELECT COUNT(*) AS n FROM push_subscriptions WHERE owner = ?", (owner,))["n"]


def message(payload: dict) -> dict:
    """{title, body, url, tag} in the shape Angular's service worker shows; a tap opens `url` in the app."""
    return {"notification": {"title": payload["title"], "body": payload.get("body") or "", "tag": payload.get("tag"),
                             "icon": "icons/icon-192x192.png", "badge": "icons/icon-72x72.png", "renotify": True,
                             "data": {"onActionClick": {"default": {"operation": "navigateLastFocusedOrOpen",
                                                                     "url": payload.get("url") or "/"}}}}}


def send(db, owner: str, payload: dict) -> int:
    """Deliver to every device of `owner`; subscriptions the push service says are gone are removed."""
    if not enabled():
        return 0
    from pywebpush import WebPushException, webpush
    subs = db.query("SELECT * FROM push_subscriptions WHERE owner = ?", (owner,))
    sent = 0
    for s in subs:
        try:
            webpush({"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                    json.dumps(message(payload)), vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
                    vapid_claims={"sub": os.environ.get("VAPID_SUBJECT") or "mailto:alerts@invalid.example"}, ttl=6 * 3600)
            db.execute("UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?", (now_iso(), s["id"]))
            sent += 1
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):  # unsubscribed or expired on the device
                db.execute("DELETE FROM push_subscriptions WHERE id = ?", (s["id"],))
            else:
                print(f"[push] {owner}: {e}")
        except Exception as e:  # noqa: BLE001 — one bad device must not stop the rest
            print(f"[push] {owner}: {e}")
    return sent
