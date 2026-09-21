"""SQLite warehouse.

Two databases keep concerns apart:
  warehouse.db - people data, features, predictions, model metrics (rebuildable)
  app.db       - users, sessions, interventions, audit log (never rebuilt)

SQLite is the default because the whole thing has to run from a folder with no
server. Swap `engine_url` for Postgres in production; the SQL below is portable.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import pandas as pd

from ..config import paths

WAREHOUSE_SCHEMA = """
CREATE TABLE IF NOT EXISTS employee_master (
    EmployeeID TEXT PRIMARY KEY, DOJ TEXT, Department TEXT, Position TEXT, Grade INTEGER,
    Site TEXT, SiteType TEXT, ManagerID TEXT, EmploymentType TEXT, RecruitmentSource TEXT,
    Age INTEGER, PriorExperienceYears REAL, MonthlySalary INTEGER, SalaryVsRoleBenchmark REAL,
    DistanceFromSiteKm REAL, AccommodationProvided INTEGER, BusinessCriticality INTEGER,
    RealisticJobPreview INTEGER, SiteRemoteness REAL
);
CREATE TABLE IF NOT EXISTS employee_weekly (
    EmployeeID TEXT, SnapshotDate TEXT, TenureDays INTEGER, TenureMonths REAL,
    OvertimeHours7D REAL, AbsenceDays7D INTEGER, LateCount7D INTEGER, NightShiftRatio REAL,
    OnboardingCompletionPct REAL, EngagementScore REAL, PerformanceRating REAL,
    TrainingCountToDate INTEGER, MonthsSincePromotion REAL, ManagerChangesToDate INTEGER,
    GrievanceFlag INTEGER, GrievancesToDate INTEGER, SalaryCreditDelayDays REAL,
    MonthlySalary INTEGER, SalaryVsRoleBenchmark REAL, LastHikePct REAL, ProjectPhase TEXT,
    DemobilisationPressure REAL, HeadcountAtSite INTEGER,
    PRIMARY KEY (EmployeeID, SnapshotDate)
);
CREATE TABLE IF NOT EXISTS attrition_outcomes (
    EmployeeID TEXT PRIMARY KEY, ExitDate TEXT, ExitType TEXT, ExitReason TEXT,
    TenureDaysAtExit INTEGER
);
CREATE TABLE IF NOT EXISTS employee_events (
    EmployeeID TEXT, EventDate TEXT, EventType TEXT, EventDetail TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_emp ON employee_events(EmployeeID, EventDate);
CREATE INDEX IF NOT EXISTS ix_weekly_date ON employee_weekly(SnapshotDate);

CREATE TABLE IF NOT EXISTS predictions (
    run_id TEXT, EmployeeID TEXT, as_of TEXT, model_version TEXT,
    risk_7 REAL, risk_15 REAL, risk_30 REAL, risk_90 REAL, risk_180 REAL, risk_percentile REAL,
    prev_risk_30 REAL, risk_velocity REAL, anomaly_score REAL, anomaly_flag INTEGER,
    criticality INTEGER, priority_score REAL, risk_band TEXT, priority_band TEXT,
    survival_curve TEXT, drivers TEXT, expected_days_to_exit REAL,
    PRIMARY KEY (run_id, EmployeeID)
);
CREATE INDEX IF NOT EXISTS ix_pred_emp ON predictions(EmployeeID, as_of);
CREATE TABLE IF NOT EXISTS prediction_runs (
    run_id TEXT PRIMARY KEY, as_of TEXT, created_at TEXT, model_version TEXT,
    n_scored INTEGER, mean_risk_30 REAL, n_critical INTEGER
);
CREATE TABLE IF NOT EXISTS model_metrics (
    model_version TEXT, horizon INTEGER, split TEXT, metric TEXT, value REAL
);
CREATE TABLE IF NOT EXISTS feature_drift (
    model_version TEXT, feature TEXT, psi REAL, baseline_mean REAL, current_mean REAL
);
"""

APP_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
    full_name TEXT, role TEXT NOT NULL, password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, last_login TEXT, is_active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interventions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, EmployeeID TEXT NOT NULL, action TEXT NOT NULL,
    owner TEXT, notes TEXT, risk_at_creation REAL, created_at TEXT NOT NULL,
    due_date TEXT, status TEXT NOT NULL DEFAULT 'Open',
    outcome TEXT, risk_at_close REAL, closed_at TEXT, created_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_interventions_emp ON interventions(EmployeeID);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT,
    action TEXT NOT NULL, detail TEXT
);
"""


@contextmanager
def connect(db: Path) -> Iterator[sqlite3.Connection]:
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_warehouse() -> None:
    with connect(paths.warehouse) as c:
        c.executescript(WAREHOUSE_SCHEMA)


def init_app_db() -> None:
    with connect(paths.app_db) as c:
        c.executescript(APP_SCHEMA)


def load_raw(directory: Path | None = None) -> dict[str, pd.DataFrame]:
    """Read whatever is in data/raw. Accepts .csv, .csv.gz and .xlsx so a real
    export from the HRMS can be dropped in without conversion."""
    directory = directory or paths.data_raw
    wanted = ["employee_master", "employee_weekly", "attrition_outcomes", "employee_events"]
    out: dict[str, pd.DataFrame] = {}
    for name in wanted:
        for suffix in (".csv.gz", ".csv", ".parquet"):
            f = directory / f"{name}{suffix}"
            if f.exists():
                out[name] = pd.read_parquet(f) if suffix == ".parquet" else pd.read_csv(f)
                break
    for xl in directory.glob("*.xlsx"):
        book = pd.ExcelFile(xl)
        for sheet in book.sheet_names:
            key = sheet.strip().lower().replace(" ", "_")
            if key in wanted and key not in out:
                out[key] = book.parse(sheet)
    missing = [w for w in wanted[:3] if w not in out]
    if missing:
        raise FileNotFoundError(
            f"Missing raw tables {missing} in {directory}. Run: python -m attrition.cli generate")
    return out


def ingest(tables: dict[str, pd.DataFrame] | None = None) -> dict[str, int]:
    init_warehouse()
    tables = tables or load_raw()
    counts = {}
    with connect(paths.warehouse) as c:
        for name, df in tables.items():
            if name not in {"employee_master", "employee_weekly", "attrition_outcomes", "employee_events"}:
                continue
            df = df.copy()
            for col in df.columns:
                if pd.api.types.is_datetime64_any_dtype(df[col]):
                    df[col] = df[col].dt.strftime("%Y-%m-%d")
            cols = [r[1] for r in c.execute(f"PRAGMA table_info({name})")]
            keep = [col for col in df.columns if col in cols]
            c.execute(f"DELETE FROM {name}")
            df[keep].to_sql(name, c, if_exists="append", index=False)
            counts[name] = len(df)
    return counts


def query(sql: str, params: tuple | dict = (), db: Path | None = None) -> pd.DataFrame:
    with connect(db or paths.warehouse) as c:
        return pd.read_sql_query(sql, c, params=params)


def write_table(df: pd.DataFrame, table: str, db: Path | None = None, mode: str = "replace") -> None:
    with connect(db or paths.warehouse) as c:
        df.to_sql(table, c, if_exists=mode, index=False)


def log_audit(actor: str, action: str, detail: dict | str | None = None) -> None:
    payload = json.dumps(detail) if isinstance(detail, dict) else (detail or "")
    with connect(paths.app_db) as c:
        c.execute("INSERT INTO audit_log (ts, actor, action, detail) VALUES (datetime('now'),?,?,?)",
                  (actor, action, payload))
