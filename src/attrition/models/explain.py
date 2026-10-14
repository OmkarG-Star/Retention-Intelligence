"""Explanation layer.

Two jobs. First, turn SHAP log-odds contributions into the probability impact HR
actually reads ("high overtime: +14 points"). Second, translate feature names
into language an HR manager can act on — `OvertimeHours7D_slope_8w` means
nothing on a review call; "overtime climbing for two months" does.

SHAP explains what moved the model. It does not prove causation, and the UI says
so wherever these appear.
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

# feature stem -> (display name, actionable category)
LEXICON: list[tuple[str, str, str]] = [
    (r"^OvertimeHours7D_slope", "Overtime trending up", "Workload"),
    (r"^OvertimeHours7D_max", "Overtime peak in last quarter", "Workload"),
    (r"^OvertimeHours7D_mean", "Sustained overtime", "Workload"),
    (r"^OvertimeHours7D_delta", "Overtime jump vs last month", "Workload"),
    (r"^OvertimeHours7D", "Current overtime hours", "Workload"),
    (r"^overtime_excess", "Overtime above healthy threshold", "Workload"),
    (r"^NightShiftRatio", "Night shift load", "Workload"),
    (r"^AbsenceDays7D_slope", "Absence rising", "Attendance"),
    (r"^AbsenceDays7D_mean", "Frequent absence", "Attendance"),
    (r"^AbsenceDays7D", "Days absent this week", "Attendance"),
    (r"^absence_burst", "Cluster of absences", "Attendance"),
    (r"^LateCount7D", "Late punch-ins", "Attendance"),
    (r"^EngagementScore_slope", "Engagement declining", "Sentiment"),
    (r"^EngagementScore_mean", "Low engagement", "Sentiment"),
    (r"^EngagementScore", "Engagement pulse score", "Sentiment"),
    (r"^engagement_deficit", "Engagement below team norm", "Sentiment"),
    (r"^engagement_drop", "Engagement fell from its peak", "Sentiment"),
    (r"^OnboardingCompletionPct", "Onboarding completion", "Onboarding"),
    (r"^onboarding_gap", "Onboarding incomplete", "Onboarding"),
    (r"^SalaryCreditDelayDays", "Salary credited late", "Pay"),
    (r"^pay_delay", "Salary delay at this site", "Pay"),
    (r"^SalaryVsRoleBenchmark", "Pay vs role benchmark", "Pay"),
    (r"^pay_below_benchmark", "Paid below role median", "Pay"),
    (r"^LastHikePct", "Size of last increment", "Pay"),
    (r"^MonthlySalary", "Salary level", "Pay"),
    (r"^salary_per_grade", "Pay relative to grade", "Pay"),
    (r"^MonthsSincePromotion", "Time since last movement", "Career"),
    (r"^stagnation", "No movement in over two years", "Career"),
    (r"^TrainingCountToDate", "Training completed", "Career"),
    (r"^training_recency", "Recent training", "Career"),
    (r"^PerformanceRating", "Performance rating", "Performance"),
    (r"^ManagerChangesToDate", "Manager changes", "Supervision"),
    (r"^Grievance", "Grievance raised", "Supervision"),
    (r"^DemobilisationPressure", "Project winding down", "Project"),
    (r"^ProjectPhase", "Project phase", "Project"),
    (r"^HeadcountAtSite", "Site headcount", "Project"),
    (r"^site_headcount_change", "Crew size shrinking", "Project"),
    (r"^TenureDays|^TenureMonths|^TenureBand|^weeks_observed", "Tenure stage", "Tenure"),
    (r"^is_first_30_days|^is_first_90_days", "Early tenure window", "Tenure"),
    (r"^RecruitmentSource", "Hiring channel", "Sourcing"),
    (r"^RealisticJobPreview", "Job preview at hiring", "Sourcing"),
    (r"^EmploymentType", "Employment type", "Contract"),
    (r"^DistanceFromSiteKm|^commute_burden", "Commute distance", "Logistics"),
    (r"^AccommodationProvided", "Site accommodation", "Logistics"),
    (r"^SiteRemoteness|^SiteType|^Site$", "Site", "Logistics"),
    (r"^Department|^Position|^Grade", "Role and department", "Role"),
    (r"^Age|^PriorExperienceYears", "Profile", "Role"),
    (r"^BusinessCriticality", "Role criticality", "Role"),
    (r"^is_appraisal_window", "Appraisal season", "Cycle"),
]

ACTION_PLAYBOOK = {
    "Workload": "Review roster and overtime allocation with the site in-charge this week.",
    "Attendance": "Hold a check-in on the absence pattern before it becomes an exit.",
    "Sentiment": "Schedule a skip-level conversation; the pulse trend is falling.",
    "Onboarding": "Close the pending onboarding steps and assign a buddy.",
    "Pay": "Verify salary credit dates and benchmark the role against the pay band.",
    "Career": "Open a career conversation — no movement recorded for a long time.",
    "Performance": "Pair a performance conversation with support, not just a rating.",
    "Supervision": "Stabilise reporting; repeated manager changes break trust.",
    "Project": "Plan redeployment ahead of demobilisation instead of at closeout.",
    "Sourcing": "Feed this back to the hiring channel review.",
    "Contract": "Confirm renewal intent early; contract uncertainty drives exits.",
    "Logistics": "Check transport or accommodation support for this site.",
    "Role": "Segment-level pattern — review with the department head.",
    "Tenure": "Apply the early-tenure retention checklist.",
    "Cycle": "Appraisal-cycle risk; confirm the increment conversation has happened.",
}


# Planted driver -> (feature pattern, representative feature, expected sign of
# the value/SHAP relationship, or 0 for categoricals where sign is undefined).
# Mirrors the hazard in data/generate.py, so the explainer can be checked
# against the mechanism that actually produced the exits.
PLANTED_DRIVERS: list[tuple[str, str, str, int]] = [
    ("Onboarding gap", r"^OnboardingCompletionPct|^onboarding_gap", "onboarding_gap", +1),
    ("Low engagement", r"^EngagementScore|^engagement_", "EngagementScore_mean_4w", -1),
    ("Overtime pressure", r"^OvertimeHours7D|^overtime_excess", "OvertimeHours7D_mean_4w", +1),
    ("Absence", r"^AbsenceDays7D|^absence_burst", "AbsenceDays7D_mean_4w", +1),
    ("Salary credited late", r"^SalaryCreditDelayDays|^pay_delay", "SalaryCreditDelayDays_cur", +1),
    ("Pay below benchmark", r"^SalaryVsRoleBenchmark|^pay_below_benchmark", "SalaryVsRoleBenchmark", -1),
    ("Project demobilisation", r"^DemobilisationPressure|^ProjectPhase$", "DemobilisationPressure_cur", +1),
    ("Hiring channel", r"^RecruitmentSource$|^RealisticJobPreview$", "", 0),
    ("Contract type", r"^EmploymentType$", "", 0),
    ("Manager churn", r"^ManagerChangesToDate", "ManagerChangesToDate", +1),
    ("Grievances", r"^Grievance", "GrievancesToDate", +1),
    ("Promotion stagnation", r"^MonthsSincePromotion|^stagnation", "MonthsSincePromotion", +1),
    ("Commute burden", r"^DistanceFromSiteKm|^commute_burden|^AccommodationProvided", "commute_burden", +1),
    ("Night shifts", r"^NightShiftRatio", "NightShiftRatio_mean_8w", +1),
    ("Training (protective)", r"^TrainingCountToDate|^training_recency", "TrainingCountToDate", -1),
    ("Prior experience (protective)", r"^PriorExperienceYears", "PriorExperienceYears", -1),
]
# Features the simulator never lets influence the outcome. A sound explainer
# should give them almost nothing.
NOISE_CONTROLS: list[tuple[str, str]] = [
    ("Age (pure noise)", r"^Age$"),
    ("Calendar appraisal window (pure noise)", r"^is_appraisal_window$"),
]


def shap_recovery(contrib: np.ndarray, feature_names: list[str], frame: pd.DataFrame) -> dict:
    """Score each planted driver on how much SHAP attributes to it and whether
    the direction matches the mechanism that generated the data."""
    names = np.asarray(feature_names)
    abs_total = np.abs(contrib).mean(axis=0).sum() or 1e-12

    def family(pattern: str) -> np.ndarray:
        return np.array([bool(re.match(pattern, n)) for n in names])

    rows = []
    for label, pattern, rep, sign in PLANTED_DRIVERS:
        mask = family(pattern)
        if not mask.any():
            continue
        fam = contrib[:, mask].sum(axis=1)
        share = float(np.abs(fam).mean() / abs_total)
        corr = None
        if sign and rep in frame.columns:
            v = pd.to_numeric(frame[rep], errors="coerce")
            if v.nunique() > 2:
                corr = float(pd.Series(fam).corr(v.reset_index(drop=True), method="spearman"))
        if share < 0.01:
            verdict = "weak"
        elif sign and corr is not None and np.sign(corr) != sign:
            verdict = "wrong direction"
        else:
            verdict = "recovered"
        rows.append({"driver": label, "share": round(share, 4),
                     "expected": {1: "raises risk", -1: "lowers risk", 0: "varies by level"}[sign],
                     "direction_corr": None if corr is None else round(corr, 3), "verdict": verdict})
    rows.sort(key=lambda r: -r["share"])
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    noise = []
    for label, pattern in NOISE_CONTROLS:
        mask = family(pattern)
        if mask.any():
            share = float(np.abs(contrib[:, mask].sum(axis=1)).mean() / abs_total)
            noise.append({"feature": label, "share": round(share, 4),
                          "verdict": "ignored" if share < 0.01 else "leaking signal"})
    planted_share = float(sum(r["share"] for r in rows))
    return {"drivers": rows, "noise_controls": noise,
            "planted_share": round(planted_share, 3),
            "recovered": int(sum(r["verdict"] == "recovered" for r in rows)),
            "total": len(rows)}


def pretty(feature: str) -> tuple[str, str]:
    for pattern, label, category in LEXICON:
        if re.match(pattern, feature):
            return label, category
    return feature.replace("_", " "), "Other"


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return float(np.log(p / (1 - p)))


def _sigmoid(x: float) -> float:
    return float(1 / (1 + np.exp(-x)))


# How each area reads on screen once its features are added together.
CATEGORY_LABEL = {
    "Workload": "Workload and overtime", "Attendance": "Attendance", "Sentiment": "Engagement",
    "Onboarding": "Onboarding", "Pay": "Pay", "Career": "Career progress", "Performance": "Performance",
    "Supervision": "Manager changes and grievances", "Project": "Project phase", "Tenure": "Tenure stage",
    "Sourcing": "Hiring channel", "Contract": "Contract type", "Logistics": "Commute and site",
    "Role": "Role and department", "Cycle": "Appraisal season", "Other": "Other factors",
}


def top_drivers(contrib_row: np.ndarray, feature_names: list[str], base_value: float,
                values: pd.Series, top_n: int = 8) -> list[dict]:
    """Turn one row of log-odds SHAP values into ranked, plain-language drivers.

    Correlated features split credit for one underlying fact (three engagement
    measures each take a share of "this person is disengaged"). Shown one by
    one they repeat the same story and each looks smaller than the fact is, so
    contributions are summed per area first. SHAP values add exactly in
    log-odds space, so the area total is exact, not an approximation.

    The impact is measured the way a person would ask it: how much lower would
    this employee's risk be if that whole area sat at the population baseline?
    `detail` names the single feature that moved most, with its value.
    """
    total = float(base_value + contrib_row.sum())
    p_full = _sigmoid(total)
    groups: dict[str, list[int]] = {}
    for i, name in enumerate(feature_names):
        groups.setdefault(pretty(name)[1], []).append(i)

    drivers = []
    for category, idx in groups.items():
        c = float(contrib_row[idx].sum())
        if abs(c) < 1e-4:
            continue
        # strongest feature pushing the same way as the area as a whole
        same = [i for i in idx if np.sign(contrib_row[i]) == np.sign(c)] or idx
        top = max(same, key=lambda i: abs(contrib_row[i]))
        raw = values.get(feature_names[top], None)
        if isinstance(raw, (int, float, np.floating, np.integer)) and not pd.isna(raw):
            raw = round(float(raw), 2)
        drivers.append({
            "feature": feature_names[top], "label": CATEGORY_LABEL.get(category, category),
            "category": category, "detail": pretty(feature_names[top])[0], "n_features": len(idx),
            "shap": round(c, 4), "impact_pct": round((p_full - _sigmoid(total - c)) * 100, 2),
            "direction": "increases" if c > 0 else "reduces", "value": raw,
        })
    drivers.sort(key=lambda d: -abs(d["impact_pct"]))
    return drivers[:top_n]


def recommended_actions(drivers: list[dict], limit: int = 3) -> list[dict]:
    out, seen = [], set()
    for d in drivers:
        if d["direction"] != "increases" or d["category"] in seen:
            continue
        action = ACTION_PLAYBOOK.get(d["category"])
        if not action:
            continue
        seen.add(d["category"])
        out.append({"category": d["category"], "because": d.get("detail") or d["label"], "action": action})
        if len(out) >= limit:
            break
    return out
