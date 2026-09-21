"""FastAPI application: JSON API plus the served UI.

Route map
  POST /api/auth/login              sign in, sets the session cookie
  GET  /api/overview                headline numbers for the current run
  GET  /api/watchlist               ranked retention watchlist
  GET  /api/employees/{id}          full employee record with drivers and curves
  GET  /api/early-attrition         the 0-30 day layer and channel quality
  GET  /api/segments?by=Site        segment risk table
  GET  /api/anomalies               abrupt behavioural changes
  POST /api/interventions           log a retention action
  GET  /api/governance              model registry, metrics, drift, fairness
  POST /api/copilot/ask             grounded question answering
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from ..config import paths, settings
from ..data import warehouse
from . import service
from .security import (SESSION_COOKIE, authenticate, create_session, csrf_guard, current_user,
                       destroy_session, purge_expired, require_role, seed_users)

app = FastAPI(title=settings.app_name, version="1.0.0",
              description="Attrition early-warning platform for EPC workforces",
              docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=800)


@app.on_event("startup")
def startup() -> None:
    warehouse.init_warehouse()
    warehouse.init_app_db()
    purge_expired()
    try:
        seed_users()
    except Exception:
        pass


def _json(payload):
    return JSONResponse(content=json.loads(json.dumps(payload, default=str)))


# ------------------------------------------------------------------ auth
@app.post("/api/auth/login")
def login(response: Response, payload: dict = Body(...)):
    user = authenticate(str(payload.get("username", "")).strip(), str(payload.get("password", "")))
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Username or password is incorrect")
    token, csrf = create_session(user["id"])
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax",
                        max_age=settings.session_ttl_hours * 3600,
                        secure=settings.env == "production")
    warehouse.log_audit(user["username"], "login")
    return {"username": user["username"], "full_name": user["full_name"],
            "role": user["role"], "csrf": csrf}


@app.post("/api/auth/logout")
def logout(response: Response, user=Depends(current_user)):
    destroy_session(user["token"])
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@app.get("/api/auth/me")
def me(user=Depends(current_user)):
    return {"username": user["username"], "full_name": user["full_name"],
            "role": user["role"], "csrf": user["csrf"]}


# ------------------------------------------------------------------ dashboards
@app.get("/api/overview")
def overview(user=Depends(current_user)):
    return _json({"kpis": service.kpis(), "trend": service.risk_trend(),
                  "movers": service.movers(12),
                  "top_priority": service.watchlist(limit=12),
                  "segments": service.segments("Site")[:8]})


@app.get("/api/watchlist")
def get_watchlist(limit: int = Query(200, le=1000), band: str | None = None,
                  site: str | None = None, department: str | None = None,
                  search: str | None = None, sort: str = "priority_score",
                  user=Depends(current_user)):
    return _json(service.watchlist(limit=limit, band=band, site=site,
                                   department=department, search=search, sort=sort))


@app.get("/api/filters")
def filters(user=Depends(current_user)):
    df = service.scored()
    if df.empty:
        return {"sites": [], "departments": [], "bands": []}
    return {"sites": sorted(df["Site"].dropna().unique().tolist()),
            "departments": sorted(df["Department"].dropna().unique().tolist()),
            "sources": sorted(df["RecruitmentSource"].dropna().unique().tolist()),
            "bands": ["Critical", "High", "Medium", "Low"]}


@app.get("/api/employees/{employee_id}")
def employee(employee_id: str, user=Depends(current_user)):
    try:
        return _json(service.employee_detail(employee_id))
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No employee {employee_id}")


@app.get("/api/segments")
def segments(by: str = Query("Site"), user=Depends(current_user)):
    allowed = {"Site", "Department", "EmploymentType", "RecruitmentSource",
               "Position", "ProjectPhase", "tenure_band"}
    if by not in allowed:
        raise HTTPException(400, f"Segment must be one of {sorted(allowed)}")
    return _json(service.segments(by))


@app.get("/api/early-attrition")
def early(user=Depends(current_user)):
    return _json(service.early_attrition())


@app.get("/api/anomalies")
def anomalies(user=Depends(current_user)):
    return _json({"items": service.anomalies(), "movers": service.movers(25)})


# ------------------------------------------------------------------ interventions
@app.get("/api/interventions")
def list_interventions(user=Depends(current_user)):
    df = warehouse.query("SELECT * FROM interventions ORDER BY created_at DESC LIMIT 500",
                         db=paths.app_db)
    return _json({"items": json.loads(df.to_json(orient="records")),
                  "effectiveness": service.intervention_effectiveness()})


@app.post("/api/interventions", status_code=201)
def create_intervention(payload: dict = Body(...), user=Depends(csrf_guard),
                        _=Depends(require_role("hr_manager"))):
    required = ("EmployeeID", "action")
    if any(not payload.get(k) for k in required):
        raise HTTPException(422, "EmployeeID and action are required")
    df = service.scored()
    row = df[df["EmployeeID"] == payload["EmployeeID"]]
    risk = float(row["risk_30"].iloc[0]) if not row.empty else None
    with warehouse.connect(paths.app_db) as c:
        cur = c.execute(
            "INSERT INTO interventions (EmployeeID, action, owner, notes, risk_at_creation,"
            " created_at, due_date, status, created_by) VALUES (?,?,?,?,?,?,?,'Open',?)",
            (payload["EmployeeID"], payload["action"], payload.get("owner"),
             payload.get("notes"), risk,
             datetime.now(timezone.utc).isoformat(timespec="seconds"),
             payload.get("due_date"), user["username"]))
        new_id = cur.lastrowid
    warehouse.log_audit(user["username"], "intervention.create",
                        {"id": new_id, "employee": payload["EmployeeID"]})
    return {"id": new_id, "status": "Open"}


@app.patch("/api/interventions/{intervention_id}")
def close_intervention(intervention_id: int, payload: dict = Body(...),
                       user=Depends(csrf_guard), _=Depends(require_role("hr_manager"))):
    outcome = payload.get("outcome")
    if outcome not in ("Retained", "Exited", "In Progress", "No Change"):
        raise HTTPException(422, "outcome must be Retained, Exited, In Progress or No Change")
    df = service.scored()
    with warehouse.connect(paths.app_db) as c:
        row = c.execute("SELECT EmployeeID FROM interventions WHERE id=?", (intervention_id,)).fetchone()
        if not row:
            raise HTTPException(404, "No such intervention")
        cur_risk = df[df["EmployeeID"] == row["EmployeeID"]]["risk_30"]
        c.execute(
            "UPDATE interventions SET outcome=?, notes=COALESCE(?, notes), status=?,"
            " risk_at_close=?, closed_at=? WHERE id=?",
            (outcome, payload.get("notes"),
             "Closed" if outcome != "In Progress" else "Open",
             float(cur_risk.iloc[0]) if len(cur_risk) else None,
             datetime.now(timezone.utc).isoformat(timespec="seconds"), intervention_id))
    warehouse.log_audit(user["username"], "intervention.update",
                        {"id": intervention_id, "outcome": outcome})
    return {"ok": True}


# ------------------------------------------------------------------ governance
@app.get("/api/governance")
def governance(user=Depends(current_user)):
    return _json(service.governance())


@app.get("/api/audit")
def audit(user=Depends(require_role("admin"))):
    df = warehouse.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 300", db=paths.app_db)
    return _json(json.loads(df.to_json(orient="records")))


@app.post("/api/score/run")
def run_scoring(user=Depends(csrf_guard), _=Depends(require_role("admin"))):
    from ..scoring.score import score_population
    result = score_population(verbose=False)
    service.clear_cache()
    warehouse.log_audit(user["username"], "score.run", result)
    return result


# ------------------------------------------------------------------ copilot
@app.post("/api/copilot/ask")
def copilot(payload: dict = Body(...), user=Depends(current_user)):
    from ..copilot.assistant import answer
    question = str(payload.get("question", "")).strip()
    if not question:
        raise HTTPException(422, "Ask a question")
    return _json(answer(question, role=user["role"]))


# ------------------------------------------------------------------ export
@app.get("/api/export/watchlist.csv")
def export_watchlist(user=Depends(current_user)):
    import pandas as pd
    df = pd.DataFrame(service.watchlist(limit=5000))
    warehouse.log_audit(user["username"], "export.watchlist", {"rows": len(df)})
    return PlainTextResponse(df.to_csv(index=False), media_type="text/csv", headers={
        "Content-Disposition": "attachment; filename=retention_watchlist.csv"})


@app.get("/api/health")
def health():
    run = service.latest_run()
    return {"status": "ok", "app": settings.app_name, "env": settings.env,
            "scored_as_of": run["as_of"] if run else None,
            "model_version": run["model_version"] if run else None}


# ------------------------------------------------------------------ UI
if paths.frontend.exists():
    app.mount("/assets", StaticFiles(directory=paths.frontend / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(paths.frontend / "index.html")

    @app.get("/{path:path}")
    def spa(path: str, request: Request):
        candidate = paths.frontend / path
        if candidate.is_file():
            return FileResponse(candidate)
        if path.startswith("api/"):
            raise HTTPException(404, "Unknown API route")
        return FileResponse(paths.frontend / "index.html")
