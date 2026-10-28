from flask import Blueprint, current_app, g, jsonify, request

from ..security import ROLES, admin_required, issue_token, verify_google_token

bp = Blueprint("auth", __name__)


def _dir():
    return current_app.extensions["directory"]


@bp.post("/auth/google-login")
def google_login():
    token = (request.get_json(silent=True) or {}).get("token")
    if not token:
        return jsonify({"error": "Token is required"}), 400
    info = verify_google_token(token)
    if not info:
        return jsonify({"error": "Google sign-in could not be verified"}), 401
    role = _dir().role(info["email"])
    if not role:
        return jsonify({"error": "Access denied. Ask the admin to add your email."}), 403
    _dir().record_login(info)
    return jsonify({"token": issue_token(info["email"], role),
                    "user": {"email": info["email"], "name": info.get("name"), "picture": info.get("picture"), "role": role}})


@bp.get("/auth/me")
def me():
    prof = _dir().profile(g.email)
    return jsonify({"email": g.email, "role": g.role, "name": prof.get("name"), "picture": prof.get("picture"),
                    "real_email": g.real_email, "real_role": g.real_role, "impersonating": g.impersonating})


@bp.get("/admin/users")
@admin_required
def list_users():
    return jsonify({"users": _dir().list()})


@bp.post("/admin/users")
@admin_required
def add_user():
    data = request.get_json(silent=True) or {}
    email, role = (data.get("email") or "").strip(), (data.get("role") or "user").strip()
    if "@" not in email:
        return jsonify({"error": "A valid email is required"}), 400
    if role not in ROLES:
        return jsonify({"error": "Role must be admin, user or guest"}), 400
    try:
        _dir().add(email, role)
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    return jsonify({"message": f"Added {email} as {role}"}), 201


@bp.patch("/admin/users/<path:email>")
@admin_required
def set_role(email):
    role = ((request.get_json(silent=True) or {}).get("role") or "").strip()
    if role not in ROLES:
        return jsonify({"error": "Role must be admin, user or guest"}), 400
    if email.lower() == g.real_email.lower() and role != "admin":
        return jsonify({"error": "You cannot remove your own admin role"}), 400
    if not _dir().set_role(email, role):
        return jsonify({"error": "User not found"}), 404
    return jsonify({"message": f"{email} is now {role}"})


@bp.delete("/admin/users/<path:email>")
@admin_required
def remove_user(email):
    if email.lower() == g.real_email.lower():
        return jsonify({"error": "You cannot remove yourself"}), 400
    if not _dir().remove(email):
        return jsonify({"error": "User not found"}), 404
    return jsonify({"message": f"Removed {email}"})
