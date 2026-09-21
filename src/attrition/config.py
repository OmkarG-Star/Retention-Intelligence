"""Central configuration. Everything resolves from PROJECT_ROOT so the app runs
from any working directory (VS Code, terminal, Docker, systemd)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _path(key: str, default: str) -> Path:
    raw = os.environ.get(key)
    p = Path(raw) if raw else PROJECT_ROOT / default
    return p if p.is_absolute() else PROJECT_ROOT / p


@dataclass(frozen=True)
class Paths:
    root: Path = PROJECT_ROOT
    data_raw: Path = field(default_factory=lambda: _path("DATA_RAW_DIR", "data/raw"))
    data_processed: Path = field(default_factory=lambda: _path("DATA_PROCESSED_DIR", "data/processed"))
    models: Path = field(default_factory=lambda: _path("MODEL_DIR", "models"))
    frontend: Path = field(default_factory=lambda: PROJECT_ROOT / "frontend")
    warehouse: Path = field(default_factory=lambda: _path("WAREHOUSE_DB", "data/processed/warehouse.db"))
    app_db: Path = field(default_factory=lambda: _path("APP_DB", "data/processed/app.db"))

    def ensure(self) -> "Paths":
        for p in (self.data_raw, self.data_processed, self.models):
            p.mkdir(parents=True, exist_ok=True)
        return self


# Prediction horizons in days. Every horizon gets its own calibrated classifier.
HORIZONS: tuple[int, ...] = (7, 15, 30, 90, 180)

# Tenure buckets used by the early-attrition layer.
TENURE_BANDS: tuple[tuple[str, int, int], ...] = (
    ("0-7 days", 0, 7),
    ("8-15 days", 8, 15),
    ("16-30 days", 16, 30),
    ("31-90 days", 31, 90),
    ("91-180 days", 91, 180),
    ("181-365 days", 181, 365),
    ("1-2 years", 366, 730),
    ("2+ years", 731, 100000),
)

# Attrition is a rare event: a correctly calibrated 30-day probability sits
# around 2%, so fixed 70/50/25% cut-offs would mark the entire workforce "Low"
# and the tool would be ignored. Bands are therefore relative — where a person
# sits against the rest of the workforce scored in the same run — while the
# calibrated probability stays visible next to it. Thresholds are percentiles.
RISK_BANDS: tuple[tuple[str, float], ...] = (
    ("Critical", 95.0),
    ("High", 85.0),
    ("Medium", 60.0),
    ("Low", 0.0),
)

PRIORITY_BANDS: tuple[tuple[str, float], ...] = (
    ("Critical", 3.5),
    ("High", 2.5),
    ("Medium", 1.5),
    ("Watch", 0.0),
)


def risk_band(percentile: float) -> str:
    """percentile: 0-100 rank of this employee's risk within the scored run."""
    for name, threshold in RISK_BANDS:
        if percentile >= threshold:
            return name
    return "Low"


def priority_band(score: float) -> str:
    """score: risk percentile (0-1) x business criticality (1-5)."""
    for name, threshold in PRIORITY_BANDS:
        if score >= threshold:
            return name
    return "Watch"


@dataclass(frozen=True)
class Settings:
    app_name: str = _env("APP_NAME", "Retention Intelligence")
    env: str = _env("APP_ENV", "development")
    host: str = _env("HOST", "127.0.0.1")
    port: int = int(_env("PORT", "8000"))
    session_ttl_hours: int = int(_env("SESSION_TTL_HOURS", "12"))
    secret_key: str = _env("SECRET_KEY", "dev-secret-change-me")
    # Copilot: falls back to deterministic templated answers when unset.
    anthropic_api_key: str = _env("ANTHROPIC_API_KEY", "")
    anthropic_model: str = _env("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    # Simulation controls
    sim_employees: int = int(_env("SIM_EMPLOYEES", "3200"))
    sim_seed: int = int(_env("SIM_SEED", "20260918"))
    sim_start: str = _env("SIM_START", "2023-04-01")
    sim_end: str = _env("SIM_END", "2026-09-18")
    # Training controls
    validation_months: int = int(_env("VALIDATION_MONTHS", "4"))
    test_months: int = int(_env("TEST_MONTHS", "4"))
    paths: Paths = field(default_factory=lambda: Paths().ensure())


settings = Settings()
paths = settings.paths
