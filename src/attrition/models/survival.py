"""Survival model.

Instead of forcing the answer into fixed buckets, this estimates a discrete-time
hazard over 26 weekly intervals and multiplies it out into a survival curve:
S(t) = prod(1 - h_k) for k <= t. HR gets "probability this person is still here
in 8 weeks" for any t, not just the five horizons.

Implemented as a person-period logistic hazard rather than Cox, because it
handles time-varying covariates natively (which is the whole point of a weekly
panel) and needs nothing beyond scikit-learn. If lifelines is installed, a
Kaplan-Meier fit is added for cohort-level reference curves.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

INTERVAL_DAYS = 7
N_INTERVALS = 26  # ~6 months ahead


class DiscreteTimeSurvival:
    def __init__(self, numeric: list[str], categorical: list[str], n_intervals: int = N_INTERVALS):
        self.numeric = list(numeric)
        self.categorical = list(categorical)
        self.n_intervals = n_intervals
        self.scaler: StandardScaler | None = None
        self.model: LogisticRegression | None = None
        self.cat_levels: dict[str, list] = {}
        self.baseline_: np.ndarray | None = None

    # ---------- design matrix ----------
    def _design(self, df: pd.DataFrame, k: np.ndarray, fit: bool = False) -> np.ndarray:
        num = df[self.numeric].apply(pd.to_numeric, errors="coerce").fillna(0.0).to_numpy(float)
        if fit:
            self.scaler = StandardScaler().fit(num)
        num = self.scaler.transform(num)
        blocks = [num]
        for c in self.categorical:
            s = df[c].astype("string").fillna("Unknown")
            if fit:
                self.cat_levels[c] = sorted(s.unique().tolist())[:40]
            levels = self.cat_levels.get(c, [])
            onehot = np.zeros((len(df), len(levels)), dtype=float)
            idx = {v: i for i, v in enumerate(levels)}
            for r, v in enumerate(s.to_numpy()):
                j = idx.get(v)
                if j is not None:
                    onehot[r, j] = 1.0
            blocks.append(onehot)
        # interval effects: spline-ish basis on k so the baseline hazard can bend
        kk = k.astype(float).reshape(-1, 1)
        blocks.append(np.hstack([kk, np.log1p(kk), np.sqrt(kk), (kk < 2).astype(float),
                                 (kk < 5).astype(float)]))
        return np.hstack(blocks)

    # ---------- fit ----------
    def fit(self, df: pd.DataFrame, max_rows: int = 260_000, seed: int = 7) -> "DiscreteTimeSurvival":
        """df needs duration_days and event_observed. Rows are expanded to
        person-period form, capped for memory."""
        rng = np.random.default_rng(seed)
        d = df.copy()
        # each snapshot contributes intervals until the event or its censoring time
        d["k_max"] = np.minimum((d["duration_days"] / INTERVAL_DAYS).astype(int), self.n_intervals)
        d = d[d["k_max"] >= 1]
        if len(d) > max_rows // 4:
            d = d.iloc[rng.choice(len(d), max_rows // 4, replace=False)]

        idx, ks, ys = [], [], []
        durations = d["duration_days"].to_numpy()
        events = d["event_observed"].to_numpy()
        kmax = d["k_max"].to_numpy()
        for i in range(len(d)):
            n_k = int(kmax[i])
            for k in range(1, n_k + 1):
                idx.append(i)
                ks.append(k)
                last = (k == n_k)
                ys.append(1 if (last and events[i] == 1 and durations[i] <= self.n_intervals * INTERVAL_DAYS) else 0)
        idx = np.asarray(idx)
        ks = np.asarray(ks)
        ys = np.asarray(ys)
        if len(idx) > max_rows:
            sel = rng.choice(len(idx), max_rows, replace=False)
            idx, ks, ys = idx[sel], ks[sel], ys[sel]

        expanded = d.iloc[idx]
        X = self._design(expanded, ks, fit=True)
        self.model = LogisticRegression(max_iter=600, C=0.7, solver="lbfgs", n_jobs=-1)
        self.model.fit(X, ys)
        self.baseline_ = self.survival_curve(d.head(2000)).mean(axis=0)
        return self

    # ---------- predict ----------
    def hazards(self, df: pd.DataFrame) -> np.ndarray:
        out = np.zeros((len(df), self.n_intervals))
        for k in range(1, self.n_intervals + 1):
            X = self._design(df, np.full(len(df), k))
            out[:, k - 1] = self.model.predict_proba(X)[:, 1]
        return out

    def survival_curve(self, df: pd.DataFrame) -> np.ndarray:
        return np.cumprod(1.0 - self.hazards(df), axis=1)

    def curve_points(self, df: pd.DataFrame) -> list[list[dict]]:
        surv = self.survival_curve(df)
        pts = []
        for row in surv:
            pts.append([{"day": 0, "survival": 1.0}] +
                       [{"day": (k + 1) * INTERVAL_DAYS, "survival": round(float(row[k]), 4)}
                        for k in range(self.n_intervals)])
        return pts

    def expected_days(self, df: pd.DataFrame) -> np.ndarray:
        """Restricted mean survival time over the modelled window (days)."""
        surv = self.survival_curve(df)
        return surv.sum(axis=1) * INTERVAL_DAYS


def kaplan_meier(durations: np.ndarray, events: np.ndarray, max_days: int = 400) -> list[dict]:
    """Cohort reference curve. Uses lifelines when available, else a direct KM estimate."""
    try:  # pragma: no cover
        from lifelines import KaplanMeierFitter
        kmf = KaplanMeierFitter().fit(durations, events)
        sf = kmf.survival_function_.reset_index()
        sf.columns = ["day", "survival"]
        sf = sf[sf["day"] <= max_days]
        return [{"day": float(r.day), "survival": round(float(r.survival), 4)} for r in sf.itertuples()]
    except Exception:
        order = np.argsort(durations)
        d, e = np.asarray(durations)[order], np.asarray(events)[order]
        n = len(d)
        s, at_risk, out = 1.0, n, [{"day": 0.0, "survival": 1.0}]
        for i, (t, ev) in enumerate(zip(d, e)):
            if t > max_days:
                break
            if ev == 1 and at_risk > 0:
                s *= 1 - 1 / at_risk
                out.append({"day": float(t), "survival": round(s, 4)})
            at_risk -= 1
        return out
