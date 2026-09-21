"""Shared fixtures.

The tests are split into two groups:

* Pure logic tests (features, labels, config bands, explainability, security
  primitives) run on synthetic frames and need nothing but the source tree.
* Integration tests hit the SQLite warehouse and the trained model, so they
  skip cleanly when the pipeline has not been run yet.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


@pytest.fixture(scope="session")
def project_root() -> Path:
    return ROOT


@pytest.fixture(scope="session")
def warehouse_ready() -> bool:
    from attrition.config import paths
    return paths.warehouse.exists()


@pytest.fixture()
def require_warehouse(warehouse_ready):
    if not warehouse_ready:
        pytest.skip("warehouse.db not built - run `python -m attrition.cli pipeline` first")


@pytest.fixture()
def synthetic_panel():
    """Two employees, 20 weekly snapshots each, one of whom exits.

    Columns mirror the warehouse schema exactly, so these tests fail if the
    generator and the feature engine ever drift apart.
    """
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(7)
    dates = pd.date_range("2025-01-06", periods=20, freq="7D")
    rows = []
    for emp, drift in (("E9001", 0.0), ("E9002", 1.4)):
        for i, d in enumerate(dates):
            rows.append({
                "EmployeeID": emp,
                "SnapshotDate": d,
                "TenureDays": 200 + i * 7,
                "TenureMonths": (200 + i * 7) / 30.44,
                "OvertimeHours7D": float(max(0.0, 20 + drift * i * 1.5 + rng.normal(0, 2))),
                "AbsenceDays7D": float(max(0.0, drift * i * 0.08 + rng.normal(0, 0.2))),
                "LateCount7D": float(max(0.0, rng.normal(1, 0.5) + drift * i * 0.05)),
                "NightShiftRatio": 0.2,
                "OnboardingCompletionPct": 100.0,
                "EngagementScore": float(np.clip(7.5 - drift * i * 0.14 + rng.normal(0, 0.15), 1, 10)),
                "PerformanceRating": float(np.clip(3.6 - drift * i * 0.03, 1, 5)),
                "TrainingCountToDate": 2 + i // 10,
                "MonthsSincePromotion": 26 + i // 4,
                "ManagerChangesToDate": 1,
                "GrievanceFlag": 0,
                "GrievancesToDate": 0,
                "SalaryCreditDelayDays": float(0 if i % 7 else 6),
                "MonthlySalary": 38000.0,
                "SalaryVsRoleBenchmark": -4.0,
                "LastHikePct": 6.0,
                "ProjectPhase": "Peak",
                "DemobilisationPressure": 0.1,
                "HeadcountAtSite": 180,
            })
    weekly = pd.DataFrame(rows)

    static = {
        "DOJ": "2024-06-17", "Department": "Civil Execution", "Position": "Site Engineer",
        "Grade": 3, "Site": "Pune Metro", "SiteType": "Urban Infra", "ManagerID": "M01",
        "EmploymentType": "Permanent", "MonthlySalary": 38000.0,
        "SalaryVsRoleBenchmark": -4.0, "AccommodationProvided": 0,
        "BusinessCriticality": 3, "RealisticJobPreview": 1, "SiteRemoteness": 0.3,
    }
    master = pd.DataFrame([
        {"EmployeeID": "E9001", "RecruitmentSource": "Referral", "Age": 29,
         "PriorExperienceYears": 5.0, "DistanceFromSiteKm": 12.0, **static},
        {"EmployeeID": "E9002", "RecruitmentSource": "Consultant", "Age": 31,
         "PriorExperienceYears": 3.0, "DistanceFromSiteKm": 41.0, **static},
    ])

    outcomes = pd.DataFrame([
        {"EmployeeID": "E9002", "ExitDate": dates[-1] + pd.Timedelta(days=10),
         "ExitType": "Voluntary", "ExitReason": "Workload", "TenureDaysAtExit": 343},
    ])
    return weekly, master, outcomes
