"""Horizon risk models.

One calibrated model per horizon (7/15/30/90/180 days), each answering the same
question at a different range: given everything known as of this date, what is
the probability this person decides to resign within the next H days?

Every horizon trains three candidates and keeps the one that ranks best on the
validation window (champion / challenger). The test window is never used to
choose, so its score stays an honest estimate.

  lgbm      LightGBM, regularised for a rare event on a panel: shallow trees,
            large leaves and no class re-weighting. Weighting positives x22
            with small leaves made the first version stop after one or two
            trees, because every extra tree memorised individual leavers.
  logistic  L2-regularised logistic regression on standardised numerics and
            one-hot categoricals.
  blend     the average of the two in log-odds space.

All three produce exact SHAP values in log-odds space: TreeSHAP via LightGBM's
`pred_contrib`, w_j * (x_j - mean_j) for the linear model, and the same 50/50
average of both for the blend. That keeps every explanation additive and exact
whichever candidate wins.

Probabilities are isotonic-calibrated on the window after the training data,
because HR reads these numbers as percentages.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score

from ..config import N_JOBS

try:  # optional, strongly preferred
    import lightgbm as lgb
    HAS_LGB = True
except Exception:  # pragma: no cover
    HAS_LGB = False

KINDS = ("lgbm", "logistic", "blend") if HAS_LGB else ("logistic",)

LGB_PARAMS = dict(
    objective="binary", learning_rate=0.03, num_leaves=15, max_depth=-1,
    min_child_samples=400, feature_fraction=0.5, bagging_fraction=0.8, bagging_freq=1,
    lambda_l2=10.0, max_bin=63, n_estimators=2000, verbose=-1, random_state=7,
)
LOGISTIC_C = 0.1


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return np.log(p / (1 - p))


class HorizonModel:
    """One candidate (or champion) model for one horizon, with calibration and
    exact log-odds explanations."""

    def __init__(self, horizon: int, numeric: list[str], categorical: list[str],
                 kind: str = "lgbm", params: dict | None = None):
        if kind not in ("lgbm", "logistic", "blend"):
            raise ValueError(f"unknown model kind {kind!r}")
        self.horizon = horizon
        self.kind = kind
        self.numeric = list(numeric)
        self.categorical = list(categorical)
        self.features = self.numeric + self.categorical
        self.params = params or {}
        self.lgb_model = None
        self.lr_pipe = None
        self.lr_background_: np.ndarray | None = None
        self.lr_slices_: list[slice] = []
        self.calibrator: IsotonicRegression | None = None
        self.categories_: dict[str, list] = {}
        self.base_rate_: float = 0.0
        self.best_iteration_: int = 0
        self.valid_pr_auc_: float = float("nan")

    # ---------- encoding ----------
    def _prepare(self, df: pd.DataFrame, fit: bool = False) -> pd.DataFrame:
        X = df[self.features].copy()
        for c in self.categorical:
            s = X[c].astype("string").fillna("Unknown")
            if fit:
                self.categories_[c] = sorted(s.dropna().unique().tolist())
            X[c] = pd.Categorical(s, categories=self.categories_.get(c, []))
        for c in self.numeric:
            X[c] = pd.to_numeric(X[c], errors="coerce").astype(float)
        return X

    def _lr_frame(self, X: pd.DataFrame) -> pd.DataFrame:
        Z = X.copy()
        for c in self.categorical:
            Z[c] = Z[c].astype(object).where(Z[c].notna(), "Unknown")
        return Z

    # ---------- training ----------
    def _fit_lgb(self, Xtr, ytr, Xva, yva, n_estimators):
        params = {**LGB_PARAMS, "n_jobs": N_JOBS, **self.params}
        if n_estimators:
            params["n_estimators"] = int(n_estimators)
        self.lgb_model = lgb.LGBMClassifier(**params)
        if n_estimators:
            self.lgb_model.fit(Xtr, ytr, categorical_feature=self.categorical)
            self.best_iteration_ = int(n_estimators)
        else:
            self.lgb_model.fit(
                Xtr, ytr, eval_set=[(Xva, yva)], eval_metric="average_precision",
                categorical_feature=self.categorical,
                callbacks=[lgb.early_stopping(100, verbose=False), lgb.log_evaluation(0)])
            self.best_iteration_ = int(self.lgb_model.best_iteration_ or params["n_estimators"])

    def _fit_lr(self, Xtr, ytr):
        from sklearn.compose import ColumnTransformer
        from sklearn.impute import SimpleImputer
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline, make_pipeline
        from sklearn.preprocessing import OneHotEncoder, StandardScaler

        pre = ColumnTransformer([
            ("num", make_pipeline(SimpleImputer(strategy="median"), StandardScaler()), self.numeric),
            ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), self.categorical),
        ])
        self.lr_pipe = Pipeline([("pre", pre), ("lr", LogisticRegression(
            C=LOGISTIC_C, max_iter=500, solver="lbfgs"))])
        Z = self._lr_frame(Xtr)
        self.lr_pipe.fit(Z, ytr)
        # column ranges of each original feature in the transformed matrix
        enc = self.lr_pipe.named_steps["pre"].named_transformers_["cat"]
        widths = [1] * len(self.numeric) + [len(c) for c in enc.categories_]
        edges = np.cumsum([0] + widths)
        self.lr_slices_ = [slice(a, b) for a, b in zip(edges[:-1], edges[1:])]
        self.lr_background_ = np.asarray(self.lr_pipe.named_steps["pre"].transform(Z)).mean(axis=0)

    def fit(self, train: pd.DataFrame, valid: pd.DataFrame, y_col: str,
            n_estimators: int | None = None) -> "HorizonModel":
        """Fit on `train`, calibrate on `valid`.

        With `n_estimators=None` LightGBM picks its tree count by early stopping
        on `valid` (evaluation fit). A fixed count skips early stopping: the
        deployment refit reuses what the evaluation fit found.
        """
        Xtr, ytr = self._prepare(train, fit=True), train[y_col].to_numpy()
        Xva, yva = self._prepare(valid), valid[y_col].to_numpy()
        self.base_rate_ = float(ytr.mean())
        if self.kind in ("lgbm", "blend"):
            self._fit_lgb(Xtr, ytr, Xva, yva, n_estimators)
        if self.kind in ("logistic", "blend"):
            self._fit_lr(Xtr, ytr)

        self._calibrate(Xva, yva)
        return self

    def _calibrate(self, Xva: pd.DataFrame, yva: np.ndarray) -> None:
        raw_va = self._raw_logit(Xva)
        if len(np.unique(yva)) > 1:
            self.valid_pr_auc_ = float(average_precision_score(yva, raw_va))
            self.calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
            self.calibrator.fit(raw_va, yva)

    @classmethod
    def blend_of(cls, tree: "HorizonModel", linear: "HorizonModel", valid: pd.DataFrame,
                 y_col: str) -> "HorizonModel":
        """Blend two already-fitted candidates without retraining either."""
        out = cls(tree.horizon, tree.numeric, tree.categorical, kind="blend")
        out.categories_ = tree.categories_
        out.base_rate_ = tree.base_rate_
        out.best_iteration_ = tree.best_iteration_
        out.lgb_model = tree.lgb_model
        out.lr_pipe, out.lr_slices_ = linear.lr_pipe, linear.lr_slices_
        out.lr_background_ = linear.lr_background_
        out._calibrate(out._prepare(valid), valid[y_col].to_numpy())
        return out

    # ---------- prediction ----------
    def _raw_logit(self, X: pd.DataFrame) -> np.ndarray:
        parts = []
        if self.lgb_model is not None:
            parts.append(self.lgb_model.predict(X, raw_score=True))
        if self.lr_pipe is not None:
            parts.append(self.lr_pipe.decision_function(self._lr_frame(X)))
        return np.mean(parts, axis=0)

    def predict_proba(self, df: pd.DataFrame, calibrated: bool = True) -> np.ndarray:
        raw = self._raw_logit(self._prepare(df))
        sig = 1 / (1 + np.exp(-raw))
        if not (calibrated and self.calibrator is not None):
            return np.clip(sig, 1e-6, 1 - 1e-6)
        # Isotonic output is a step function: everyone on a step ties, and ties
        # throw away ranking the raw score already had (about 0.015 PR-AUC
        # here). A 1e-6 nudge by the raw score orders people within a step
        # without moving any probability by a visible amount.
        p = self.calibrator.predict(raw) + 1e-6 * sig
        return np.clip(p, 1e-6, 1 - 1e-6)

    # ---------- explanation ----------
    def contributions(self, df: pd.DataFrame) -> tuple[np.ndarray, float]:
        """Exact SHAP contributions in log-odds space plus the base value.
        Columns line up with `self.features`."""
        X = self._prepare(df)
        parts, bases = [], []
        if self.lgb_model is not None:
            c = self.lgb_model.booster_.predict(X, pred_contrib=True)
            parts.append(c[:, :-1])
            bases.append(float(c[0, -1]))
        if self.lr_pipe is not None:
            Z = np.asarray(self.lr_pipe.named_steps["pre"].transform(self._lr_frame(X)))
            lr = self.lr_pipe.named_steps["lr"]
            w = lr.coef_.ravel()
            col = w * (Z - self.lr_background_)
            parts.append(np.column_stack([col[:, s].sum(axis=1) for s in self.lr_slices_]))
            bases.append(float(lr.intercept_[0] + w @ self.lr_background_))
        return np.mean(parts, axis=0), float(np.mean(bases))

    def importance(self, df: pd.DataFrame) -> pd.DataFrame:
        """Share of mean |SHAP| per feature on `df`. The same measure for every
        model kind, so a tree, a linear model and a blend compare directly
        (tree gain or summed |coefficients| would not)."""
        contrib, _ = self.contributions(df)
        scores = np.abs(contrib).mean(axis=0)
        return (pd.DataFrame({"feature": self.features, "importance": scores / (scores.sum() or 1)})
                .sort_values("importance", ascending=False).reset_index(drop=True))


def monotone_horizons(probs: dict[int, np.ndarray]) -> dict[int, np.ndarray]:
    """Resigning within 90 days includes resigning within 30, so P(90) >= P(30).

    Independently trained horizon models can break that by a hair, which shows
    up on screen as a 30-day risk above the 90-day one. A running maximum over
    increasing horizons restores the ordering without moving any value that was
    already consistent.
    """
    out, running = {}, None
    for h in sorted(probs):
        running = probs[h] if running is None else np.maximum(running, probs[h])
        out[h] = running
    return out
