from datetime import date

from flask import Blueprint, Response, current_app, g, jsonify, request

from .. import domain as d
from ..ledger import NotFound
from ..reports import CATALOG, CATALOG_BY_KEY, ReportContext, build_report, to_xlsx

bp = Blueprint("reports", __name__)


def _names() -> dict[str, str]:
    return {r["email"].lower(): (r.get("name") or r["email"].split("@")[0])
            for r in current_app.extensions["directory"].list()}


def _context() -> ReportContext:
    svc = current_app.extensions["services"]
    return ReportContext(svc, g.scope, svc.settings(), _names(), request.args.to_dict())


def _portfolio_label() -> str:
    return "Family portfolio" if g.scope is None else f"{_names().get(g.scope.lower(), g.scope)}'s portfolio"


@bp.get("/reports")
def catalog():
    this_fy = d.fy_of(date.today().isoformat())
    start = int(this_fy[2:6])
    years = [f"FY{y}-{str(y + 1)[2:]}" for y in range(start, start - 6, -1)]
    return jsonify({"reports": CATALOG, "years": years, "asset_classes": list(d.ASSET_CLASSES)})


@bp.get("/reports/<key>")
def report(key):
    if key not in CATALOG_BY_KEY:
        raise NotFound("No such report")
    return jsonify({**build_report(key, _context()), "portfolio": _portfolio_label()})


@bp.get("/reports/<key>/export.xlsx")
def export(key):
    if key not in CATALOG_BY_KEY:
        raise NotFound("No such report")
    rep = build_report(key, _context())
    data = to_xlsx(rep, _portfolio_label())
    name = f"{key}-{date.today().isoformat()}.xlsx"
    return Response(data, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
