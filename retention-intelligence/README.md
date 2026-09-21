# Retention Intelligence — AI Attrition Early-Warning Platform

A portfolio-grade, end-to-end machine-learning product that turns longitudinal employee data into **calibrated attrition risk, explainable drivers, anomaly signals, prioritized watchlists, and intervention tracking**.

> **Public repository:** all included workforce data is synthetic/demo data generated for this project. It is not company data and must not be replaced with real employee data in a public repository.

![Dashboard preview](docs/screenshots/overview.png)

## Problem statement

HR teams often have employee data but lack a reliable way to answer four operational questions:

1. **Who is most likely to leave soon?**
2. **How soon could the event happen?**
3. **Why is the risk increasing?**
4. **What should HR or a manager investigate first?**

Simple attrition reports are backward-looking. A useful early-warning system needs **time-aware prediction**, leakage-safe features, probability calibration, explainability, anomaly detection, and a workflow for recording what happened after HR acted.

This project implements that workflow for a synthetic EPC/construction workforce.

## Business impact

The system is designed to support—not replace—human HR decisions.

| Capability | Business use |
|---|---|
| Multi-horizon risk | Separate near-term intervention from longer-term retention planning |
| Priority queue | Focus limited HR/manager time on the highest-risk and highest-criticality cases |
| Early-attrition layer | Detect onboarding/channel patterns during the first 30 days |
| Risk velocity | Surface employees whose risk is accelerating, not only those with high absolute risk |
| Behaviour anomalies | Detect abrupt changes that may precede a high-risk classification |
| Explainability | Translate model drivers into understandable HR signals |
| Survival curve | Estimate time-to-event rather than reporting one probability only |
| Intervention log | Connect predicted risk with actions and observed outcomes |
| Governance | Track model metrics, calibration, drift/fairness signals and audit events |

**Important:** the model does not automatically make employment decisions. It produces decision-support signals for human review.

## Architecture

![Architecture](docs/architecture/architecture.svg)

The main flow is:

**Synthetic/source data → validation & ingestion → leakage-safe feature engineering → multi-horizon ML → calibration/survival/SHAP/anomaly detection → FastAPI risk service → dashboard → human intervention → audit/outcome feedback.**

### Technology stack

- **Python 3.10+**
- **FastAPI + Uvicorn**
- **pandas / NumPy / scikit-learn**
- **LightGBM** for tabular prediction
- **SQLite** for a self-contained demo warehouse/application store
- **Dependency-light HTML/CSS/JavaScript frontend**
- **Docker / Docker Compose**
- **pytest** for automated testing

## Data pipeline

The CLI exposes a reproducible pipeline:

```text
1. generate   → synthetic longitudinal workforce data
2. ingest     → validated tables into SQLite
3. features   → leakage-safe trajectory and domain features
4. train      → chronological training / validation / test
5. backfill   → historical scoring runs for trend analysis
6. score      → current employee risk scores
7. seed-users → local demo RBAC accounts
```

Run everything with:

```bash
python -m attrition.cli pipeline
```

### Synthetic dataset

The generator creates a longitudinal workforce with:

- employee master records
- weekly employee snapshots
- employee events
- exit outcomes
- project/site context
- tenure and compensation signals
- overtime, absence, lateness and engagement trajectories
- onboarding and promotion signals
- salary-credit delays
- project phase / demobilisation pressure
- site-level and peer-exit effects

The simulator intentionally contains known mechanisms so that model explanations can be checked against the data-generating process.

## ML methodology

### 1. Five prediction horizons

Separate classifiers estimate risk over:

- 7 days
- 15 days
- 30 days
- 90 days
- 180 days

This avoids treating a short-term intervention question and a long-term workforce-planning question as the same prediction problem.

### 2. Censoring-aware labels

An employee is labelled positive when an exit occurs inside the requested horizon. The row is only eligible when the complete future observation window is available. Incomplete future windows are excluded rather than incorrectly labelled as non-events.

### 3. Leakage-safe feature engineering

Features include:

- current levels
- rolling means/maxima/std deviations
- week-over-week deltas
- trajectory slopes
- current-vs-baseline ratios
- overtime excess
- engagement deficit
- onboarding gap
- compensation benchmark gap
- absence bursts
- stagnation
- commute burden

Time windows are closed on the left so future information cannot enter an as-of snapshot.

### 4. Chronological evaluation

The project uses temporal train/validation/test periods instead of random splitting. Random splitting can allow later observations from the same employee to leak into training.

### 5. Calibration

Isotonic calibration is applied using the validation period. This matters because an operational risk score should be interpretable as a probability, not merely as a ranking score.

### 6. Survival analysis

A discrete-time hazard model generates a survival curve and an expected-days-remaining estimate.

### 7. Explainability

LightGBM contribution values are converted into HR-readable drivers. The application can show which signals increase or decrease predicted risk and map them to possible retention actions.

### 8. Anomaly detection

Isolation Forest is applied to behavioural deltas to detect sudden changes that may not yet produce a high absolute risk score.

### 9. Priority scoring

The watchlist combines predicted risk with business criticality so the operational queue is not simply a list sorted by probability.

## Model metrics

The current synthetic benchmark was trained on **156,472 rows**, validated on **21,993**, and tested on **23,532**, using 106 numeric and 8 categorical features.

| Horizon | Events | PR-AUC | ROC-AUC | Brier | Recall @ top 10% |
|---|---:|---:|---:|---:|---:|
| 7 days | 90 | 0.040 | 0.931 | 0.005 | 0.74 |
| 15 days | 216 | 0.066 | 0.806 | 0.010 | 0.53 |
| 30 days | 446 | 0.200 | 0.882 | 0.023 | 0.64 |
| 90 days | 1,255 | 0.476 | 0.793 | 0.127 | 0.36 |
| 180 days | 3,027 | 0.782 | 0.887 | 0.094 | 0.40 |

Short-horizon PR-AUC must be interpreted against the very low event base rate. The 7-day population has relatively few events, so PR-AUC is naturally much lower than at longer horizons.

![Model governance preview](docs/screenshots/governance.png)

> Metrics are from the synthetic benchmark shipped with this repository. They are **not evidence of production performance** and should not be presented as such.

## Dashboard screenshots

### Executive overview

The dashboard exposes workforce risk bands, expected exits, accelerating risk, anomalies, early attrition, priority queues, risk trends and site segmentation.

![Overview dashboard](docs/screenshots/overview.png)

### Model governance

The governance view surfaces horizon metrics, calibration quality, evaluation methodology and operational governance checks.

![Governance dashboard](docs/screenshots/governance.png)

## AI / analytics features

The platform combines conventional analytics and ML rather than treating an LLM as the prediction engine.

- **Predictive risk:** calibrated multi-horizon classifiers
- **Survival analytics:** hazard/survival curve
- **Explainable AI:** feature contributions and HR-language drivers
- **Anomaly detection:** sudden behavioural-change detection
- **Segmentation:** risk by site, department, employment type, recruitment source, position, project phase and tenure
- **Early attrition analytics:** first-30-day risk and recruitment-channel quality
- **Risk movement:** previous-vs-current score comparison
- **Retention interventions:** action logging, owners, due dates and outcomes
- **Copilot:** grounded question answering over the scored warehouse
- **Governance:** model registry, metrics, audit trail and monitoring hooks

The Copilot is a decision-support layer. It should not be treated as an autonomous employment decision-maker.

## Installation

### Requirements

- Python 3.10+
- Git
- Docker Desktop (optional)

### macOS / Linux

```bash
git clone https://github.com/<your-username>/retention-intelligence.git
cd retention-intelligence
./scripts/setup.sh
./scripts/run.sh
```

### Windows

```bat
git clone https://github.com/<your-username>/retention-intelligence.git
cd retention-intelligence
scripts\setup.bat
scripts\run.bat
```

### Manual setup

```bash
python -m venv .venv

# macOS/Linux
source .venv/bin/activate

# Windows PowerShell
.venv\Scripts\Activate.ps1

pip install -r requirements.txt
cp .env.example .env

# Windows CMD:
# copy .env.example .env

# macOS/Linux:
export PYTHONPATH=src

# Windows CMD:
# set PYTHONPATH=src

python -m attrition.cli pipeline
python -m attrition.cli serve
```

Open:

```text
http://127.0.0.1:8000
```

## Docker deployment

Build and start the application:

```bash
docker compose up --build
```

Or:

```bash
docker build -t retention-intelligence .
docker run --rm -p 8000:8000 retention-intelligence
```

The application is designed to run locally or behind an appropriately secured reverse proxy. Do not expose the development server directly to the public internet without authentication, TLS, secret management and infrastructure hardening.

## Demo authentication

The repository contains seeded demo accounts for local evaluation:

| Username | Password | Role |
|---|---|---|
| `admin` | `Admin@2026` | admin |
| `hr.manager` | `HrManager@2026` | hr_manager |
| `viewer` | `Viewer@2026` | viewer |

These are **demo credentials only**. Change or replace them before any shared deployment.

## API documentation

When the server is running:

- Swagger UI: `http://127.0.0.1:8000/api/docs`
- OpenAPI JSON: `http://127.0.0.1:8000/api/openapi.json`

### Main endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Create a session |
| POST | `/api/auth/logout` | End a session |
| GET | `/api/auth/me` | Current user/session |
| GET | `/api/overview` | Dashboard KPIs and trend data |
| GET | `/api/watchlist` | Ranked retention watchlist |
| GET | `/api/employees/{id}` | Employee risk/detail view |
| GET | `/api/early-attrition` | First-30-day analytics |
| GET | `/api/segments?by=Site` | Segmentation analysis |
| GET | `/api/anomalies` | Behavioural anomalies |
| GET | `/api/interventions` | Intervention history/effectiveness |
| POST | `/api/interventions` | Log an HR intervention |
| PATCH | `/api/interventions/{id}` | Update intervention outcome |
| GET | `/api/governance` | Model metrics/governance |
| GET | `/api/audit` | Admin audit log |
| POST | `/api/score/run` | Run scoring as an admin |
| POST | `/api/copilot/ask` | Ask a grounded analytics question |
| GET | `/api/export/watchlist.csv` | Export the current watchlist |
| GET | `/api/health` | Service health |

## Testing

Run the automated test suite:

```bash
PYTHONPATH=src pytest -q
```

Current repository validation:

```text
27 passed, 11 skipped
```

The suite covers feature leakage protections, model/survival utilities, API behaviour and core application logic. Skipped tests are environment/data dependent and should be enabled in CI when their required runtime dependencies are available.

## Security

This public repository follows a demo-safe posture:

- no real employee data
- no committed `.env`
- no API secrets
- `.gitignore` excludes local databases and generated artifacts
- session cookies are HTTP-only
- CSRF protection is used for state-changing HR actions
- role-based access controls separate admin, HR-manager and viewer capabilities
- audit events are recorded for sensitive actions
- employee-level data should remain private in any real deployment

Read **[SECURITY.md](SECURITY.md)** before deploying.

### Public repository checklist

Before pushing a fork publicly:

```text
[ ] No real HR data
[ ] No production database
[ ] No .env file
[ ] No API keys / tokens
[ ] No internal URLs or infrastructure credentials
[ ] No proprietary documents
[ ] Demo credentials clearly labelled
[ ] Synthetic dataset clearly labelled
[ ] Security review completed
```

## Future roadmap

### Phase 1 — Portfolio hardening

- GitHub Actions CI/CD
- dependency vulnerability scanning
- coverage reporting
- automated data-quality checks
- reproducible model artifact versioning

### Phase 2 — Production data platform

- PostgreSQL
- object storage for datasets/model artifacts
- scheduled ingestion
- data contracts and schema versioning
- observability and alerting

### Phase 3 — Enterprise ML

- MLflow model registry
- champion/challenger evaluation
- drift monitoring
- subgroup performance monitoring
- threshold optimization based on HR capacity

### Phase 4 — AI agent layer

- governed tool calling
- retrieval over approved HR policies
- human approval for consequential actions
- prompt/version management
- model routing between hosted and local models

### Phase 5 — Enterprise SaaS

- multi-tenancy
- SSO/SAML/OIDC
- granular RBAC
- tenant-level encryption controls
- audit retention policies
- cloud deployment

## Project structure

```text
retention-intelligence/
├── src/attrition/
│   ├── api/             # FastAPI application, auth and services
│   ├── copilot/         # grounded analytics assistant
│   ├── data/            # synthetic generator + warehouse ingestion
│   ├── features/        # leakage-safe feature engineering
│   ├── models/          # training, evaluation, survival, explainability
│   └── scoring/         # population scoring and historical backfill
├── frontend/            # dependency-light web UI
├── data/raw/            # synthetic demo data only
├── data/processed/      # local/generated database files
├── models/              # generated model artifacts
├── tests/               # automated tests
├── docs/                # portfolio documentation and screenshots
├── scripts/             # setup/run helpers
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── pyproject.toml
```

## Portfolio positioning

This project demonstrates a complete analytics-to-product workflow:

**Data engineering → feature engineering → ML → calibration → explainability → API → dashboard → security → testing → deployment.**

It is intentionally designed to be inspectable and reproducible rather than claiming production HR performance from synthetic data.

## License

Choose and add a license appropriate for your intended use before publishing. If you want others to freely reuse the code, MIT is a common option; if this is intended as a portfolio showcase with restricted reuse, use an appropriate proprietary/no-license approach instead.
