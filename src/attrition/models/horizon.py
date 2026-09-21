"""Horizon risk models.

One calibrated classifier per horizon (7/15/30/90/180 days), each answering the
same question at a different range: given everything known as of this date, what
is the probability of an attrition event within the next H days?

LightGBM is preferred because it handles categoricals natively and gives exact
SHAP values through `pred_contrib`, which removes the runtime dependency on the
shap package. If LightGBM is not installed the models fall back to scikit-learn's
HistGradientBoostingClassifier and the explainer switches to its own path.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.isotonic import IsotonicRegression

try:  # optional, strongly preferred
    import lightgbm as lgb
    HAS_LGB = True
except Exception:  # pragma: no cover
    HAS_LGB = False
    from sklearn.ensemble import HistGradientBoostingClassifier


class HorizonModel:
    """Gradient-boosted classifier plus isotonic calibration for one horizon."""

    def __init__(self, horizon: int, numeric: list[str], categorical: list[str],
                 params: dict | None = None):
        self.horizon = horizon
        self.numeric = list(numeric)
        self.categorical = list(categorical)
        self.features = self.numeric + self.categorical
        self.params = params or {}
        self.model = None
        self.calibrator: IsotonicRegression | None = None
        self.categories_: dict[str, list] = {}
        self.base_rate_: float = 0.0

    # ---------- encoding ----------
    def _prepare(self, df: pd.DataFrame, fit: bool = False) -> pd.DataFrame:
        X = df[self.features].copy()
        for c in self.categorical:
            s = X[c].astype("string").fillna("Unknown")
            if fit:
                self.categories_[c] = sorted(s.dropna().unique().tolist())
            cats = self.categories_.get(c, [])
            X[c] = pd.Categorical(s, categories=cats)
            if not HAS_LGB:
                X[c] = X[c].cat.codes.astype(float)
        for c in self.numeric:
            X[c] = pd.to_numeric(X[c], errors="coerce").astype(float)
        return X

    # ---------- training ----------
    def fit(self, train: pd.DataFrame, valid: pd.DataFrame, y_col: str) -> "HorizonModel":
        Xtr, ytr = self._prepare(train, fit=True), train[y_col].to_numpy()
        Xva, yva = self._prepare(valid), valid[y_col].to_numpy()
        self.base_rate_ = float(ytr.mean())
        pos_weight = float((len(ytr) - ytr.sum()) / max(ytr.sum(), 1))

        if HAS_LGB:
            params = dict(
                objective="binary", learning_rate=0.045, num_leaves=48, max_depth=-1,
                min_child_samples=60, feature_fraction=0.75, bagging_fraction=0.8,
                bagging_freq=1, lambda_l2=2.0, scale_pos_weight=min(pos_weight, 25.0),
                n_estimators=900, verbose=-1, n_jobs=-1,
            )
            params.update(self.params)
            self.model = lgb.LGBMClassifier(**params)
            self.model.fit(
                Xtr, ytr, eval_set=[(Xva, yva)], eval_metric="average_precision",
                categorical_feature=self.categorical,
                callbacks=[lgb.early_stopping(80, verbose=False), lgb.log_evaluation(0)],
            )
        else:  # pragma: no cover
            self.model = HistGradientBoostingClassifier(
                learning_rate=0.06, max_iter=400, max_leaf_nodes=48,
                min_samples_leaf=40, l2_regularization=1.0, early_stopping=True,
                validation_fraction=0.15, random_state=7)
            self.model.fit(Xtr, ytr)

        # isotonic calibration on the held-out window: boosted trees with class
        # weighting are badly miscalibrated, and HR reads these numbers as percentages
        raw_va = self._raw_proba(Xva)
        if len(np.unique(yva)) > 1:
            self.calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
            self.calibrator.fit(raw_va, yva)
        return self

    def _raw_proba(self, X: pd.DataFrame) -> np.ndarray:
        return self.model.predict_proba(X)[:, 1]

    def predict_proba(self, df: pd.DataFrame, calibrated: bool = True) -> np.ndarray:
        X = self._prepare(df)
        p = self._raw_proba(X)
        if calibrated and self.calibrator is not None:
            p = self.calibrator.predict(p)
        return np.clip(p, 1e-6, 1 - 1e-6)

    # ---------- explanation ----------
    def contributions(self, df: pd.DataFrame) -> tuple[np.ndarray, float]:
        """Exact SHAP contributions in log-odds space plus the base value."""
        X = self._prepare(df)
        if HAS_LGB:
            contrib = self.model.booster_.predict(X, pred_contrib=True)
            return contrib[:, :-1], float(contrib[0, -1])
        try:  # pragma: no cover
            import shap
            explainer = shap.TreeExplainer(self.model)
            vals = explainer.shap_values(X)
            vals = vals[1] if isinstance(vals, list) else vals
            return np.asarray(vals), float(np.ravel(explainer.expected_value)[-1])
        except Exception:
            return np.zeros((len(X), len(self.features))), 0.0

    def importance(self) -> pd.DataFrame:
        if HAS_LGB:
            gain = self.model.booster_.feature_importance(importance_type="gain")
        else:  # pragma: no cover
            gain = np.zeros(len(self.features))
        return (pd.DataFrame({"feature": self.features, "gain": gain})
                .sort_values("gain", ascending=False).reset_index(drop=True))
