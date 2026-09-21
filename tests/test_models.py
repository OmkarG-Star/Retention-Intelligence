"""Modelling layer: explanations, survival curves, anomaly scoring, metrics."""
from __future__ import annotations

import numpy as np
import pandas as pd

from attrition.models.evaluate import calibration_bins, discrimination, psi
from attrition.models.explain import pretty, recommended_actions, top_drivers
from attrition.models.survival import DiscreteTimeSurvival, kaplan_meier


def test_feature_names_translate_into_hr_language():
    label, category = pretty("OvertimeHours7D_slope_8w")
    assert category == "Workload"
    assert "overtime" in label.lower()
    # anything unmapped still returns a readable label rather than raising
    label, category = pretty("some_unmapped_column_xyz")
    assert isinstance(label, str) and label
    assert isinstance(category, str) and category


def test_shap_contributions_become_signed_probability_impacts():
    names = ["OvertimeHours7D_mean_4w", "EngagementScore_slope_8w", "TrainingCountToDate"]
    contrib = np.array([1.2, 0.8, -0.5])
    values = pd.Series({"OvertimeHours7D_mean_4w": 48.0,
                        "EngagementScore_slope_8w": -0.31,
                        "TrainingCountToDate": 3})
    drivers = top_drivers(contrib, names, base_value=-3.5, values=values, top_n=5)

    assert drivers, "expected at least one driver"
    assert drivers[0]["direction"] == "increases"
    assert drivers[0]["impact_pct"] > 0
    assert any(d["direction"] == "reduces" and d["impact_pct"] < 0 for d in drivers)
    # ranking is by absolute impact
    magnitudes = [abs(d["impact_pct"]) for d in drivers]
    assert magnitudes == sorted(magnitudes, reverse=True)


def test_actions_are_suggested_only_for_risk_increasing_drivers():
    drivers = [
        {"label": "Sustained overtime", "category": "Workload", "direction": "increases", "impact_pct": 9.0},
        {"label": "Recent training", "category": "Career", "direction": "reduces", "impact_pct": -3.0},
        {"label": "Engagement declining", "category": "Sentiment", "direction": "increases", "impact_pct": 6.0},
    ]
    actions = recommended_actions(drivers, limit=3)
    assert {a["category"] for a in actions} == {"Workload", "Sentiment"}
    assert all(a["action"] for a in actions)


def _survival_frame(n: int = 600, seed: int = 3) -> tuple[pd.DataFrame, list[str], list[str]]:
    rng = np.random.default_rng(seed)
    overtime = rng.normal(30, 10, n)
    engagement = rng.normal(7, 1.2, n)
    hazard = 1 / (1 + np.exp(-(-3.0 + 0.05 * (overtime - 30) - 0.35 * (engagement - 7))))
    duration = np.clip(rng.geometric(np.clip(hazard, 1e-3, 0.9)) * 7, 7, 400)
    censored = rng.random(n) < 0.35
    df = pd.DataFrame({
        "OvertimeHours7D_mean_4w": overtime,
        "EngagementScore_mean_4w": engagement,
        "TenureBand": rng.choice(["31-90 days", "91-180 days", "1-2 years"], n),
        "duration_days": duration,
        "event_observed": (~censored).astype(int),
    })
    return df, ["OvertimeHours7D_mean_4w", "EngagementScore_mean_4w"], ["TenureBand"]


def test_survival_curve_is_monotone_and_bounded():
    df, numeric, categorical = _survival_frame()
    model = DiscreteTimeSurvival(numeric, categorical).fit(df)
    curve = model.survival_curve(df.head(25))

    assert curve.shape[0] == 25
    assert (curve <= 1.0 + 1e-9).all() and (curve >= 0.0).all()
    diffs = np.diff(curve, axis=1)
    assert (diffs <= 1e-9).all(), "survival probability can only fall as the horizon extends"


def test_expected_days_is_positive_and_ordered_by_risk():
    df, numeric, categorical = _survival_frame()
    model = DiscreteTimeSurvival(numeric, categorical).fit(df)
    days = model.expected_days(df)
    assert (days > 0).all()

    stressed = df.copy()
    stressed["OvertimeHours7D_mean_4w"] += 30
    stressed["EngagementScore_mean_4w"] -= 2.5
    assert model.expected_days(stressed).mean() < days.mean(), (
        "higher overtime and lower engagement must shorten expected retained time")


def test_curve_points_are_json_serialisable():
    df, numeric, categorical = _survival_frame(n=200)
    model = DiscreteTimeSurvival(numeric, categorical).fit(df)
    points = model.curve_points(df.head(3))
    assert len(points) == 3
    first = points[0]
    assert {"day", "survival"} <= set(first[0])
    assert first[0]["survival"] >= first[-1]["survival"]


def test_kaplan_meier_starts_at_one_and_never_rises():
    rng = np.random.default_rng(11)
    durations = rng.integers(10, 380, 400)
    events = rng.random(400) < 0.5
    km = kaplan_meier(durations, events.astype(int))
    surv = [p["survival"] for p in km]
    assert surv[0] <= 1.0
    assert all(b <= a + 1e-9 for a, b in zip(surv, surv[1:]))


def test_anomaly_scores_are_bounded_and_flag_injected_outliers():
    from attrition.models.anomaly import AnomalyDetector

    rng = np.random.default_rng(5)
    n = 900
    df = pd.DataFrame({
        "OvertimeHours7D_delta_4w": rng.normal(0, 2, n),
        "AbsenceDays7D_delta_4w": rng.normal(0, 0.4, n),
        "EngagementScore_delta_4w": rng.normal(0, 0.3, n),
        "AttendancePct_delta_4w": rng.normal(0, 1.5, n),
        "PerformanceRating_delta_4w": rng.normal(0, 0.1, n),
    })
    df.loc[:9, "OvertimeHours7D_delta_4w"] = 55
    df.loc[:9, "AbsenceDays7D_delta_4w"] = 5
    df.loc[:9, "EngagementScore_delta_4w"] = -4

    det = AnomalyDetector().fit(df)
    scores = det.score(df)
    assert scores.min() >= 0 and scores.max() <= 100
    assert scores[:10].mean() > scores[10:].mean(), "injected outliers should score higher"


def test_discrimination_metrics_reward_a_good_ranking():
    rng = np.random.default_rng(2)
    y = (rng.random(2000) < 0.05).astype(int)
    good = np.clip(y * 0.6 + rng.random(2000) * 0.3, 0, 1)
    random_scores = rng.random(2000)

    m_good = discrimination(y, good)
    m_rand = discrimination(y, random_scores)
    assert m_good["roc_auc"] > m_rand["roc_auc"]
    assert m_good["pr_auc"] > m_rand["pr_auc"]
    assert m_good["recall_at_10"] >= m_rand["recall_at_10"]
    assert 0.0 <= m_good["brier"] <= 1.0


def test_calibration_bins_summarise_predicted_against_actual():
    rng = np.random.default_rng(4)
    p = rng.random(1500)
    y = (rng.random(1500) < p).astype(int)
    bins = calibration_bins(y, p, n_bins=10)
    assert len(bins) <= 10
    assert sum(b["n"] for b in bins) == 1500
    for b in bins:
        assert 0.0 <= b["predicted"] <= 1.0 and 0.0 <= b["observed"] <= 1.0
    # a well-calibrated generator should track the diagonal closely
    gap = max(abs(b["predicted"] - b["observed"]) for b in bins)
    assert gap < 0.15, "calibration curve drifted far from the diagonal on calibrated input"


def test_psi_is_zero_for_identical_distributions_and_grows_when_they_shift():
    rng = np.random.default_rng(6)
    base = rng.normal(0, 1, 4000)
    same = rng.normal(0, 1, 4000)
    shifted = rng.normal(1.6, 1, 4000)
    assert psi(base, same) < 0.1
    assert psi(base, shifted) > psi(base, same)
