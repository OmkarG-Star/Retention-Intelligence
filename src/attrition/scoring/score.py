"""Scoring engine.

Runs the current model over the latest snapshot for every active employee and
writes one row per person per run. Keeping every run means risk velocity is a
real measured change rather than a recomputation, and an explanation shown to a
manager in March can still be reproduced in September.

Priority is deliberately not the raw probability. A 92% risk on a helper the
site can replace in a day is not the same problem as 61% on the only planning
engineer who knows the JNPA schedule.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ..config import HORIZONS, priority_band, risk_band
from ..data import warehouse
from ..features.build import load_features
from ..models import explain
from ..models.train import load_bundle


def latest_snapshots(df: pd.DataFrame | None = None) -> pd.DataFrame:
    df = load_features() if df is None else df
    active = df[df["ExitDate"].isna()] if "ExitDate" in df else df
    idx = active.groupby("EmployeeID")["SnapshotDate"].idxmax()
    return active.loc[idx].reset_index(drop=True)


def previous_risk(as_of: pd.Timestamp) -> pd.Series:
    """Risk from the most recent earlier run, for velocity."""
    prev = warehouse.query(
        "SELECT EmployeeID, risk_30 FROM predictions WHERE run_id = ("
        "  SELECT run_id FROM prediction_runs WHERE as_of < ? ORDER BY as_of DESC LIMIT 1)",
        (str(as_of.date()),))
    if prev.empty:
        return pd.Series(dtype=float)
    return prev.set_index("EmployeeID")["risk_30"]


def score_population(version: str | None = None, top_drivers: int = 8,
                     verbose: bool = True) -> dict:
    bundle = load_bundle(version)
    snap = latest_snapshots()
    if snap.empty:
        raise RuntimeError("No active employees to score.")
    as_of = snap["SnapshotDate"].max()
    run_id = f"run-{as_of.date()}-{uuid.uuid4().hex[:6]}"

    out = pd.DataFrame({"EmployeeID": snap["EmployeeID"], "as_of": str(as_of.date())})
    for h in HORIZONS:
        model = bundle["horizons"].get(h)
        out[f"risk_{h}"] = model.predict_proba(snap) if model else np.nan

    # ---- survival ----
    survival = bundle["survival"]
    curves = survival.curve_points(snap)
    expected = survival.expected_days(snap)

    # ---- anomaly ----
    detector = bundle["anomaly"]
    out["anomaly_score"] = detector.score(snap)
    out["anomaly_flag"] = (out["anomaly_score"] >= 72).astype(int)

    # ---- explanations from the 30-day model ----
    driver_model = bundle["horizons"].get(30) or bundle["horizons"][sorted(bundle["horizons"])[0]]
    contrib, base = driver_model.contributions(snap)
    names = driver_model.features
    drivers_json = []
    for i in range(len(snap)):
        d = explain.top_drivers(contrib[i], names, base, snap.iloc[i], top_n=top_drivers)
        drivers_json.append(json.dumps({"drivers": d, "actions": explain.recommended_actions(d)}))

    # ---- velocity and priority ----
    prev = previous_risk(as_of)
    out["prev_risk_30"] = out["EmployeeID"].map(prev).astype(float)
    out["risk_velocity"] = (out["risk_30"] - out["prev_risk_30"]) * 100
    crit = snap.set_index("EmployeeID")["BusinessCriticality"].astype(float)
    out["criticality"] = out["EmployeeID"].map(crit).fillna(3.0)
    # relative standing within this run drives the bands; the calibrated
    # probability stays on the record for anyone who needs the absolute number
    pct = out["risk_90"].rank(pct=True) * 100
    out["risk_percentile"] = pct.round(1)
    out["priority_score"] = (pct / 100) * out["criticality"]
    out["risk_band"] = pct.apply(risk_band)
    out["priority_band"] = out["priority_score"].apply(priority_band)
    out["survival_curve"] = [json.dumps(c) for c in curves]
    out["drivers"] = drivers_json
    out["expected_days_to_exit"] = np.round(expected, 1)
    out["run_id"] = run_id
    out["model_version"] = bundle["version"]

    cols = ["run_id", "EmployeeID", "as_of", "model_version"] + \
           [f"risk_{h}" for h in HORIZONS] + \
           ["risk_percentile", "prev_risk_30", "risk_velocity", "anomaly_score", "anomaly_flag", "criticality",
            "priority_score", "risk_band", "priority_band", "survival_curve", "drivers",
            "expected_days_to_exit"]
    warehouse.init_warehouse()
    warehouse.write_table(out[cols], "predictions", mode="append")
    run_row = pd.DataFrame([{
        "run_id": run_id, "as_of": str(as_of.date()),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_version": bundle["version"], "n_scored": len(out),
        "mean_risk_30": float(out["risk_30"].mean()),
        "n_critical": int((out["risk_band"] == "Critical").sum()),
    }])
    warehouse.write_table(run_row, "prediction_runs", mode="append")

    if verbose:
        print(f"Scored {len(out):,} active employees as of {as_of.date()} ({run_id})")
        print(out["risk_band"].value_counts().to_string())
    return {"run_id": run_id, "as_of": str(as_of.date()), "n": len(out),
            "model_version": bundle["version"]}


def backfill_history(n_runs: int = 12, step_weeks: int = 2, version: str | None = None,
                     verbose: bool = True) -> list[str]:
    """Replay scoring at past dates so the dashboard opens with real trend and
    velocity instead of a single point. Each replay uses only data available at
    that date, so the history is honest."""
    bundle = load_bundle(version)
    df = load_features()
    end = df["SnapshotDate"].max()
    run_ids = []
    dates = [end - pd.Timedelta(weeks=step_weeks * i) for i in range(n_runs, 0, -1)]
    driver_model = bundle["horizons"].get(30)
    for as_of in dates:
        hist = df[df["SnapshotDate"] <= as_of]
        alive = hist[(hist["ExitDate"].isna()) | (hist["ExitDate"] > as_of)]
        if alive.empty:
            continue
        idx = alive.groupby("EmployeeID")["SnapshotDate"].idxmax()
        snap = alive.loc[idx]
        snap = snap[(as_of - snap["SnapshotDate"]).dt.days <= 21]
        if len(snap) < 10:
            continue
        run_id = f"run-{as_of.date()}-{uuid.uuid4().hex[:6]}"
        rows = pd.DataFrame({"run_id": run_id, "EmployeeID": snap["EmployeeID"].to_numpy(),
                             "as_of": str(as_of.date()), "model_version": bundle["version"]})
        for h in HORIZONS:
            m = bundle["horizons"].get(h)
            rows[f"risk_{h}"] = m.predict_proba(snap) if m else np.nan
        rows["anomaly_score"] = bundle["anomaly"].score(snap)
        rows["anomaly_flag"] = (rows["anomaly_score"] >= 72).astype(int)
        prev = previous_risk(as_of)
        rows["prev_risk_30"] = rows["EmployeeID"].map(prev).astype(float)
        rows["risk_velocity"] = (rows["risk_30"] - rows["prev_risk_30"]) * 100
        rows["criticality"] = rows["EmployeeID"].map(
            snap.set_index("EmployeeID")["BusinessCriticality"].astype(float)).fillna(3.0)
        pct = rows["risk_90"].rank(pct=True) * 100
        rows["risk_percentile"] = pct.round(1)
        rows["priority_score"] = (pct / 100) * rows["criticality"]
        rows["risk_band"] = pct.apply(risk_band)
        rows["priority_band"] = rows["priority_score"].apply(priority_band)
        rows["survival_curve"] = None
        rows["drivers"] = None
        rows["expected_days_to_exit"] = np.nan
        warehouse.write_table(rows, "predictions", mode="append")
        warehouse.write_table(pd.DataFrame([{
            "run_id": run_id, "as_of": str(as_of.date()),
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "model_version": bundle["version"], "n_scored": len(rows),
            "mean_risk_30": float(rows["risk_30"].mean()),
            "n_critical": int((rows["risk_band"] == "Critical").sum())}]),
            "prediction_runs", mode="append")
        run_ids.append(run_id)
        if verbose:
            print(f"  backfilled {as_of.date()}  n={len(rows):,}  mean 30d risk "
                  f"{rows['risk_30'].mean():.3f}")
    return run_ids


if __name__ == "__main__":
    score_population()
