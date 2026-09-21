"""Read model for the API.

All dashboard reads go through here so the routers stay thin and every screen
sees the same definitions of "latest run", "active employee" and "early exit".
Results are cached per prediction run, which is the only thing that changes
between scoring jobs.
"""
from __future__ import annotations

import json
from functools import lru_cache

import numpy as np
import pandas as pd

from ..config import HORIZONS, TENURE_BANDS
from ..data import warehouse
from ..models import registry


def latest_run() -> dict | None:
    df = warehouse.query("SELECT * FROM prediction_runs ORDER BY as_of DESC, created_at DESC LIMIT 1")
    return None if df.empty else df.iloc[0].to_dict()


@lru_cache(maxsize=8)
def _scored(run_id: str) -> pd.DataFrame:
    preds = warehouse.query("SELECT * FROM predictions WHERE run_id = ?", (run_id,))
    master = warehouse.query("SELECT * FROM employee_master")
    weekly = warehouse.query(
        "SELECT w.* FROM employee_weekly w JOIN ("
        "  SELECT EmployeeID, MAX(SnapshotDate) AS d FROM employee_weekly GROUP BY EmployeeID"
        ") m ON m.EmployeeID = w.EmployeeID AND m.d = w.SnapshotDate")
    df = preds.merge(master, on="EmployeeID", how="left").merge(
        weekly.drop(columns=[c for c in ("MonthlySalary", "SalaryVsRoleBenchmark") if c in weekly]),
        on="EmployeeID", how="left")
    df["DOJ"] = pd.to_datetime(df["DOJ"])
    df["TenureDays"] = df.get("TenureDays", pd.Series(0, index=df.index)).fillna(0).astype(int)
    df["tenure_band"] = df["TenureDays"].apply(_band)
    return df


def _band(days: float) -> str:
    for name, lo, hi in TENURE_BANDS:
        if lo <= days <= hi:
            return name
    return TENURE_BANDS[-1][0]


def scored(run_id: str | None = None) -> pd.DataFrame:
    run = latest_run()
    if run is None:
        return pd.DataFrame()
    return _scored(run_id or run["run_id"]).copy()


def clear_cache() -> None:
    _scored.cache_clear()


# ------------------------------------------------------------------ overview
def kpis() -> dict:
    df = scored()
    run = latest_run()
    if df.empty or run is None:
        return {"status": "not_scored"}
    outcomes = warehouse.query("SELECT * FROM attrition_outcomes")
    outcomes["ExitDate"] = pd.to_datetime(outcomes["ExitDate"])
    as_of = pd.to_datetime(run["as_of"])
    last_90 = outcomes[outcomes["ExitDate"] >= as_of - pd.Timedelta(days=90)]
    last_year = outcomes[outcomes["ExitDate"] >= as_of - pd.Timedelta(days=365)]
    headcount = len(df)
    early = last_year[last_year["TenureDaysAtExit"] <= 30]

    return {
        "status": "ok",
        "as_of": run["as_of"],
        "model_version": run["model_version"],
        "headcount": headcount,
        "critical": int((df["risk_band"] == "Critical").sum()),
        "high": int((df["risk_band"] == "High").sum()),
        "medium": int((df["risk_band"] == "Medium").sum()),
        "low": int((df["risk_band"] == "Low").sum()),
        "priority_critical": int((df["priority_band"] == "Critical").sum()),
        "accelerating": int((df["risk_velocity"] > 5).sum()),
        "anomalies": int(df["anomaly_flag"].fillna(0).sum()),
        "mean_risk_30": float(df["risk_30"].mean()),
        "mean_risk_90": float(df["risk_90"].mean()),
        "expected_exits_90d": float(df["risk_90"].sum()),
        "exits_last_90d": int(len(last_90)),
        "annualised_attrition": float(len(last_year) / max(headcount + len(last_year), 1)),
        "early_exit_share": float(len(early) / max(len(last_year), 1)),
        "new_joiners_90d": int((df["TenureDays"] <= 90).sum()),
        "in_first_30_days": int((df["TenureDays"] <= 30).sum()),
    }


def risk_trend() -> list[dict]:
    runs = warehouse.query(
        "SELECT as_of, mean_risk_30, n_scored, n_critical FROM prediction_runs ORDER BY as_of")
    exits = warehouse.query("SELECT ExitDate FROM attrition_outcomes")
    exits["ExitDate"] = pd.to_datetime(exits["ExitDate"])
    out = []
    for r in runs.itertuples():
        as_of = pd.to_datetime(r.as_of)
        window = exits[(exits["ExitDate"] > as_of - pd.Timedelta(days=14)) &
                       (exits["ExitDate"] <= as_of)]
        out.append({"as_of": r.as_of, "mean_risk_30": round(float(r.mean_risk_30), 4),
                    "n_scored": int(r.n_scored), "n_critical": int(r.n_critical),
                    "actual_exits_14d": int(len(window))})
    return out


def watchlist(limit: int = 200, band: str | None = None, site: str | None = None,
              department: str | None = None, search: str | None = None,
              sort: str = "priority_score", order: int = 6) -> list[dict]:
    df = scored()
    if df.empty:
        return []
    if band:
        df = df[df["risk_band"] == band]
    if site:
        df = df[df["Site"] == site]
    if department:
        df = df[df["Department"] == department]
    if search:
        s = search.lower()
        mask = (df["EmployeeID"].str.lower().str.contains(s) |
                df["Position"].str.lower().str.contains(s) |
                df["Department"].str.lower().str.contains(s) |
                df["Site"].str.lower().str.contains(s))
        df = df[mask]
    sort = sort if sort in df.columns else "priority_score"
    df = df.sort_values(sort, ascending=False).head(limit)
    cols = ["EmployeeID", "Position", "Department", "Site", "EmploymentType", "RecruitmentSource",
            "TenureDays", "tenure_band", "MonthlySalary", "BusinessCriticality",
            "risk_7", "risk_15", "risk_30", "risk_90", "risk_180", "risk_percentile",
            "risk_velocity", "anomaly_score", "anomaly_flag", "priority_score",
            "risk_band", "priority_band", "expected_days_to_exit"]
    cols = [c for c in cols if c in df.columns]
    return json.loads(df[cols].to_json(orient="records"))


def employee_detail(employee_id: str) -> dict:
    df = scored()
    row = df[df["EmployeeID"] == employee_id]
    if row.empty:
        master = warehouse.query("SELECT * FROM employee_master WHERE EmployeeID=?", (employee_id,))
        if master.empty:
            raise KeyError(employee_id)
        profile = json.loads(master.to_json(orient="records"))[0]
        exited = warehouse.query("SELECT * FROM attrition_outcomes WHERE EmployeeID=?", (employee_id,))
        return {"profile": profile, "scored": False,
                "exit": json.loads(exited.to_json(orient="records"))[0] if not exited.empty else None,
                "timeline": timeline(employee_id), "history": risk_history(employee_id)}

    rec = json.loads(row.to_json(orient="records"))[0]
    drivers = json.loads(rec.pop("drivers") or '{"drivers": [], "actions": []}')
    curve = json.loads(rec.pop("survival_curve") or "[]")
    peers = df[(df["Department"] == rec.get("Department")) & (df["EmployeeID"] != employee_id)]
    return {
        "profile": rec, "scored": True,
        "drivers": drivers.get("drivers", []), "actions": drivers.get("actions", []),
        "survival_curve": curve,
        "timeline": timeline(employee_id),
        "history": risk_history(employee_id),
        "behaviour": behaviour_series(employee_id),
        "peer_median_risk_90": float(peers["risk_90"].median()) if len(peers) else None,
        "interventions": interventions_for(employee_id),
    }


def timeline(employee_id: str, limit: int = 60) -> list[dict]:
    df = warehouse.query(
        "SELECT EventDate, EventType, EventDetail FROM employee_events"
        " WHERE EmployeeID=? ORDER BY EventDate DESC LIMIT ?", (employee_id, limit))
    return json.loads(df.to_json(orient="records"))


def risk_history(employee_id: str) -> list[dict]:
    df = warehouse.query(
        "SELECT as_of, risk_7, risk_30, risk_90, anomaly_score FROM predictions"
        " WHERE EmployeeID=? ORDER BY as_of", (employee_id,))
    return json.loads(df.to_json(orient="records"))


def behaviour_series(employee_id: str, weeks: int = 26) -> list[dict]:
    df = warehouse.query(
        "SELECT SnapshotDate, OvertimeHours7D, AbsenceDays7D, EngagementScore,"
        " LateCount7D, SalaryCreditDelayDays, OnboardingCompletionPct"
        " FROM employee_weekly WHERE EmployeeID=? ORDER BY SnapshotDate DESC LIMIT ?",
        (employee_id, weeks))
    return json.loads(df.sort_values("SnapshotDate").to_json(orient="records"))


# ------------------------------------------------------------------ segments
def segments(by: str = "Site") -> list[dict]:
    df = scored()
    if df.empty or by not in df.columns:
        return []
    outcomes = warehouse.query(
        "SELECT o.*, m.Site, m.Department, m.EmploymentType, m.RecruitmentSource, m.Position"
        " FROM attrition_outcomes o JOIN employee_master m ON m.EmployeeID = o.EmployeeID")
    outcomes["ExitDate"] = pd.to_datetime(outcomes["ExitDate"])
    recent = outcomes[outcomes["ExitDate"] >= outcomes["ExitDate"].max() - pd.Timedelta(days=365)]

    rows = []
    for value, grp in df.groupby(by):
        exits = recent[recent[by] == value] if by in recent.columns else recent.iloc[0:0]
        rows.append({
            "segment": str(value), "headcount": int(len(grp)),
            "mean_risk_90": round(float(grp["risk_90"].mean()), 4),
            "critical": int((grp["risk_band"] == "Critical").sum()),
            "high": int((grp["risk_band"] == "High").sum()),
            "accelerating": int((grp["risk_velocity"] > 5).sum()),
            "expected_exits_90d": round(float(grp["risk_90"].sum()), 1),
            "exits_12m": int(len(exits)),
            "early_exits_12m": int((exits["TenureDaysAtExit"] <= 30).sum()) if len(exits) else 0,
            "attrition_12m": round(len(exits) / max(len(grp) + len(exits), 1), 4),
            "median_tenure_at_exit": float(exits["TenureDaysAtExit"].median()) if len(exits) else None,
        })
    rows.sort(key=lambda r: -r["mean_risk_90"])
    return rows


def early_attrition() -> dict:
    """The 0-30 day layer: where new hires are lost and which channel sent them."""
    outcomes = warehouse.query(
        "SELECT o.*, m.RecruitmentSource, m.Site, m.Department, m.EmploymentType, m.Position,"
        " m.RealisticJobPreview FROM attrition_outcomes o"
        " JOIN employee_master m ON m.EmployeeID = o.EmployeeID")
    master = warehouse.query("SELECT * FROM employee_master")
    df = scored()
    bands = []
    for name, lo, hi in TENURE_BANDS:
        grp = outcomes[(outcomes["TenureDaysAtExit"] >= lo) & (outcomes["TenureDaysAtExit"] <= hi)]
        bands.append({"band": name, "exits": int(len(grp)),
                      "share": round(len(grp) / max(len(outcomes), 1), 4),
                      "absconding": int((grp["ExitType"] == "Absconding").sum())})

    by_source = []
    for source, grp in master.groupby("RecruitmentSource"):
        ex = outcomes[outcomes["RecruitmentSource"] == source]
        early = ex[ex["TenureDaysAtExit"] <= 30]
        hired = len(grp)
        by_source.append({
            "source": source, "hired": int(hired), "exits": int(len(ex)),
            "early_exits_30d": int(len(early)),
            "early_exit_rate": round(len(early) / max(hired, 1), 4),
            "median_tenure_at_exit": float(ex["TenureDaysAtExit"].median()) if len(ex) else None,
            "live_new_joiners": int(((df["RecruitmentSource"] == source) &
                                     (df["TenureDays"] <= 90)).sum()) if not df.empty else 0,
        })
    by_source.sort(key=lambda r: -r["early_exit_rate"])

    new_joiners = []
    if not df.empty:
        nj = df[df["TenureDays"] <= 90].sort_values("risk_30", ascending=False).head(50)
        new_joiners = json.loads(nj[[
            "EmployeeID", "Position", "Site", "Department", "RecruitmentSource", "TenureDays",
            "OnboardingCompletionPct", "risk_7", "risk_15", "risk_30", "risk_band", "risk_velocity"
        ]].to_json(orient="records"))

    reasons = (outcomes[outcomes["TenureDaysAtExit"] <= 30]["ExitReason"]
               .value_counts().head(8).reset_index())
    reasons.columns = ["reason", "count"]
    return {"bands": bands, "by_source": by_source, "new_joiners": new_joiners,
            "early_reasons": json.loads(reasons.to_json(orient="records")),
            "total_exits": int(len(outcomes)),
            "early_share": round(float((outcomes["TenureDaysAtExit"] <= 30).mean()), 4)}


def anomalies(limit: int = 60) -> list[dict]:
    df = scored()
    if df.empty:
        return []
    df = df[df["anomaly_flag"] == 1].sort_values("anomaly_score", ascending=False).head(limit)
    cols = ["EmployeeID", "Position", "Department", "Site", "TenureDays", "anomaly_score",
            "risk_30", "risk_90", "risk_velocity", "risk_band"]
    return json.loads(df[cols].to_json(orient="records"))


def movers(limit: int = 25) -> list[dict]:
    df = scored()
    if df.empty:
        return []
    df = df.dropna(subset=["risk_velocity"]).sort_values("risk_velocity", ascending=False).head(limit)
    cols = ["EmployeeID", "Position", "Department", "Site", "prev_risk_30", "risk_30",
            "risk_velocity", "risk_band", "priority_band"]
    return json.loads(df[cols].to_json(orient="records"))


# ------------------------------------------------------------------ governance
def governance() -> dict:
    try:
        record = registry.get()
    except FileNotFoundError:
        return {"status": "no_model"}
    metrics = warehouse.query("SELECT * FROM model_metrics WHERE model_version=?",
                              (record["version"],))
    return {
        "status": "ok",
        "current": record,
        "versions": registry.list_versions(),
        "metrics": json.loads(metrics.to_json(orient="records")),
        "runs": json.loads(warehouse.query(
            "SELECT * FROM prediction_runs ORDER BY as_of DESC LIMIT 20").to_json(orient="records")),
    }


def interventions_for(employee_id: str) -> list[dict]:
    df = warehouse.query(
        "SELECT * FROM interventions WHERE EmployeeID=? ORDER BY created_at DESC",
        (employee_id,), db=warehouse.paths.app_db)
    return json.loads(df.to_json(orient="records"))


def intervention_effectiveness() -> dict:
    df = warehouse.query("SELECT * FROM interventions", db=warehouse.paths.app_db)
    if df.empty:
        return {"summary": [], "total": 0, "open": 0}
    closed = df[df["status"] == "Closed"].copy()
    rows = []
    for action, grp in closed.groupby("action"):
        delta = (grp["risk_at_close"] - grp["risk_at_creation"]).dropna()
        rows.append({
            "action": action, "closed": int(len(grp)),
            "retained": int((grp["outcome"] == "Retained").sum()),
            "exited": int((grp["outcome"] == "Exited").sum()),
            "mean_risk_change_pts": round(float(delta.mean() * 100), 2) if len(delta) else None,
        })
    rows.sort(key=lambda r: -r["closed"])
    return {"summary": rows, "total": int(len(df)),
            "open": int((df["status"] == "Open").sum()),
            "note": "Observed association only. Employees receiving an intervention are "
                    "selected by risk, so these numbers are not a causal effect."}
