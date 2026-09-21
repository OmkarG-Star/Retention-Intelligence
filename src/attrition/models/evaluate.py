"""Evaluation and monitoring.

PR-AUC leads because attrition is rare and ROC-AUC flatters rare-event models.
Calibration is tracked separately from discrimination: a model can rank people
correctly and still be unusable if "68%" does not mean 68%, and HR will read
these as percentages whatever the caveat says.

Fairness slices and PSI drift are computed here rather than bolted on later,
because a retention model that quietly targets one site or one contract type is
a liability regardless of its AUC.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import (average_precision_score, brier_score_loss, roc_auc_score)


def discrimination(y: np.ndarray, p: np.ndarray) -> dict[str, float]:
    y = np.asarray(y).astype(int)
    p = np.asarray(p, dtype=float)
    out = {"n": int(len(y)), "positives": int(y.sum()), "base_rate": float(y.mean()) if len(y) else 0.0}
    if len(np.unique(y)) < 2:
        return {**out, "roc_auc": float("nan"), "pr_auc": float("nan"), "brier": float("nan")}
    out["roc_auc"] = float(roc_auc_score(y, p))
    out["pr_auc"] = float(average_precision_score(y, p))
    out["brier"] = float(brier_score_loss(y, p))
    out["lift_at_10"] = float(_lift_at_k(y, p, 0.10))
    out["recall_at_10"] = float(_recall_at_k(y, p, 0.10))
    out["precision_at_10"] = float(_precision_at_k(y, p, 0.10))
    out["recall_at_20"] = float(_recall_at_k(y, p, 0.20))
    return out


def _top_k_mask(p: np.ndarray, k: float) -> np.ndarray:
    n = max(int(len(p) * k), 1)
    idx = np.argsort(-p)[:n]
    mask = np.zeros(len(p), dtype=bool)
    mask[idx] = True
    return mask


def _lift_at_k(y, p, k):
    mask = _top_k_mask(p, k)
    base = y.mean()
    return (y[mask].mean() / base) if base > 0 else float("nan")


def _recall_at_k(y, p, k):
    mask = _top_k_mask(p, k)
    return y[mask].sum() / max(y.sum(), 1)


def _precision_at_k(y, p, k):
    mask = _top_k_mask(p, k)
    return y[mask].mean() if mask.sum() else 0.0


def calibration_bins(y: np.ndarray, p: np.ndarray, n_bins: int = 10) -> list[dict]:
    df = pd.DataFrame({"y": np.asarray(y).astype(int), "p": np.asarray(p, dtype=float)})
    if df.empty:
        return []
    df["bin"] = pd.qcut(df["p"].rank(method="first"), q=min(n_bins, max(df["p"].nunique(), 1)),
                        labels=False, duplicates="drop")
    grouped = df.groupby("bin").agg(predicted=("p", "mean"), observed=("y", "mean"),
                                    n=("y", "size")).reset_index()
    return [{"bin": int(r.bin), "predicted": round(float(r.predicted), 4),
             "observed": round(float(r.observed), 4), "n": int(r.n)}
            for r in grouped.itertuples()]


def fairness_slices(df: pd.DataFrame, y_col: str, p_col: str,
                    by: list[str], min_n: int = 150) -> list[dict]:
    rows = []
    for col in by:
        if col not in df.columns:
            continue
        for value, grp in df.groupby(col):
            if len(grp) < min_n:
                continue
            m = discrimination(grp[y_col].to_numpy(), grp[p_col].to_numpy())
            rows.append({
                "attribute": col, "group": str(value), "n": m["n"],
                "base_rate": round(m["base_rate"], 4),
                "mean_score": round(float(grp[p_col].mean()), 4),
                "pr_auc": round(m.get("pr_auc", float("nan")), 4),
                "flag_rate_at_50": round(float((grp[p_col] >= 0.5).mean()), 4),
            })
    if rows:
        frame = pd.DataFrame(rows)
        # selection-rate parity vs the best-off group, per attribute
        for attr, grp in frame.groupby("attribute"):
            ref = grp["flag_rate_at_50"].max() or 1e-9
            frame.loc[grp.index, "selection_ratio"] = (grp["flag_rate_at_50"] / ref).round(3)
        rows = frame.to_dict("records")
    return rows


def psi(baseline: np.ndarray, current: np.ndarray, bins: int = 10) -> float:
    """Population Stability Index. >0.25 means the input distribution has moved
    enough that the model should be retrained before it is trusted."""
    baseline = pd.to_numeric(pd.Series(baseline), errors="coerce").dropna().to_numpy()
    current = pd.to_numeric(pd.Series(current), errors="coerce").dropna().to_numpy()
    if len(baseline) < 50 or len(current) < 50:
        return 0.0
    edges = np.unique(np.quantile(baseline, np.linspace(0, 1, bins + 1)))
    if len(edges) < 3:
        return 0.0
    b = np.histogram(baseline, bins=edges)[0] / len(baseline)
    c = np.histogram(current, bins=edges)[0] / len(current)
    b, c = np.clip(b, 1e-4, None), np.clip(c, 1e-4, None)
    return float(np.sum((c - b) * np.log(c / b)))


def drift_report(baseline: pd.DataFrame, current: pd.DataFrame,
                 features: list[str], top_n: int = 25) -> list[dict]:
    rows = []
    for f in features:
        if f not in baseline.columns or f not in current.columns:
            continue
        if not pd.api.types.is_numeric_dtype(baseline[f]):
            continue
        value = psi(baseline[f].to_numpy(), current[f].to_numpy())
        rows.append({"feature": f, "psi": round(value, 4),
                     "baseline_mean": round(float(pd.to_numeric(baseline[f], errors="coerce").mean()), 4),
                     "current_mean": round(float(pd.to_numeric(current[f], errors="coerce").mean()), 4),
                     "status": "shifted" if value > 0.25 else ("watch" if value > 0.1 else "stable")})
    rows.sort(key=lambda r: -r["psi"])
    return rows[:top_n]
