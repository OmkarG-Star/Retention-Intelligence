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


def top_drivers(contrib_row: np.ndarray, feature_names: list[str], base_value: float,
                values: pd.Series, top_n: int = 8) -> list[dict]:
    """Convert one row of log-odds SHAP values into ranked probability impacts.

    The impact is measured the way a person would ask it: how much lower would
    this employee's risk be if that one factor sat at the population baseline?
    """
    total = float(base_value + contrib_row.sum())
    p_full = _sigmoid(total)
    order = np.argsort(-np.abs(contrib_row))[: top_n * 2]
    drivers = []
    for i in order:
        c = float(contrib_row[i])
        if abs(c) < 1e-4:
            continue
        impact = p_full - _sigmoid(total - c)
        label, category = pretty(feature_names[i])
        raw = values.get(feature_names[i], None)
        if isinstance(raw, (int, float, np.floating, np.integer)) and not pd.isna(raw):
            raw = round(float(raw), 2)
        drivers.append({
            "feature": feature_names[i], "label": label, "category": category,
            "shap": round(c, 4), "impact_pct": round(impact * 100, 2),
            "direction": "increases" if c > 0 else "reduces", "value": raw,
        })
    drivers.sort(key=lambda d: -abs(d["impact_pct"]))
    # collapse duplicate labels, keeping the strongest of each
    seen, merged = set(), []
    for d in drivers:
        if d["label"] in seen:
            continue
        seen.add(d["label"])
        merged.append(d)
        if len(merged) >= top_n:
            break
    return merged


def recommended_actions(drivers: list[dict], limit: int = 3) -> list[dict]:
    out, seen = [], set()
    for d in drivers:
        if d["direction"] != "increases" or d["category"] in seen:
            continue
        action = ACTION_PLAYBOOK.get(d["category"])
        if not action:
            continue
        seen.add(d["category"])
        out.append({"category": d["category"], "because": d["label"], "action": action})
        if len(out) >= limit:
            break
    return out
