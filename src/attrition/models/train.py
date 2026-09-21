"""Training pipeline.

Splits are chronological, never random. A random split would let the model see
March to predict February and report an AUC the deployed system can never
reproduce — the single most common way an attrition model looks brilliant in a
notebook and fails in production.

    |-------- train --------|--- valid ---|--- test ---|
                             calibration    reported metrics
"""
from __future__ import annotations

import time
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ..config import HORIZONS, settings
from ..data import warehouse
from ..features.build import feature_columns, load_features
from . import evaluate, registry
from .anomaly import AnomalyDetector
from .horizon import HAS_LGB, HorizonModel
from .survival import DiscreteTimeSurvival

FAIRNESS_ATTRS = ["Site", "Department", "EmploymentType", "RecruitmentSource", "TenureBand"]


def time_split(df: pd.DataFrame, valid_months: int | None = None,
               test_months: int | None = None) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    valid_months = valid_months or settings.validation_months
    test_months = test_months or settings.test_months
    end = df["SnapshotDate"].max()
    test_start = end - pd.DateOffset(months=test_months)
    valid_start = test_start - pd.DateOffset(months=valid_months)
    train = df[df["SnapshotDate"] < valid_start]
    valid = df[(df["SnapshotDate"] >= valid_start) & (df["SnapshotDate"] < test_start)]
    test = df[df["SnapshotDate"] >= test_start]
    return train, valid, test


def train_all(verbose: bool = True) -> dict:
    t_start = time.time()
    df = load_features()
    numeric, categorical = feature_columns(df)
    train, valid, test = time_split(df)
    version = registry.new_version()

    if verbose:
        print(f"Training {version}  |  {'LightGBM' if HAS_LGB else 'scikit-learn HistGB'}")
        print(f"  rows: train {len(train):,}  valid {len(valid):,}  test {len(test):,}")
        print(f"  features: {len(numeric)} numeric + {len(categorical)} categorical")

    models: dict[int, HorizonModel] = {}
    metric_rows: list[dict] = []
    summary: dict[str, dict] = {}

    for h in HORIZONS:
        y, elig = f"label_{h}", f"eligible_{h}"
        tr = train[train[elig] == 1]
        va = valid[valid[elig] == 1]
        te = test[test[elig] == 1]
        if tr[y].sum() < 25 or va.empty:
            if verbose:
                print(f"  [{h:>3}d] skipped — too few observed events")
            continue

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model = HorizonModel(h, numeric, categorical).fit(tr, va, y)
        models[h] = model

        # Long horizons cannot be scored on a short holdout: a 180-day label is
        # only observable 180 days before the cutoff. Fall back to the validation
        # window and record which split the reported numbers came from.
        reported_split, reported_part = "test", te
        if te.empty or te[y].nunique() < 2:
            reported_split, reported_part = "valid", va

        for split_name, part in (("valid", va), ("test", te)):
            if part.empty or part[y].nunique() < 2:
                continue
            p = model.predict_proba(part)
            m = evaluate.discrimination(part[y].to_numpy(), p)
            for k, v in m.items():
                metric_rows.append({"model_version": version, "horizon": h,
                                    "split": split_name, "metric": k, "value": float(v)})

        p = model.predict_proba(reported_part)
        m = evaluate.discrimination(reported_part[y].to_numpy(), p)
        scored = pd.concat([reported_part.reset_index(drop=True),
                            pd.Series(p, name="_p")], axis=1)
        summary[str(h)] = {
            **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()},
            "evaluated_on": reported_split,
            "calibration": evaluate.calibration_bins(reported_part[y].to_numpy(), p),
            "fairness": evaluate.fairness_slices(scored, y, "_p", FAIRNESS_ATTRS),
            "top_features": model.importance().head(15).to_dict("records"),
        }
        if verbose:
            print(f"  [{h:>3}d] events {m['positives']:>5,}  "
                  f"PR-AUC {m.get('pr_auc', float('nan')):.3f}  "
                  f"ROC-AUC {m.get('roc_auc', float('nan')):.3f}  "
                  f"Brier {m.get('brier', float('nan')):.4f}  "
                  f"recall@10% {m.get('recall_at_10', float('nan')):.2f}  [{reported_split}]")

    if not models:
        raise RuntimeError("No horizon model could be trained — check label eligibility.")

    # ---- survival ----
    if verbose:
        print("  fitting discrete-time survival model ...")
    warnings.filterwarnings("ignore")
    surv_num = [c for c in numeric if not c.endswith("_std_8w")][:60]
    survival = DiscreteTimeSurvival(surv_num, ["EmploymentType", "TenureBand", "Site", "ProjectPhase"])
    survival.fit(pd.concat([train, valid]))

    # ---- anomaly ----
    if verbose:
        print("  fitting anomaly detector ...")
    anomaly = AnomalyDetector().fit(pd.concat([train, valid]))

    # ---- drift baseline ----
    drift = evaluate.drift_report(train, test, numeric)

    for name, obj in (("survival", survival), ("anomaly", anomaly)):
        registry.save_artefact(version, name, obj)
    for h, model in models.items():
        registry.save_artefact(version, f"horizon_{h}", model)
    registry.save_artefact(version, "baseline_sample",
                           train.sample(min(4000, len(train)), random_state=3)[numeric])

    record = {
        "algorithm": "LightGBM" if HAS_LGB else "HistGradientBoosting",
        "horizons": sorted(models),
        "n_features": len(numeric) + len(categorical),
        "numeric_features": numeric,
        "categorical_features": categorical,
        "rows": {"train": len(train), "valid": len(valid), "test": len(test)},
        "window": {"train_end": str(train["SnapshotDate"].max().date()),
                   "test_start": str(test["SnapshotDate"].min().date()) if len(test) else None,
                   "data_cutoff": str(df["SnapshotDate"].max().date())},
        "data_fingerprint": registry.data_fingerprint(df),
        "metrics": summary,
        "drift": drift,
        "training_seconds": round(time.time() - t_start, 1),
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    registry.register(version, record)

    warehouse.init_warehouse()
    with warehouse.connect(warehouse.paths.warehouse) as c:
        c.execute("DELETE FROM model_metrics WHERE model_version = ?", (version,))
        c.execute("DELETE FROM feature_drift WHERE model_version = ?", (version,))
    if metric_rows:
        warehouse.write_table(pd.DataFrame(metric_rows), "model_metrics", mode="append")
    if drift:
        warehouse.write_table(
            pd.DataFrame(drift).assign(model_version=version)[
                ["model_version", "feature", "psi", "baseline_mean", "current_mean"]],
            "feature_drift", mode="append")

    if verbose:
        print(f"Registered {version} in {record['training_seconds']}s")
    return record


def load_bundle(version: str | None = None) -> dict:
    version = version or registry.current_version()
    record = registry.get(version)
    models = {h: registry.load_artefact(version, f"horizon_{h}") for h in record["horizons"]}
    return {
        "version": version, "record": record, "horizons": models,
        "survival": registry.load_artefact(version, "survival"),
        "anomaly": registry.load_artefact(version, "anomaly"),
    }


if __name__ == "__main__":
    train_all()
