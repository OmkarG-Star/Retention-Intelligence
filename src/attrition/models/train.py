"""Training pipeline.

Splits are chronological and set per horizon. A random split would let the
model see March to predict February and report a score the deployed system can
never reproduce.

Each horizon h gets its own timeline, because an h-day label is only known
h days after the snapshot:

    |---- train ----|emb|-- valid --|emb|--- test ---|-- h --| cutoff
                         calibration      reported      label
                                          metrics       window

`emb` is an h-day embargo. Without it the last training rows carry labels that
look into the validation window, and the last validation rows look into test,
so the test score is quietly optimistic.

The test window ends h days before the data cutoff, so every horizon, including
180 days, gets a held-out test set whose labels are fully observed.

After evaluation, the deployed model is refitted on everything up to the test
window, using the tree count the evaluation fit chose, and calibrated on the
most recent fully-labelled window. The reported metrics are for the evaluation
fit, which never saw the test window, so they are a fair estimate for the
refit, which can only be better informed.
"""
from __future__ import annotations

import os
import time
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ..config import FLAG_PERCENTILE, HORIZONS, settings
from ..data import warehouse
from ..features.build import feature_columns, load_features, prepare_outcomes
from . import evaluate, explain, registry
from .anomaly import AnomalyDetector
from .horizon import KINDS, HorizonModel
from .survival import INTERVAL_DAYS, DiscreteTimeSurvival

FAIRNESS_ATTRS = ["Site", "Department", "EmploymentType", "RecruitmentSource", "TenureBand"]
REFIT_FOR_DEPLOY = os.environ.get("REFIT_FOR_DEPLOY", "1") != "0"
BOOTSTRAP_ROUNDS = int(os.environ.get("BOOTSTRAP_ROUNDS", "200"))
BAND_HORIZON = 90  # bands, priority and explanations all come from the 90-day model


def horizon_split(df: pd.DataFrame, h: int, cutoff: pd.Timestamp,
                  valid_months: int | None = None, test_months: int | None = None) -> dict:
    """Embargoed chronological split for one horizon. `df` must already be
    filtered to rows eligible for this horizon."""
    valid_months = valid_months or settings.validation_months
    test_months = test_months or settings.test_months
    d = df["SnapshotDate"]
    emb = pd.Timedelta(days=h)

    obs_end = cutoff - emb                                  # last fully-labelled snapshot
    test_start = obs_end - pd.DateOffset(months=test_months)
    valid_end = test_start - emb
    valid_start = valid_end - pd.DateOffset(months=valid_months)
    train_end = valid_start - emb

    windows = {
        "train": [str(d.min().date()), str(train_end.date())],
        "valid": [str(valid_start.date()), str(valid_end.date())],
        "test": [str(test_start.date()), str(obs_end.date())],
        "embargo_days": h,
    }
    return {
        "train": df[d <= train_end],
        "valid": df[(d > valid_start) & (d <= valid_end)],
        "test": df[(d > test_start) & (d <= obs_end)],
        # deployment: train up to an embargo before the test window, calibrate on it
        "deploy_train": df[d <= test_start - emb],
        "deploy_calib": df[(d > test_start) & (d <= obs_end)],
        "test_start": test_start, "obs_end": obs_end, "windows": windows,
    }


def _round(m: dict) -> dict:
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()}


def train_all(verbose: bool = True) -> dict:
    t_start = time.time()
    df = load_features()
    numeric, categorical = feature_columns(df)
    cutoff = df["SnapshotDate"].max()
    version = registry.new_version()
    log = print if verbose else (lambda *a, **k: None)

    log(f"Training {version}  |  candidates: {', '.join(KINDS)}  |  "
        f"target: voluntary resignation decision")
    log(f"  rows {len(df):,}  |  features {len(numeric)} numeric + {len(categorical)} categorical"
        f"  |  data cutoff {cutoff.date()}")

    deployed: dict[int, HorizonModel] = {}
    eval_models: dict[int, HorizonModel] = {}
    splits: dict[int, dict] = {}
    metric_rows: list[dict] = []
    summary: dict[str, dict] = {}

    for h in HORIZONS:
        y = f"label_{h}"
        sp = horizon_split(df[df[f"eligible_{h}"] == 1], h, cutoff)
        tr, va, te = sp["train"], sp["valid"], sp["test"]
        if tr[y].sum() < 25 or va[y].nunique() < 2 or te[y].nunique() < 2:
            log(f"  [{h:>3}d] skipped - too few observed decisions in one of the windows")
            continue

        # ---- champion / challenger: choose on validation, report on test ----
        candidates: dict[str, HorizonModel] = {}
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            for kind in KINDS:
                if kind == "blend":       # reuse the fitted components, recalibrate only
                    candidates[kind] = HorizonModel.blend_of(candidates["lgbm"],
                                                             candidates["logistic"], va, y)
                else:
                    candidates[kind] = HorizonModel(h, numeric, categorical, kind=kind).fit(tr, va, y)
        champion = max(candidates, key=lambda k: candidates[k].valid_pr_auc_)
        model = candidates[champion]
        eval_models[h], splits[h] = model, sp

        for split_name, part in (("valid", va), ("test", te)):
            m = evaluate.discrimination(part[y].to_numpy(), model.predict_proba(part))
            for k, v in m.items():
                metric_rows.append({"model_version": version, "horizon": h,
                                    "split": split_name, "metric": k, "value": float(v)})

        yt, groups = te[y].to_numpy(), te["EmployeeID"].to_numpy()
        board = {}
        for kind, cand in candidates.items():
            pc = cand.predict_proba(te)
            mc = evaluate.discrimination(yt, pc)
            lo, hi = evaluate.bootstrap_ci(yt, pc, groups, n_boot=BOOTSTRAP_ROUNDS)
            board[kind] = {"valid_pr_auc": round(cand.valid_pr_auc_, 4), "pr_auc_ci": [round(lo, 4), round(hi, 4)],
                           **{k: round(mc[k], 4) for k in ("pr_auc", "roc_auc", "brier",
                                                           "recall_at_15", "precision_at_15")},
                           "champion": kind == champion}
            if kind == champion:
                p, m = pc, mc
        scored = te.reset_index(drop=True).assign(_p=p)

        summary[str(h)] = {
            **_round(m),
            "pr_auc_ci": board[champion]["pr_auc_ci"],
            "champion": champion,
            "candidates": board,
            "n_employees": int(te["EmployeeID"].nunique()),
            "evaluated_on": "test",
            "windows": sp["windows"],
            "best_iteration": model.best_iteration_,
            "calibration": evaluate.calibration_bins(yt, p),
            "fairness": evaluate.fairness_slices(scored, y, "_p", FAIRNESS_ATTRS,
                                                 flag_percentile=FLAG_PERCENTILE),
            "top_features": [
                {"feature": r.feature, "importance": round(float(r.importance), 4),
                 "label": explain.pretty(r.feature)[0], "category": explain.pretty(r.feature)[1]}
                for r in model.importance(te.sample(min(3000, len(te)), random_state=2))
                .head(15).itertuples()],
        }
        lo, hi = board[champion]["pr_auc_ci"]
        log(f"  [{h:>3}d] test {sp['windows']['test'][0]}..{sp['windows']['test'][1]}  "
            f"decisions {m['positives']:>4,}  champion {champion:<8} PR-AUC {m['pr_auc']:.3f} "
            f"[{lo:.3f}-{hi:.3f}]  ROC {m['roc_auc']:.3f}  Brier {m['brier']:.4f}  "
            f"recall@15% {m['recall_at_15']:.2f}  |  "
            + "  ".join(f"{k} {v['pr_auc']:.3f}" for k, v in board.items()))

        if REFIT_FOR_DEPLOY:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                deployed[h] = HorizonModel(h, numeric, categorical, kind=champion).fit(
                    sp["deploy_train"], sp["deploy_calib"], y,
                    n_estimators=model.best_iteration_ or None)
        else:
            deployed[h] = model

    if not deployed:
        raise RuntimeError("No horizon model could be trained - check label eligibility.")

    validation: dict = {}
    band_h = BAND_HORIZON if BAND_HORIZON in eval_models else max(eval_models)
    band_model, band_split = eval_models[band_h], splits[band_h]

    # ---- lead time: how many weeks of warning does the watchlist give? ----
    log("  measuring lead time ...")
    window = df[df["SnapshotDate"] > band_split["test_start"]]
    outcomes = prepare_outcomes(warehouse.query("SELECT * FROM attrition_outcomes"))
    notice = outcomes[outcomes["voluntary"] == 1].set_index("EmployeeID")["NoticeDate"]
    validation["lead_time"] = {
        **evaluate.lead_time_curve(window.assign(_p=band_model.predict_proba(window)), notice, "_p",
                                   flag_percentile=FLAG_PERCENTILE,
                                   window_start=band_split["test_start"]),
        "horizon_model": band_h,
    }

    # ---- explainer check against the simulator's planted mechanism ----
    log("  checking SHAP against the planted drivers ...")
    te_band = band_split["test"]
    sample = te_band.sample(min(6000, len(te_band)), random_state=11).reset_index(drop=True)
    contrib, _ = band_model.contributions(sample)
    validation["shap_recovery"] = explain.shap_recovery(contrib, band_model.features, sample)

    # ---- survival: an independent time-to-decision model, scored by C-index ----
    log("  fitting discrete-time survival model ...")
    t0 = band_split["test_start"]
    surv_rows = df[df["SnapshotDate"] <= t0].copy()
    horizon_cap = (t0 - surv_rows["SnapshotDate"]).dt.days        # re-censor at t0: no peeking
    surv_rows["event_observed"] = ((surv_rows["event_observed"] == 1) &
                                   (surv_rows["duration_days"] <= horizon_cap)).astype(int)
    surv_rows["duration_days"] = np.minimum(surv_rows["duration_days"], horizon_cap)
    surv_num = [c for c in numeric if not c.endswith("_std_8w")][:60]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        survival = DiscreteTimeSurvival(
            surv_num, ["EmploymentType", "TenureBand", "Site", "ProjectPhase"]).fit(surv_rows)
    cap = survival.n_intervals * INTERVAL_DAYS
    surv_eval = te_band.sample(min(4000, len(te_band)), random_state=5)
    t_eval = np.minimum(surv_eval["duration_days"].to_numpy(float), cap)
    e_eval = ((surv_eval["event_observed"] == 1) & (surv_eval["duration_days"] <= cap)).to_numpy(int)
    validation["survival"] = {
        "c_index_survival_model": round(evaluate.concordance_index(
            t_eval, e_eval, -survival.expected_days(surv_eval)), 4),
        "c_index_horizon_model": round(evaluate.concordance_index(
            t_eval, e_eval, band_model.predict_proba(surv_eval)), 4),
        "horizon_model": band_h, "max_days": cap,
        "note": "Harrell's C on the held-out window; 0.5 is chance. The employee view draws "
                "its curve from the horizon models so every number on screen agrees.",
    }

    # ---- anomaly + drift ----
    log("  fitting anomaly detector ...")
    anomaly = AnomalyDetector().fit(df[df["SnapshotDate"] <= t0])
    recent = df[df["SnapshotDate"] > cutoff - pd.Timedelta(weeks=13)]
    drift = evaluate.drift_report(band_split["deploy_train"], recent, numeric)

    for name, obj in (("survival", survival), ("anomaly", anomaly)):
        registry.save_artefact(version, name, obj)
    for h, model in deployed.items():
        registry.save_artefact(version, f"horizon_{h}", model)
    registry.save_artefact(version, "baseline_sample",
                           band_split["deploy_train"].sample(
                               min(4000, len(band_split["deploy_train"])), random_state=3)[numeric])

    record = {
        "algorithm": "Champion per horizon from " + " / ".join(KINDS),
        "champions": {str(h): m.kind for h, m in deployed.items()},
        "target": "Voluntary resignation decision (NoticeDate); terminations and contract ends censor",
        "horizons": sorted(deployed),
        "band_horizon": band_h,
        "flag_percentile": FLAG_PERCENTILE,
        "refit_for_deploy": REFIT_FOR_DEPLOY,
        "n_features": len(numeric) + len(categorical),
        "numeric_features": numeric,
        "categorical_features": categorical,
        "rows": {"total": len(df), **{f"train_{h}": len(s["train"]) for h, s in splits.items()}},
        "window": {"data_cutoff": str(cutoff.date()),
                   "train_end": splits[band_h]["windows"]["train"][1],
                   "test_start": splits[band_h]["windows"]["test"][0]},
        "data_fingerprint": registry.data_fingerprint(df),
        "metrics": summary,
        "validation": validation,
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

    lt = validation["lead_time"]["curve"]
    four = next((c for c in lt if c["weeks_before"] == 4), None)
    sr = validation["shap_recovery"]
    sv = validation["survival"]
    log(f"  lead time: {four['caught']:.0%} of resignations flagged 4 weeks ahead "
        f"(random 15%, n={four['n']})" if four and four["caught"] is not None else "  lead time: n/a")
    log(f"  SHAP recovered {sr['recovered']}/{sr['total']} planted drivers; noise controls "
        + ", ".join(f"{n['feature'].split(' (')[0]} {n['share']:.1%}" for n in sr["noise_controls"]))
    log(f"  C-index: horizon model {sv['c_index_horizon_model']:.3f}  |  "
        f"survival model {sv['c_index_survival_model']:.3f}")
    log(f"Registered {version} in {record['training_seconds']}s")
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
