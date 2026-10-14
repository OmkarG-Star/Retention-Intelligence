"""Feature engine.

Every feature is computed strictly from rows at or before the snapshot date, so
a training row can never see the future. Levels are kept alongside trends
because trajectory usually carries more signal than the current value: 43 hours
of overtime after four flat months means something different from 43 hours in a
month that has been climbing since January.

Labels are built with censoring in mind — a row is only eligible for the 90-day
label if the full 90-day window is observable before the data cutoff, otherwise
it is dropped (positive or negative) rather than silently labelled.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..config import HORIZONS, TENURE_BANDS, VOLUNTARY_EXIT_TYPES, paths
from ..data import warehouse

# rolling windows expressed in weekly snapshots
WINDOWS = {"4w": 4, "8w": 8, "13w": 13}

BEHAVIOURAL = [
    "OvertimeHours7D", "AbsenceDays7D", "LateCount7D", "NightShiftRatio",
    "EngagementScore", "PerformanceRating", "SalaryCreditDelayDays",
    "OnboardingCompletionPct", "DemobilisationPressure",
]
TREND_COLS = ["OvertimeHours7D", "AbsenceDays7D", "EngagementScore",
              "PerformanceRating", "SalaryCreditDelayDays", "LateCount7D"]

CATEGORICAL = ["Department", "Position", "Site", "SiteType", "EmploymentType",
               "RecruitmentSource", "ProjectPhase", "TenureBand"]

STATIC_NUM = ["Grade", "Age", "PriorExperienceYears", "DistanceFromSiteKm",
              "AccommodationProvided", "BusinessCriticality", "RealisticJobPreview",
              "SiteRemoteness"]


def tenure_band(days: float) -> str:
    for name, lo, hi in TENURE_BANDS:
        if lo <= days <= hi:
            return name
    return TENURE_BANDS[-1][0]


def _slope(series: pd.Series) -> float:
    """OLS slope per week over the window; robust to short windows."""
    y = series.to_numpy(dtype=float)
    n = len(y)
    if n < 2 or np.all(np.isnan(y)):
        return 0.0
    x = np.arange(n, dtype=float)
    x -= x.mean()
    denom = (x ** 2).sum()
    return float((x * (y - np.nanmean(y))).sum() / denom) if denom else 0.0


def build_features(weekly: pd.DataFrame | None = None,
                   master: pd.DataFrame | None = None) -> pd.DataFrame:
    if weekly is None:
        weekly = warehouse.query("SELECT * FROM employee_weekly")
    if master is None:
        master = warehouse.query("SELECT * FROM employee_master")

    weekly = weekly.copy()
    weekly["SnapshotDate"] = pd.to_datetime(weekly["SnapshotDate"])
    weekly = weekly.sort_values(["EmployeeID", "SnapshotDate"])
    g = weekly.groupby("EmployeeID", sort=False)

    feats = weekly[["EmployeeID", "SnapshotDate", "TenureDays", "TenureMonths",
                    "ProjectPhase", "HeadcountAtSite", "MonthlySalary",
                    "SalaryVsRoleBenchmark", "MonthsSincePromotion",
                    "ManagerChangesToDate", "TrainingCountToDate", "GrievancesToDate",
                    "LastHikePct"]].copy()

    # ---- levels ----
    for col in BEHAVIOURAL:
        feats[f"{col}_cur"] = weekly[col].astype(float)

    # ---- rolling means and maxima (closed on the left: includes current row) ----
    for col in BEHAVIOURAL:
        for label, win in WINDOWS.items():
            feats[f"{col}_mean_{label}"] = (
                g[col].rolling(win, min_periods=1).mean().reset_index(level=0, drop=True))
        feats[f"{col}_max_13w"] = (
            g[col].rolling(13, min_periods=1).max().reset_index(level=0, drop=True))
        feats[f"{col}_std_8w"] = (
            g[col].rolling(8, min_periods=2).std().reset_index(level=0, drop=True)).fillna(0.0)

    # ---- trends and deltas ----
    for col in TREND_COLS:
        feats[f"{col}_slope_8w"] = (
            g[col].rolling(8, min_periods=3).apply(_slope, raw=False)
            .reset_index(level=0, drop=True)).fillna(0.0)
        prev4 = g[col].shift(4)
        feats[f"{col}_delta_4w"] = (weekly[col] - prev4).fillna(0.0)
        base = feats[f"{col}_mean_13w"].replace(0, np.nan)
        feats[f"{col}_ratio_cur_13w"] = (weekly[col] / base).replace([np.inf, -np.inf], np.nan).fillna(1.0)

    # ---- domain composites ----
    feats["overtime_excess"] = (weekly["OvertimeHours7D"] - 30).clip(lower=0)
    feats["engagement_deficit"] = (7.0 - weekly["EngagementScore"]).clip(lower=0)
    feats["engagement_drop_8w"] = (g["EngagementScore"].transform(lambda s: s.rolling(8, min_periods=2).max())
                                   - weekly["EngagementScore"]).clip(lower=0)
    feats["onboarding_gap"] = np.where(weekly["TenureDays"] <= 90,
                                       (100 - weekly["OnboardingCompletionPct"]).clip(lower=0), 0.0)
    feats["pay_below_benchmark"] = (-weekly["SalaryVsRoleBenchmark"]).clip(lower=0)
    feats["pay_delay_8w_max"] = g["SalaryCreditDelayDays"].rolling(8, min_periods=1).max().reset_index(level=0, drop=True)
    feats["absence_burst"] = (g["AbsenceDays7D"].rolling(3, min_periods=1).sum()
                              .reset_index(level=0, drop=True))
    feats["stagnation"] = (weekly["MonthsSincePromotion"] - 24).clip(lower=0)
    feats["training_recency"] = g["TrainingCountToDate"].diff(13).fillna(0.0)
    feats["site_headcount_change_8w"] = (
        g["HeadcountAtSite"].transform(lambda s: s.pct_change(8))
        .replace([np.inf, -np.inf], np.nan).fillna(0.0))
    feats["weeks_observed"] = g.cumcount() + 1

    # ---- static profile ----
    feats = feats.merge(master, on="EmployeeID", how="left", suffixes=("", "_m"))
    feats["TenureBand"] = feats["TenureDays"].apply(tenure_band)
    feats["is_first_30_days"] = (feats["TenureDays"] <= 30).astype(int)
    feats["is_first_90_days"] = (feats["TenureDays"] <= 90).astype(int)
    feats["salary_per_grade"] = feats["MonthlySalary"] / feats["Grade"].clip(lower=1)
    feats["commute_burden"] = np.where(feats["AccommodationProvided"] == 1,
                                       feats["DistanceFromSiteKm"] * 0.2,
                                       feats["DistanceFromSiteKm"])
    feats["month"] = feats["SnapshotDate"].dt.month
    feats["is_appraisal_window"] = feats["month"].isin([3, 4]).astype(int)

    drop = [c for c in ("DOJ", "ManagerID", "MonthlySalary_m", "SalaryVsRoleBenchmark_m") if c in feats]
    feats = feats.drop(columns=drop)
    return feats.reset_index(drop=True)


def prepare_outcomes(outcomes: pd.DataFrame) -> pd.DataFrame:
    """Normalise the outcomes table to the columns the labeller needs.

    The event is the *decision* to leave (NoticeDate), not the last working
    day: once a resignation is in, HR already knows, and a model that "predicts"
    the notice period adds nothing. Exports without a NoticeDate fall back to
    ExitDate, which reproduces the older last-working-day behaviour.
    """
    out = outcomes.copy()
    if out.empty:
        return pd.DataFrame(columns=["EmployeeID", "NoticeDate", "ExitDate", "ExitType", "voluntary"])
    out["ExitDate"] = pd.to_datetime(out["ExitDate"])
    if "NoticeDate" in out and out["NoticeDate"].notna().any():
        out["NoticeDate"] = pd.to_datetime(out["NoticeDate"]).fillna(out["ExitDate"])
    else:
        out["NoticeDate"] = out["ExitDate"]
    out["voluntary"] = out["ExitType"].isin(VOLUNTARY_EXIT_TYPES).astype(int)
    return out[["EmployeeID", "NoticeDate", "ExitDate", "ExitType", "voluntary"]]


def attach_labels(feats: pd.DataFrame, outcomes: pd.DataFrame | None = None,
                  cutoff: pd.Timestamp | None = None) -> pd.DataFrame:
    """Add label_{h} and eligible_{h} per horizon, plus survival columns.

    label_h    1 if the employee decided to leave voluntarily within h days.
    eligible_h 1 only if the whole h-day window is observed before the data
               cutoff and no involuntary exit ended it early. Keeping observed
               positives from a partly-observed window while dropping its
               negatives inflates the event rate near the cutoff, and with it
               every metric measured there, so it is not done.
    """
    if outcomes is None:
        outcomes = warehouse.query("SELECT * FROM attrition_outcomes")
    outcomes = prepare_outcomes(outcomes)
    cutoff = cutoff or feats["SnapshotDate"].max()

    df = feats.merge(outcomes, on="EmployeeID", how="left")
    df["voluntary"] = df["voluntary"].fillna(0).astype(int)
    df["days_to_notice"] = (df["NoticeDate"] - df["SnapshotDate"]).dt.days

    # once the decision is made the person is no longer at risk of making it
    df = df[df["days_to_notice"].isna() | (df["days_to_notice"] >= 0)].copy()
    days = df["days_to_notice"]
    days_to_cutoff = (cutoff - df["SnapshotDate"]).dt.days
    has_event = days.notna()

    for h in HORIZONS:
        inside = has_event & (days <= h)
        df[f"label_{h}"] = (inside & (df["voluntary"] == 1)).astype(int)
        involuntary_inside = inside & (df["voluntary"] == 0)
        df[f"eligible_{h}"] = ((days_to_cutoff >= h) & ~involuntary_inside).astype(int)

    # survival framing: voluntary decision is the event; involuntary exits and
    # the data cutoff both censor
    df["event_observed"] = (has_event & (df["voluntary"] == 1)).astype(int)
    df["duration_days"] = np.where(has_event, days, days_to_cutoff)
    return df.reset_index(drop=True)


def feature_columns(df: pd.DataFrame) -> tuple[list[str], list[str]]:
    exclude = {"EmployeeID", "SnapshotDate", "ExitDate", "ExitType", "NoticeDate", "voluntary",
               "days_to_notice", "event_observed", "duration_days", "month"}
    exclude |= {f"label_{h}" for h in HORIZONS} | {f"eligible_{h}" for h in HORIZONS}
    numeric, categorical = [], []
    for c in df.columns:
        if c in exclude:
            continue
        if c in CATEGORICAL or df[c].dtype == object:
            categorical.append(c)
        elif pd.api.types.is_numeric_dtype(df[c]):
            numeric.append(c)
    return numeric, categorical


def build_and_store() -> pd.DataFrame:
    feats = build_features()
    labelled = attach_labels(feats)
    out = paths.data_processed / "features.parquet"
    try:
        labelled.to_parquet(out, index=False)
    except Exception:  # pyarrow not installed
        out = paths.data_processed / "features.csv.gz"
        labelled.to_csv(out, index=False)
    return labelled


def load_features() -> pd.DataFrame:
    pq = paths.data_processed / "features.parquet"
    gz = paths.data_processed / "features.csv.gz"
    if pq.exists():
        df = pd.read_parquet(pq)
    elif gz.exists():
        df = pd.read_csv(gz)
    else:
        return build_and_store()
    df["SnapshotDate"] = pd.to_datetime(df["SnapshotDate"])
    for col in ("ExitDate", "NoticeDate"):
        if col in df:
            df[col] = pd.to_datetime(df[col])
    return df
