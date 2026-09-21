"""Feature engine and labelling contract.

The single most damaging failure mode in an attrition model is leakage: a
feature that quietly encodes the future makes the offline metrics look
excellent and the live predictions worthless. These tests pin the two
properties that prevent it.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from attrition.config import HORIZONS, priority_band, risk_band, TENURE_BANDS
from attrition.features.build import (attach_labels, build_features, feature_columns,
                                      tenure_band)


def test_rolling_features_never_use_the_future(synthetic_panel):
    """Truncating the panel must not change the features of the rows that remain.

    If any window looked forward, cutting off later weeks would move earlier
    values. This is the property that guarantees a row scored today could have
    been produced on its own snapshot date.
    """
    weekly, master, _ = synthetic_panel
    full = build_features(weekly, master)

    cut = weekly["SnapshotDate"].sort_values().unique()[12]
    truncated = build_features(weekly[weekly["SnapshotDate"] <= cut], master)

    numeric, _ = feature_columns(full)
    a = full[full["SnapshotDate"] <= cut].sort_values(["EmployeeID", "SnapshotDate"])
    b = truncated.sort_values(["EmployeeID", "SnapshotDate"])

    assert len(a) == len(b)
    for col in numeric:
        np.testing.assert_allclose(
            a[col].to_numpy(dtype=float), b[col].to_numpy(dtype=float),
            rtol=1e-9, atol=1e-9, err_msg=f"feature '{col}' changed when future rows were removed")


def test_exit_date_and_labels_are_excluded_from_the_feature_matrix(synthetic_panel):
    weekly, master, outcomes = synthetic_panel
    labelled = attach_labels(build_features(weekly, master), outcomes)
    numeric, categorical = feature_columns(labelled)
    used = set(numeric) | set(categorical)

    banned = {"ExitDate", "ExitType", "days_to_exit", "duration_days", "event_observed"}
    banned |= {f"label_{h}" for h in HORIZONS} | {f"eligible_{h}" for h in HORIZONS}
    assert not (used & banned), f"leaking columns reached the model: {sorted(used & banned)}"


def test_rows_after_the_exit_date_are_dropped(synthetic_panel):
    weekly, master, outcomes = synthetic_panel
    extra = weekly[weekly["EmployeeID"] == "E9002"].tail(1).copy()
    extra["SnapshotDate"] = extra["SnapshotDate"] + pd.Timedelta(days=60)
    weekly = pd.concat([weekly, extra], ignore_index=True)

    labelled = attach_labels(build_features(weekly, master), outcomes)
    exit_date = pd.to_datetime(outcomes.loc[0, "ExitDate"])
    after = labelled[(labelled["EmployeeID"] == "E9002") & (labelled["SnapshotDate"] >= exit_date)]
    assert after.empty, "snapshots dated on or after the exit are not observations of an employee"


@pytest.mark.parametrize("horizon", HORIZONS)
def test_label_is_one_exactly_inside_the_horizon(synthetic_panel, horizon):
    weekly, master, outcomes = synthetic_panel
    labelled = attach_labels(build_features(weekly, master), outcomes)
    leaver = labelled[labelled["EmployeeID"] == "E9002"]
    inside = leaver["days_to_exit"] <= horizon
    assert (leaver.loc[inside, f"label_{horizon}"] == 1).all()
    assert (leaver.loc[~inside, f"label_{horizon}"] == 0).all()


def test_censored_rows_are_marked_ineligible(synthetic_panel):
    """A stayer observed for only 20 days cannot answer "did they leave within 90?"."""
    weekly, master, outcomes = synthetic_panel
    labelled = attach_labels(build_features(weekly, master), outcomes)
    cutoff = labelled["SnapshotDate"].max()

    for h in HORIZONS:
        recent = labelled[(cutoff - labelled["SnapshotDate"]).dt.days < h]
        stayers = recent[recent[f"label_{h}"] == 0]
        assert (stayers[f"eligible_{h}"] == 0).all(), (
            f"rows without a full {h}-day observation window must not be trained as negatives")
        positives = labelled[labelled[f"label_{h}"] == 1]
        assert (positives[f"eligible_{h}"] == 1).all(), "observed exits are always eligible"


def test_stayer_has_no_exit_signal(synthetic_panel):
    weekly, master, outcomes = synthetic_panel
    labelled = attach_labels(build_features(weekly, master), outcomes)
    stayer = labelled[labelled["EmployeeID"] == "E9001"]
    assert stayer["event_observed"].eq(0).all()
    assert stayer[[f"label_{h}" for h in HORIZONS]].to_numpy().sum() == 0


def test_tenure_bands_cover_every_day_without_overlap():
    assert tenure_band(0) == "0-7 days"
    assert tenure_band(15) == "8-15 days"
    assert tenure_band(5000) == "2+ years"
    edges = [(lo, hi) for _, lo, hi in TENURE_BANDS]
    for (_, hi), (lo, _) in zip(edges, edges[1:]):
        assert lo == hi + 1, "tenure bands must be contiguous"


def test_risk_and_priority_bands():
    assert risk_band(99.1) == "Critical"
    assert risk_band(88.0) == "High"
    assert risk_band(61.0) == "Medium"
    assert risk_band(12.0) == "Low"
    # priority = risk percentile (0-1) x business criticality (1-5)
    assert priority_band(0.92 * 5) == "Critical"
    assert priority_band(0.95 * 1) == "Watch"
