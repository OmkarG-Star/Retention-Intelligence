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
