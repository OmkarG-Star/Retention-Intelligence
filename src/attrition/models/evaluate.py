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
    # the watchlist's own operating point (High + Critical = top 15%)
    out["recall_at_15"] = float(_recall_at_k(y, p, 0.15))
    out["precision_at_15"] = float(_precision_at_k(y, p, 0.15))
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


def bootstrap_ci(y: np.ndarray, p: np.ndarray, groups: np.ndarray, metric=average_precision_score,
                 n_boot: int = 200, seed: int = 17, alpha: float = 0.05) -> tuple[float, float]:
    """Confidence interval resampling *employees*, not rows.

    One person contributes many weekly rows, so a row bootstrap treats
    correlated rows as independent evidence and reports intervals that are far
    too narrow.
    """
    y, p, groups = np.asarray(y).astype(int), np.asarray(p, float), np.asarray(groups)
    uniq, inv = np.unique(groups, return_inverse=True)
    members = [np.flatnonzero(inv == g) for g in range(len(uniq))]
    rng = np.random.default_rng(seed)
    stats = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(uniq), len(uniq))
        idx = np.concatenate([members[g] for g in pick])
        if y[idx].min() == y[idx].max():
            continue
        stats.append(metric(y[idx], p[idx]))
    if not stats:
        return float("nan"), float("nan")
    lo, hi = np.quantile(stats, [alpha / 2, 1 - alpha / 2])
    return float(lo), float(hi)


def operating_threshold(p: np.ndarray, percentile: float) -> float:
    """Score above which a row falls in the flagged top (100 - percentile)%."""
    return float(np.percentile(np.asarray(p, float), percentile))


def fairness_slices(df: pd.DataFrame, y_col: str, p_col: str, by: list[str],
                    flag_percentile: float = 85.0, min_n: int = 150,
                    min_events: int = 15) -> list[dict]:
    """Group-level checks at the threshold the product actually uses.

    calibration_ratio  mean predicted / observed rate. Below ~0.8 the model
                       under-states this group's risk, so its people get
                       flagged too late; above ~1.25 it over-states it.
    flag_rate          share flagged at the watchlist cut (top 15% overall).
    recall             share of this group's leavers that the cut catches.
                       Large gaps here are the fairness problem that matters
                       for a retention tool: one site's leavers get a
                       conversation, another's do not.
    """
    if df.empty:
        return []
    thr = operating_threshold(df[p_col], flag_percentile)
    rows = []
    for col in by:
        if col not in df.columns:
            continue
        for value, grp in df.groupby(col):
            if len(grp) < min_n:
                continue
            y = grp[y_col].to_numpy().astype(int)
            p = grp[p_col].to_numpy(float)
            flagged = p >= thr
            events = int(y.sum())
            base = float(y.mean())
            rows.append({
                "attribute": col, "group": str(value), "n": int(len(grp)), "events": events,
                "base_rate": round(base, 4),
                "mean_score": round(float(p.mean()), 4),
                "calibration_ratio": round(float(p.mean() / base), 3) if events >= min_events else None,
                "flag_rate": round(float(flagged.mean()), 4),
                "recall": round(float(flagged[y == 1].mean()), 3) if events >= min_events else None,
                "pr_auc": round(float(average_precision_score(y, p)), 4)
                if events >= min_events and events < len(y) else None,
            })
    if not rows:
        return rows
    frame = pd.DataFrame(rows)
    for _, grp in frame.groupby("attribute"):
        best = grp["recall"].max()
        frame.loc[grp.index, "recall_ratio"] = (grp["recall"] / best).round(3) if best else None
    out = []
    for r in frame.to_dict("records"):
        r = {k: (None if isinstance(v, float) and np.isnan(v) else v) for k, v in r.items()}
        # Recall differs between groups whenever their risk differs, so only a
        # material gap with enough events to trust is raised as an issue.
        issues = []
        cr, rr = r.get("calibration_ratio"), r.get("recall_ratio")
        solid = (r.get("events") or 0) >= 50
        if solid and cr is not None and cr < 0.75:
            issues.append("under-predicted")
        if solid and cr is not None and cr > 1.33:
            issues.append("over-predicted")
        if solid and rr is not None and rr < 0.5:
            issues.append("leavers missed more often")
        r["issues"] = issues
        out.append(r)
    return out


def concordance_index(time: np.ndarray, event: np.ndarray, risk: np.ndarray,
                      max_n: int = 4000, seed: int = 5) -> float:
    """Harrell's C: of the pairs where we know who left first, how often did the
    model give the earlier leaver the higher risk. 0.5 is chance."""
    time, event, risk = (np.asarray(a, float) for a in (time, event, risk))
    if len(time) > max_n:
        idx = np.random.default_rng(seed).choice(len(time), max_n, replace=False)
        time, event, risk = time[idx], event[idx], risk[idx]
    num = den = 0.0
    for i in np.flatnonzero(event == 1):
        later = time > time[i]
        if not later.any():
            continue
        den += later.sum()
        num += (risk[i] > risk[later]).sum() + 0.5 * (risk[i] == risk[later]).sum()
    return float(num / den) if den else float("nan")


def lead_time_curve(scored: pd.DataFrame, notice: pd.Series, p_col: str, weeks: int = 12,
                    flag_percentile: float = 85.0, window_start: pd.Timestamp | None = None) -> dict:
    """How far ahead does the watchlist see a resignation coming?

    `scored` holds weekly snapshots (EmployeeID, SnapshotDate, p_col) for
    everyone active that week. Each week is ranked separately, exactly as the
    weekly scoring run would rank it. For every resignation, look back k weeks
    and check whether the person was in that week's flagged top 15%.

    Random flagging catches 15% at every lead time, so the curve's height above
    that line is the model's real early warning.
    """
    s = scored[["EmployeeID", "SnapshotDate", p_col]].copy()
    s["pct"] = s.groupby("SnapshotDate")[p_col].rank(pct=True) * 100
    s["flag"] = s["pct"] >= flag_percentile
    lookup = s.set_index(["EmployeeID", "SnapshotDate"])["flag"]
    start = window_start if window_start is not None else s["SnapshotDate"].min()
    end = s["SnapshotDate"].max()
    notice = notice.dropna()
    leavers = notice[(notice >= start + pd.Timedelta(weeks=weeks)) & (notice <= end)]
    snaps_by_emp = {e: g["SnapshotDate"] for e, g in s[s["EmployeeID"].isin(leavers.index)]
                    .groupby("EmployeeID")}
    curve = []
    for k in range(1, weeks + 1):
        hits = []
        for emp, nd in leavers.items():
            snaps = snaps_by_emp.get(emp)
            if snaps is None:
                continue
            target = nd - pd.Timedelta(weeks=k)
            prior = snaps[(snaps <= target) & (snaps > target - pd.Timedelta(days=7))]
            if prior.empty:
                continue
            hits.append(bool(lookup.get((emp, prior.max()), False)))
        curve.append({"weeks_before": k, "caught": round(float(np.mean(hits)), 3) if hits else None,
                      "n": len(hits)})
    return {"curve": curve, "leavers": int(len(leavers)),
            "random_baseline": round(1 - flag_percentile / 100, 3),
            "flag_share": round(1 - flag_percentile / 100, 3),
            "window": [str(pd.Timestamp(start).date()), str(pd.Timestamp(end).date())]}


OPERATING_KS = (1, 2, 3, 5, 7.5, 10, 12.5, 15, 17.5, 20, 25, 30, 35, 40, 50)


def operating_curve(snap: pd.Series, y: np.ndarray, p: np.ndarray,
                    ks: tuple[float, ...] = OPERATING_KS) -> list[dict]:
    """Precision, recall and lift for every call-list size, ranked week by week.

    The live list is cut each week from that week's scores, so each test week
    is ranked on its own (as `lead_time_curve` does) and the hits are pooled.
    Only the ranking matters here, which isotonic calibration preserves.
    """
    df = pd.DataFrame({"d": pd.to_datetime(snap).to_numpy(), "y": np.asarray(y), "p": np.asarray(p)})
    df["pct"] = df.groupby("d")["p"].rank(pct=True, method="first")
    base = float(df["y"].mean()) or 1e-9
    total = int(df["y"].sum())
    out = []
    for k in ks:
        flag = df["pct"] > 1 - k / 100
        tp = int(df.loc[flag, "y"].sum())
        n = int(flag.sum())
        prec = tp / n if n else 0.0
        out.append({"k": k, "precision": round(prec, 4), "recall": round(tp / total, 4) if total else 0.0,
                    "lift": round(prec / base, 2), "flagged_rows": n, "caught": tp})
    return out


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
