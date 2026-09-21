"""Behavioural anomaly detection.

A separate signal from the risk score. The classifier answers "does this look
like someone who leaves?"; this answers "did something change abruptly for this
person?" A steady high-risk employee and one whose attendance collapsed last
week need different conversations, and a model trained on past exits will miss
the second if the pattern is new.

Isolation Forest over week-on-week deltas, with the score mapped to 0-100 so it
can sit next to the risk percentage without being mistaken for one.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

DELTA_FEATURES = [
    "OvertimeHours7D_delta_4w", "AbsenceDays7D_delta_4w", "EngagementScore_delta_4w",
    "LateCount7D_delta_4w", "PerformanceRating_delta_4w", "SalaryCreditDelayDays_delta_4w",
    "OvertimeHours7D_slope_8w", "AbsenceDays7D_slope_8w", "EngagementScore_slope_8w",
    "engagement_drop_8w", "absence_burst", "site_headcount_change_8w",
]


class AnomalyDetector:
    def __init__(self, features: list[str] | None = None, contamination: float = 0.04):
        self.features = features or DELTA_FEATURES
        self.contamination = contamination
        self.model: IsolationForest | None = None
        self.lo_: float = 0.0
        self.hi_: float = 1.0

    def _matrix(self, df: pd.DataFrame) -> np.ndarray:
        cols = [c for c in self.features if c in df.columns]
        self.features = cols
        return df[cols].apply(pd.to_numeric, errors="coerce").fillna(0.0).to_numpy(float)

    def fit(self, df: pd.DataFrame, sample: int = 120_000, seed: int = 11) -> "AnomalyDetector":
        X = self._matrix(df)
        if len(X) > sample:
            rng = np.random.default_rng(seed)
            X = X[rng.choice(len(X), sample, replace=False)]
        self.model = IsolationForest(n_estimators=250, contamination=self.contamination,
                                     max_samples=min(4096, len(X)), random_state=seed, n_jobs=-1)
        self.model.fit(X)
        raw = -self.model.score_samples(X)
        self.lo_, self.hi_ = float(np.percentile(raw, 1)), float(np.percentile(raw, 99.5))
        return self

    def score(self, df: pd.DataFrame) -> np.ndarray:
        raw = -self.model.score_samples(self._matrix(df))
        scaled = (raw - self.lo_) / max(self.hi_ - self.lo_, 1e-9)
        return np.clip(scaled, 0, 1) * 100

    def flag(self, df: pd.DataFrame, threshold: float = 72.0) -> np.ndarray:
        return (self.score(df) >= threshold).astype(int)

    def explain(self, df: pd.DataFrame, top_n: int = 3) -> list[list[dict]]:
        """Which delta was most extreme relative to the population."""
        X = self._matrix(df)
        med = np.median(X, axis=0)
        mad = np.median(np.abs(X - med), axis=0) + 1e-6
        z = np.abs(X - med) / mad
        out = []
        for r in range(len(X)):
            order = np.argsort(-z[r])[:top_n]
            out.append([{"feature": self.features[i], "z": round(float(z[r, i]), 2),
                         "value": round(float(X[r, i]), 2)} for i in order if z[r, i] > 2.0])
        return out
