"""Security primitives and the HTTP surface.

The endpoint tests need a populated warehouse, so they skip when the pipeline
has not been run. The password and session tests run unconditionally.
"""
from __future__ import annotations

import pytest

from attrition.api.security import ROLE_RANK, SESSION_COOKIE, hash_password, verify_password


# ------------------------------------------------------------------ passwords
def test_password_hashing_is_salted_and_verifies():
    a = hash_password("Admin@2026")
    b = hash_password("Admin@2026")
    assert a != b, "each hash must carry its own random salt"
    assert a.startswith("scrypt$")
    assert verify_password("Admin@2026", a)
    assert verify_password("Admin@2026", b)


def test_wrong_password_and_malformed_hashes_are_rejected():
    stored = hash_password("correct-horse")
    assert not verify_password("Correct-Horse", stored)
    assert not verify_password("", stored)
    for junk in ("", "not-a-hash", "md5$aa$bb", "scrypt$zz"):
        assert not verify_password("anything", junk)


def test_plaintext_never_appears_in_the_stored_hash():
    secret = "Sup3rSecretPass!"
    assert secret not in hash_password(secret)


def test_role_ranking_is_ordered():
    assert ROLE_RANK["admin"] > ROLE_RANK["hr_manager"] > ROLE_RANK["viewer"]


# ------------------------------------------------------------------ endpoints
@pytest.fixture()
def client(require_warehouse):
    from fastapi.testclient import TestClient
    from attrition.api.main import app
    with TestClient(app) as c:
        yield c


def _login(client, username="admin", password="Admin@2026"):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["csrf"]


def test_health_is_public(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] in {"ok", "degraded"}


def test_protected_routes_require_a_session(client):
    for path in ("/api/overview", "/api/watchlist", "/api/governance", "/api/auth/me"):
        assert client.get(path).status_code in (401, 403), f"{path} was reachable anonymously"


def test_bad_credentials_are_refused(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401
    assert SESSION_COOKIE not in r.cookies


def test_login_then_read_the_dashboard(client):
    _login(client)
    me = client.get("/api/auth/me").json()
    assert me["username"] == "admin" and me["role"] == "admin"

    overview = client.get("/api/overview").json()
    assert overview["kpis"]["headcount"] > 0
    assert set(overview["kpis"]) >= {"headcount", "critical", "high"}

    watchlist = client.get("/api/watchlist", params={"limit": 10}).json()
    assert watchlist, "a scored workforce should produce a watchlist"
    row = watchlist[0]
    assert {"EmployeeID", "risk_30", "risk_band", "priority_band"} <= set(row)
    assert 0.0 <= row["risk_30"] <= 1.0


def test_employee_detail_carries_drivers_survival_and_actions(client):
    _login(client)
    emp = client.get("/api/watchlist", params={"limit": 1}).json()[0]["EmployeeID"]
    detail = client.get(f"/api/employees/{emp}").json()

    assert detail["profile"]["EmployeeID"] == emp
    assert detail["drivers"], "every prediction must be explainable"
    assert {"label", "impact_pct", "direction", "category"} <= set(detail["drivers"][0])
    curve = detail["survival_curve"]
    assert curve and curve[0]["survival"] >= curve[-1]["survival"]
    assert isinstance(detail["actions"], list)


def test_mutations_need_the_csrf_header(client):
    _login(client)  # deliberately discard the token
    body = {"employee_id": "E0001", "intervention_type": "Manager discussion",
            "owner": "hr.manager", "notes": "test"}
    assert client.post("/api/interventions", json=body).status_code == 403


def test_viewer_cannot_create_interventions(client):
    csrf = _login(client, "viewer", "Viewer@2026")
    body = {"employee_id": "E0001", "intervention_type": "Manager discussion",
            "owner": "viewer", "notes": "test"}
    r = client.post("/api/interventions", json=body, headers={"x-csrf-token": csrf})
    assert r.status_code == 403


def test_copilot_answers_from_stored_results(client):
    _login(client)
    csrf = _login(client)
    r = client.post("/api/copilot/ask", json={"question": "What are the top attrition drivers this month?"},
                    headers={"x-csrf-token": csrf})
    assert r.status_code == 200
    payload = r.json()
    assert payload["answer"].strip()
    assert "facts" in payload and payload["intent"]


def test_watchlist_csv_export(client):
    _login(client)
    r = client.get("/api/export/watchlist.csv")
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    assert "EmployeeID" in r.text.splitlines()[0]


def test_unknown_paths_fall_through_to_the_single_page_app(client):
    r = client.get("/watchlist")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


def test_logout_invalidates_the_session(client):
    csrf = _login(client)
    assert client.post("/api/auth/logout", headers={"x-csrf-token": csrf}).status_code == 200
    assert client.get("/api/overview").status_code in (401, 403)


def test_env_password_overrides_lock_privileged_demo_accounts(client, monkeypatch):
    from attrition.api.security import apply_password_overrides, public_demo_accounts

    monkeypatch.setenv("ADMIN_PASSWORD", "a-long-private-value-123")
    try:
        assert apply_password_overrides() == ["admin"]
        assert "admin" not in public_demo_accounts()
        assert "admin" not in client.get("/api/health").json()["demo_accounts"]

        bad = client.post("/api/auth/login", json={"username": "admin", "password": "Admin@2026"})
        assert bad.status_code == 401
        _login(client, "admin", "a-long-private-value-123")
    finally:
        # restore the demo password so other tests keep working
        monkeypatch.setenv("ADMIN_PASSWORD", "Admin@2026")
        apply_password_overrides()


def test_workforce_strip_lists_every_scored_employee_once(client):
    _login(client)
    wf = client.get("/api/workforce").json()
    rows = wf["rows"]
    assert wf["columns"][0] == "EmployeeID" and rows
    ids = [r[0] for r in rows]
    assert len(ids) == len(set(ids)), "one mark per person"
    risk = [r[wf["columns"].index("risk_90")] for r in rows]
    assert risk == sorted(risk, reverse=True), "strip is ordered by 90-day risk"
    assert len(rows) == client.get("/api/overview").json()["kpis"]["headcount"]


def test_overview_carries_an_honest_trust_summary(client):
    _login(client)
    trust = client.get("/api/overview").json()["trust"]
    assert trust["band_horizon"] == 90
    lo, hi = trust["pr_auc_ci"]
    assert lo <= trust["pr_auc"] <= hi
    assert trust["lead_time_4w"] > trust["random"], "the list must beat random flagging"


def test_governance_exposes_champion_and_validation(client):
    _login(client)
    cur = client.get("/api/governance").json()["current"]
    assert set(cur["champions"].values()) <= {"lgbm", "logistic", "blend"}
    for h, m in cur["metrics"].items():
        assert m["champion"] in m["candidates"]
        assert m["candidates"][m["champion"]]["champion"] is True
    val = cur["validation"]
    assert {"lead_time", "shap_recovery", "survival"} <= set(val)
    assert all(n["verdict"] == "ignored" for n in val["shap_recovery"]["noise_controls"])


def test_horizon_risks_are_monotone_and_match_the_curve(client):
    _login(client)
    emp = client.get("/api/watchlist", params={"limit": 1}).json()[0]["EmployeeID"]
    d = client.get(f"/api/employees/{emp}").json()
    p = d["profile"]
    risks = [p[f"risk_{h}"] for h in (7, 15, 30, 90, 180)]
    assert risks == sorted(risks), "a longer horizon can never be less likely"
    by_day = {pt["day"]: pt["survival"] for pt in d["survival_curve"]}
    assert abs(by_day[90] - (1 - p["risk_90"])) < 1e-3, "curve and headline must agree"


def test_trend_has_one_point_per_scoring_date(client):
    """Re-scoring a week adds a second run for that date; the trend must not double it."""
    _login(client)
    trend = client.get("/api/overview").json()["trend"]
    dates = [t["as_of"] for t in trend]
    assert dates and len(dates) == len(set(dates))
    runs = client.get("/api/governance").json()["runs"]
    assert len({r["as_of"] for r in runs}) == len(runs)


def test_model_lab_carries_curves_importance_and_valid_responses(client):
    _login(client, "viewer", "Viewer@2026")
    d = client.get("/api/model-lab").json()
    assert d["status"] == "ok" and d["headcount"] > 0
    h = d["horizons"][str(d["band_horizon"])]
    ks = [c["k"] for c in h["operating_curve"]]
    assert 15 in ks and ks == sorted(ks)
    shares = [a["share"] for a in h["importance"]["areas"]]
    assert abs(sum(shares) - 1) < 0.02 and shares == sorted(shares, reverse=True)
    if d["response_curves"]:                       # only shown when it describes the live model
        ot = [p["mean"] for p in d["response_curves"]["levers"]["overtime"]["points"]]
        assert ot == sorted(ot), "more overtime never lowers average risk"
