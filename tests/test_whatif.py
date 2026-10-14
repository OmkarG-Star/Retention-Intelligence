"""What-if simulator, sign-constrained models and the champion rule.

The projection and constraint tests run on synthetic frames. The endpoint tests
need a populated warehouse and skip cleanly without one.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from attrition.features.build import feature_columns
from attrition.models.horizon import (BLEND_MARGIN, SignConstrainedLogistic, monotone_direction,
                                      pick_champion)
from attrition.scoring import whatif


# ------------------------------------------------------------------ projection
def _one(synthetic_panel, emp="E9002"):
    weekly, master, _ = synthetic_panel
    return weekly[weekly.EmployeeID == emp].copy(), master[master.EmployeeID == emp].copy()


def test_no_change_gives_identical_projections(synthetic_panel):
    hist, master = _one(synthetic_panel)
    base, scen = whatif.project(hist, master, {})
    num, _ = feature_columns(base)
    assert np.allclose(base[num].to_numpy(float), scen[num].to_numpy(float), equal_nan=True)


def test_projection_ages_the_person_and_moves_the_snapshot_forward(synthetic_panel):
    hist, master = _one(synthetic_panel)
    base, _ = whatif.project(hist, master, {}, weeks=8)
    last = hist.sort_values("SnapshotDate").iloc[-1]
    assert base["SnapshotDate"].iloc[0] == pd.Timestamp(last["SnapshotDate"]) + pd.Timedelta(weeks=8)
    assert base["TenureDays"].iloc[0] == last["TenureDays"] + 56


def test_a_lever_moves_every_feature_of_its_family_coherently(synthetic_panel):
    """Overtime cut to 10 h for 13 weeks: the level, every rolling mean and the
    excess-over-30 composite all follow, instead of one input changing alone."""
    hist, master = _one(synthetic_panel)
    _, scen = whatif.project(hist, master, {"overtime": 10}, weeks=13)
    for col in ("OvertimeHours7D_cur", "OvertimeHours7D_mean_4w", "OvertimeHours7D_mean_13w"):
        assert scen[col].iloc[0] == pytest.approx(10.0)
    assert scen["overtime_excess"].iloc[0] == 0


def test_trimmed_history_gives_the_same_features_as_the_full_history(synthetic_panel, monkeypatch):
    hist, master = _one(synthetic_panel)
    monkeypatch.setattr(whatif, "KEEP_WEEKS", 14)          # forces a trim on the 20-week panel
    b1, s1 = whatif.project(hist, master, {"overtime": 15, "training": 1})
    monkeypatch.setattr(whatif, "KEEP_WEEKS", 10 ** 6)
    b2, s2 = whatif.project(hist, master, {"overtime": 15, "training": 1})
    num, _ = feature_columns(b1)
    for a, b in ((b1, b2), (s1, s2)):
        assert np.allclose(a[num].to_numpy(float), b[num].to_numpy(float), atol=1e-6, equal_nan=True)


def test_accommodation_lever_also_shortens_the_commute(synthetic_panel):
    hist, master = _one(synthetic_panel)
    base, scen = whatif.project(hist, master, {"accommodation": 1})
    assert scen["AccommodationProvided"].iloc[0] == 1
    assert scen["commute_burden"].iloc[0] < base["commute_burden"].iloc[0]


def test_a_raise_never_reads_as_a_smaller_hike(synthetic_panel):
    hist, master = _one(synthetic_panel)
    base, scen = whatif.project(hist, master, {"raise": 5})
    assert scen["LastHikePct"].iloc[0] == base["LastHikePct"].iloc[0]
    assert scen["SalaryVsRoleBenchmark"].iloc[0] > base["SalaryVsRoleBenchmark"].iloc[0]


def test_lever_values_are_clipped_to_their_range(synthetic_panel):
    hist, master = _one(synthetic_panel)
    _, scen = whatif.project(hist, master, {"overtime": 500})
    assert scen["OvertimeHours7D_cur"].iloc[0] == whatif.LEVER_BY_KEY["overtime"].hi


# ------------------------------------------------------------------ constraints
def test_sign_constrained_logistic_matches_sklearn_when_unconstrained():
    from sklearn.linear_model import LogisticRegression
    rng = np.random.default_rng(3)
    X = rng.normal(size=(4000, 6))
    y = (rng.random(4000) < 1 / (1 + np.exp(-(X @ [1, -1, .5, 0, 0, .3] - 1.5)))).astype(int)
    ours = SignConstrainedLogistic(C=0.1).fit(X, y)
    ref = LogisticRegression(C=0.1, max_iter=2000).fit(X, y)
    assert np.allclose(ours.coef_, ref.coef_, atol=5e-3)
    assert np.allclose(ours.decision_function(X), ref.decision_function(X), atol=2e-2)


def test_sign_bounds_hold_even_against_the_data():
    rng = np.random.default_rng(4)
    X = rng.normal(size=(3000, 3))
    y = (rng.random(3000) < 1 / (1 + np.exp(-(2 * X[:, 0] - 2 * X[:, 1])))).astype(int)
    m = SignConstrainedLogistic(C=1.0, signs=[-1, +1, 0]).fit(X, y)   # both signs wrong on purpose
    w = m.coef_.ravel()
    assert w[0] <= 1e-12 and w[1] >= -1e-12
    assert m.n_at_bound_ == 2


def test_logistic_horizon_model_fits_scores_and_explains_with_sign_bounds():
    """End to end through HorizonModel: pipeline, calibration and exact SHAP."""
    from attrition.models.horizon import HorizonModel
    rng = np.random.default_rng(5)
    n = 3000
    df = pd.DataFrame({"OvertimeHours7D_cur": rng.normal(25, 8, n), "EngagementScore_cur": rng.normal(7, 1.5, n),
                       "AccommodationProvided": rng.integers(0, 2, n), "Site": rng.choice(["A", "B"], n)})
    z = .08 * (df.OvertimeHours7D_cur - 25) - .6 * (df.EngagementScore_cur - 7) + .9 * df.AccommodationProvided - 2.5
    df["y"] = (rng.random(n) < 1 / (1 + np.exp(-z))).astype(int)   # accommodation planted with the WRONG sign
    m = HorizonModel(90, ["OvertimeHours7D_cur", "EngagementScore_cur", "AccommodationProvided"], ["Site"],
                     kind="logistic").fit(df.iloc[:2000], df.iloc[2000:], "y")
    w = m.lr_pipe.named_steps["lr"].coef_.ravel()
    assert w[0] > 0 and w[1] < 0 and w[2] <= 1e-12        # the known direction wins over the data
    p = m.predict_proba(df.iloc[2000:])
    assert ((p > 0) & (p < 1)).all()
    contrib, base = m.contributions(df.iloc[:5])
    raw = m._raw_logit(m._prepare(df.iloc[:5]))
    assert np.allclose(contrib.sum(axis=1) + base, raw, atol=1e-6)


@pytest.mark.parametrize("feature,expected", [
    ("OvertimeHours7D_cur", 1), ("OvertimeHours7D_mean_13w", 1), ("OvertimeHours7D_slope_8w", 0),
    ("EngagementScore_mean_4w", -1), ("EngagementScore_std_8w", 0), ("AccommodationProvided", -1),
    ("commute_burden", 1), ("SalaryVsRoleBenchmark", -1), ("Age", 0), ("weeks_observed", 0)])
def test_known_directions(feature, expected):
    assert monotone_direction(feature) == expected


# ------------------------------------------------------------------ champion rule
class _C:
    def __init__(self, v):
        self.valid_pr_auc_ = v


def test_blend_serves_when_candidates_are_tied():
    assert pick_champion({"lgbm": _C(.330), "logistic": _C(.335), "blend": _C(.329)}) == "blend"


def test_a_clear_single_winner_still_serves():
    gap = BLEND_MARGIN + 0.005
    assert pick_champion({"lgbm": _C(.30), "logistic": _C(.30 + gap), "blend": _C(.30)}) == "logistic"


def test_without_a_blend_the_best_validation_score_serves():
    assert pick_champion({"logistic": _C(.2)}) == "logistic"


# ------------------------------------------------------------------ endpoint
@pytest.fixture()
def client(require_warehouse):
    from fastapi.testclient import TestClient
    from attrition.api.main import app
    with TestClient(app) as c:
        c.post("/api/auth/login", json={"username": "viewer", "password": "Viewer@2026"})
        yield c


def test_whatif_endpoint_returns_both_projections_for_every_horizon(client):
    emp = client.get("/api/watchlist", params={"limit": 1}).json()[0]["EmployeeID"]
    r = client.post(f"/api/employees/{emp}/whatif", json={"changes": {"overtime": 0}, "weeks": 8})
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d["baseline"]) == set(d["scenario"]) == {"7", "15", "30", "90", "180"}
    for side in ("baseline", "scenario"):
        risks = [d[side][h] for h in ("7", "15", "30", "90", "180")]
        assert risks == sorted(risks)
    assert {lv["key"] for lv in d["levers"]} == {lv.key for lv in whatif.LEVERS}


def test_cutting_overtime_never_raises_the_risk_of_a_high_risk_person(client):
    rows = client.get("/api/watchlist", params={"limit": 5}).json()
    for row in rows:
        d = client.post(f"/api/employees/{row['EmployeeID']}/whatif", json={"changes": {"overtime": 0}}).json()
        assert d["scenario"]["90"] <= d["baseline"]["90"] + 1e-9


def test_whatif_rejects_bad_input_and_unknown_people(client):
    emp = client.get("/api/watchlist", params={"limit": 1}).json()[0]["EmployeeID"]
    assert client.post(f"/api/employees/{emp}/whatif", json={"changes": {"overtime": "lots"}}).status_code == 422
    assert client.post("/api/employees/NOPE/whatif", json={}).status_code == 404


@pytest.mark.parametrize("changes", [{}, {"overtime": 12, "promote": 1}, {"accommodation": 1, "raise": 8}])
def test_batched_projection_matches_one_person_at_a_time(synthetic_panel, changes):
    weekly, master, _ = synthetic_panel
    many = whatif.project_many(weekly, master, changes).set_index("EmployeeID")
    num, _ = feature_columns(many.reset_index())
    for emp in ("E9001", "E9002"):
        _, one = whatif.project(weekly[weekly.EmployeeID == emp], master[master.EmployeeID == emp], changes)
        a = many.loc[emp, num].to_numpy(float)
        b = one.iloc[0][num].to_numpy(float)
        assert np.allclose(a, b, atol=1e-6, equal_nan=True), emp
