# Retention-Intelligence
I built an end-to-end ML decision-support system that transforms workforce data into explainable attrition-risk intelligence through a production-style data pipeline, machine-learning layer, API, dashboard, testing, and Docker deployment.

# Retention Intelligence

### AI-Powered Employee Attrition Early-Warning Platform






> A production-style workforce analytics and machine-learning platform designed to identify employee attrition risk, explain the drivers behind predictions, detect workforce anomalies, and provide decision-support insights through an API and analytics interface.

---

## Overview

**Retention Intelligence** is an end-to-end AI/ML workforce analytics platform that transforms employee, event, and workforce-history data into actionable retention intelligence.

The system is designed around a simple principle:

```text
Data
  ↓
Validation
  ↓
Feature Engineering
  ↓
Machine Learning
  ↓
Risk Prediction
  ↓
Explainability
  ↓
Analytics
  ↓
Decision Support
```

Instead of treating attrition prediction as a single classification problem, the platform combines:

* Multi-horizon attrition prediction
* Feature engineering
* Probability scoring
* Model evaluation
* Explainable AI
* Survival analysis
* Workforce anomaly detection
* Analytics APIs
* AI-assisted workforce insights
* Dashboard visualization
* Automated testing
* Docker deployment

The repository is designed as a **portfolio-grade demonstration of modern Data Science, Machine Learning, Analytics Engineering, API development, and MLOps practices**.

---

# 1. Problem Statement

Employee attrition creates operational and financial challenges for organizations.

Traditional HR reporting often answers:

> "How many employees left?"

A predictive workforce analytics system should go further:

> "Which workforce patterns are associated with higher attrition risk, how soon might risk materialize, what factors contribute to the prediction, and what should HR investigate?"

Retention Intelligence addresses this problem by creating a predictive intelligence layer over workforce data.

### Key questions

The platform is designed to help answer:

* Which employees or workforce segments show elevated attrition risk?
* What factors are contributing to the predicted risk?
* How does risk vary across time horizons?
* Which organizational patterns require investigation?
* Are there unusual workforce behavior patterns?
* How reliable are the model probabilities?
* What retention-related insights can be surfaced from the data?

---

# 2. Business Impact

The platform can support HR and business teams in several areas.

### Workforce Planning

Identify changing workforce-risk patterns before they become visible in traditional reporting.

### Retention Analysis

Understand factors associated with employee exits and identify segments requiring deeper investigation.

### Manager Support

Provide explainable risk drivers instead of presenting an unexplained prediction score.

### HR Analytics

Combine descriptive, predictive, and diagnostic analytics in one workflow.

### Workforce Monitoring

Detect unusual changes in workforce behavior through anomaly detection.

### Decision Support

Provide analytical evidence that HR professionals can use when deciding where to investigate or allocate retention resources.

> **Important:** The system is designed as decision support. Predictions should not be used as the sole basis for employment decisions such as termination, compensation, promotion, hiring, or disciplinary action.

---

# 3. Key Features

## Predictive Analytics

* Multi-horizon attrition prediction
* Probability-based risk scoring
* Classification modeling
* Chronological evaluation
* Calibration analysis
* Model registry

## Explainable AI

* Feature contribution analysis
* SHAP-based explanations
* Individual prediction explanations
* Global model interpretability

## Workforce Intelligence

* Workforce trend analysis
* Attrition cohort analysis
* Employee-level scoring
* Segment-level analysis
* Workforce anomaly detection

## Survival Analysis

The project includes survival-analysis functionality for estimating time-to-event behavior rather than treating attrition purely as a binary classification problem.

## AI Copilot

The platform includes an AI-assisted workforce analytics component designed to transform analytical outputs into understandable business-oriented insights.

## API

The backend provides a FastAPI-based service for:

* Health checks
* Scoring
* Analytics
* Workforce intelligence
* Model-related functionality
* Security controls

## Dashboard

The frontend provides an analytics interface for exploring:

* Workforce overview
* Attrition intelligence
* Risk indicators
* Governance information
* Analytical insights

---

# 4. System Architecture

```text
                    ┌─────────────────────┐
                    │   Workforce Data    │
                    │ Employee / Events   │
                    │ Weekly / Outcomes   │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Data Validation &   │
                    │ Data Preparation    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Feature Engineering │
                    │ Temporal Features   │
                    │ Behavioral Features│
                    └──────────┬──────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
        ┌────────────┐ ┌────────────┐ ┌────────────┐
        │ Attrition  │ │  Survival  │ │ Anomaly    │
        │ Prediction │ │  Analysis  │ │ Detection  │
        └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
              │              │              │
              └──────────────┼──────────────┘
                             ▼
                    ┌─────────────────────┐
                    │ Explainable AI      │
                    │ SHAP / Drivers      │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Intelligence Layer  │
                    │ Analytics + Copilot │
                    └──────────┬──────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
        ┌────────────────┐            ┌────────────────┐
        │ FastAPI        │            │ Web Dashboard  │
        │ REST API       │            │ Analytics UI   │
        └────────────────┘            └────────────────┘
```

Architecture diagram:

---

# 5. Data Pipeline

The project uses multiple workforce datasets to simulate an enterprise analytics environment.

```text
employee_master
       │
       ├──────────────┐
       │              │
       ▼              ▼
employee_events   employee_weekly
       │              │
       └──────┬───────┘
              ▼
       Attrition Outcomes
              │
              ▼
      Data Transformation
              │
              ▼
      Feature Engineering
              │
              ▼
      Training Dataset
              │
              ▼
        ML Model Layer
```

### Main data sources

```text
data/raw/
├── employee_master.csv
├── employee_events.csv
├── employee_weekly.csv.gz
├── attrition_outcomes.csv
└── data_dictionary.csv
```

The included data is **synthetic/demo data created for development and portfolio demonstration**.

It does not represent real employee records.

---

# 6. Feature Engineering

The feature engineering layer is implemented under:

```text
src/attrition/features/
```

The system is designed to create predictive features from historical workforce information while respecting temporal boundaries.

Examples of analytical feature categories include:

* Workforce tenure
* Historical activity
* Employee events
* Workforce changes
* Historical behavior
* Temporal trends
* Employee-level aggregates
* Cohort information
* Previous workforce states

A major design goal is preventing **data leakage**.

Features used for prediction should represent information that would realistically have been available at the prediction timestamp.

---

# 7. Machine Learning Methodology

The project treats attrition prediction as a time-aware machine-learning problem.

### Prediction horizons

The platform supports multiple prediction horizons, including:

```text
7 days
15 days
30 days
90 days
180 days
```

This allows the system to distinguish between short-term and longer-term risk.

### Modeling workflow

```text
Historical Data
      ↓
Temporal Split
      ↓
Feature Engineering
      ↓
Model Training
      ↓
Validation
      ↓
Probability Calibration
      ↓
Evaluation
      ↓
Model Registry
      ↓
Production Scoring
```

### Important ML practices

The project includes:

* Chronological evaluation
* Leakage-aware feature generation
* Probability scoring
* Calibration
* Multiple evaluation metrics
* Model registry
* Explainability
* Survival modeling
* Anomaly detection

---

# 8. Model Evaluation

The evaluation framework is designed to avoid relying on accuracy alone.

Relevant metrics can include:

* ROC-AUC
* PR-AUC
* Precision
* Recall
* F1-score
* Brier score
* Calibration
* Confusion matrix
* Threshold analysis

For an attrition-risk system, probability quality is particularly important.

A model that produces a risk score of `0.80` should ideally represent a meaningfully higher observed event probability than a score of `0.20`.

---

# 9. Synthetic Benchmark Results

The repository may include benchmark results generated from synthetic data.

These results are **demonstration benchmarks only**.

They should not be interpreted as evidence of performance on real organizational HR data.

For a real deployment, the model should be evaluated using:

1. Historical organizational data
2. Proper temporal validation
3. Holdout periods
4. Calibration analysis
5. Fairness analysis
6. Drift monitoring
7. Business-impact evaluation

---

# 10. Explainable AI

Predictive systems should not simply produce:

```text
Attrition Risk = 82%
```

The platform is designed to provide additional context.

Example:

```text
Predicted Risk
      ↓
Important Drivers
      ↓
Feature Contributions
      ↓
Human Interpretation
```

The project contains explainability functionality under:

```text
src/attrition/models/explain.py
```

SHAP-based explanations can be used to understand how model features contribute to predictions.

This improves transparency and makes model outputs more useful for analytical investigation.

---

# 11. Survival Analysis

Traditional classification answers:

> "Will the employee leave within a defined period?"

Survival analysis addresses a different question:

> "How does the probability of remaining employed change over time?"

The project contains survival-analysis functionality under:

```text
src/attrition/models/survival.py
```

This enables the platform to explore time-to-event behavior and complements the classification-based prediction system.

---

# 12. Anomaly Detection

Attrition prediction and anomaly detection solve different problems.

### Attrition prediction

Attempts to estimate future attrition risk.

### Anomaly detection

Attempts to identify unusual workforce behavior.

The anomaly detection module can help surface patterns that deserve investigation even when they are not directly classified as attrition events.

Implementation:

```text
src/attrition/models/anomaly.py
```

---

# 13. AI Analytics Copilot

The project includes an analytics copilot:

```text
src/attrition/copilot/
```

The purpose is to help convert analytical outputs into human-readable insights.

Potential workflow:

```text
User Question
      ↓
Analytics Context
      ↓
Relevant Metrics
      ↓
AI Interpretation
      ↓
Business-Friendly Response
```

Example questions:

```text
Which workforce segments have the highest attrition risk?

What are the strongest risk drivers?

How has attrition changed over time?

Which groups should HR investigate?

Are there unusual workforce patterns?
```

The AI layer should remain a **decision-support system**, not an autonomous employment decision-maker.

---

# 14. Dashboard

The project includes a web-based analytics interface.

### Overview

### Governance

The dashboard is intended to provide a unified view of workforce intelligence rather than forcing users to interpret raw model outputs.

---

# 15. API

The backend is built using **FastAPI**.

Main API implementation:

```text
src/attrition/api/
```

The application can expose interactive API documentation through:

```text
/docs
```

and OpenAPI schema through:

```text
/openapi.json
```

After starting the application locally:

```text
http://localhost:8000/docs
```

can be used to inspect available endpoints.

---

# 16. Project Structure

```text
retention-intelligence/
│
├── src/
│   └── attrition/
│       ├── api/
│       │   ├── main.py
│       │   ├── security.py
│       │   └── service.py
│       │
│       ├── copilot/
│       │   └── assistant.py
│       │
│       ├── data/
│       │   ├── generate.py
│       │   └── warehouse.py
│       │
│       ├── features/
│       │   └── build.py
│       │
│       ├── models/
│       │   ├── anomaly.py
│       │   ├── evaluate.py
│       │   ├── explain.py
│       │   ├── horizon.py
│       │   ├── registry.py
│       │   ├── survival.py
│       │   └── train.py
│       │
│       ├── scoring/
│       │   └── score.py
│       │
│       ├── cli.py
│       └── config.py
│
├── frontend/
│   ├── index.html
│   └── assets/
│
├── data/
│   └── raw/
│
├── docs/
│   ├── architecture/
│   ├── screenshots/
│   └── retention-intelligence-data-sheet.xlsx
│
├── tests/
│   ├── conftest.py
│   ├── test_api.py
│   ├── test_features.py
│   └── test_models.py
│
├── scripts/
│   ├── setup.bat
│   ├── setup.sh
│   ├── run.bat
│   └── run.sh
│
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── pyproject.toml
├── requirements.txt
├── .env.example
├── SECURITY.md
└── README.md
```

---

# 17. Installation

## Requirements

Recommended environment:

```text
Python 3.11+
Git
Docker Desktop
```

Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/retention-intelligence.git
cd retention-intelligence
```

Create a virtual environment:

### Windows

```bash
python -m venv .venv
.venv\Scripts\activate
```

### Linux / macOS

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Create environment configuration:

```bash
copy .env.example .env
```

Linux/macOS:

```bash
cp .env.example .env
```

Review `.env` before running the application.

---

# 18. Run Locally

Start the API/application using the provided scripts or project commands.

Example:

```bash
python -m src.attrition.cli
```

Depending on the configured application entry point, the API can then be accessed at:

```text
http://localhost:8000
```

Interactive API documentation:

```text
http://localhost:8000/docs
```

---

# 19. Docker Deployment

Build and start the application:

```bash
docker compose up --build
```

Run in detached mode:

```bash
docker compose up -d --build
```

Stop the services:

```bash
docker compose down
```

View logs:

```bash
docker compose logs -f
```

The Docker configuration provides a reproducible environment for running the project without manually installing every dependency.

---

# 20. Testing

The project includes automated tests covering:

* API behavior
* Feature engineering
* Model functionality
* Application configuration
* Core analytical workflows

Run:

```bash
pytest
```

Current project validation:

```text
27 tests passed
11 tests skipped
```

The skipped tests are environment/configuration-dependent and should be reviewed before production deployment.

---

# 21. Data Security

This repository is designed for public portfolio demonstration.

### Public repository rules

Never commit:

```text
.env
API keys
Passwords
Database credentials
Production databases
Real employee records
Confidential company documents
Private certificates
Access tokens
Cloud credentials
```

Use:

```text
.env.example
```

for configuration templates.

The included workforce data is **synthetic/demo data**.

See:

```text
SECURITY.md
```

for additional security guidance.

---

# 22. Responsible AI

Workforce AI requires additional caution because predictions can affect people.

This project is designed as an **analytics and decision-support platform**.

It should not be used to automatically:

* terminate employees
* reject candidates
* reduce compensation
* deny promotions
* issue disciplinary actions
* make other consequential employment decisions

A production implementation should include:

* Human review
* Audit logging
* Access controls
* Data minimization
* Fairness testing
* Model monitoring
* Drift detection
* Explainability
* Governance policies
* Appropriate legal/compliance review

---

# 23. Security Architecture

The project includes application security functionality under:

```text
src/attrition/api/security.py
```

Security considerations include:

* Environment-based secrets
* API security
* Request validation
* Authentication/authorization considerations
* Separation of configuration from code
* Secure deployment practices

For a production enterprise deployment, the architecture should additionally integrate with an enterprise identity provider such as OAuth2/OIDC, enforce RBAC, implement centralized audit logging, and use managed secret storage.

---

# 24. Data Governance

A production workforce analytics implementation should establish:

### Data Classification

Identify sensitive employee information before ingestion.

### Access Control

Only authorized users should access workforce-level or employee-level information.

### Retention

Define how long workforce data and prediction history should be stored.

### Auditability

Record important analytical and administrative actions.

### Model Governance

Maintain:

* Model version
* Training dataset version
* Feature version
* Evaluation results
* Deployment date
* Model owner
* Approval status

---

# 25. MLOps Roadmap

The current project provides a production-style foundation.

Potential next-stage MLOps capabilities include:

```text
Data
 ↓
Feature Store
 ↓
Experiment Tracking
 ↓
Model Registry
 ↓
CI/CD
 ↓
Automated Validation
 ↓
Model Deployment
 ↓
Monitoring
 ↓
Drift Detection
 ↓
Retraining
```

Potential technologies:

* MLflow
* GitHub Actions
* Docker
* Kubernetes
* Cloud object storage
* Feature stores
* Model monitoring
* Data-quality monitoring

---

# 26. Future Roadmap

## Phase 1 — Foundation

* [x] Synthetic workforce dataset
* [x] Data pipeline
* [x] Feature engineering
* [x] ML models
* [x] API
* [x] Dashboard
* [x] Testing
* [x] Docker support
* [x] Explainability
* [x] Survival analysis
* [x] Anomaly detection

## Phase 2 — Advanced ML

* [ ] Automated hyperparameter optimization
* [ ] Advanced calibration
* [ ] Model comparison framework
* [ ] Feature drift detection
* [ ] Prediction monitoring
* [ ] Automated retraining

## Phase 3 — MLOps

* [ ] MLflow experiment tracking
* [ ] Model registry integration
* [ ] CI/CD pipeline
* [ ] Automated model validation
* [ ] Model monitoring
* [ ] Data-quality monitoring

## Phase 4 — Enterprise Analytics

* [ ] Role-based access control
* [ ] Enterprise authentication
* [ ] Multi-tenant architecture
* [ ] Audit logging
* [ ] Advanced governance
* [ ] Cloud deployment

## Phase 5 — AI Workforce Copilot

* [ ] Natural-language analytics
* [ ] Retrieval-augmented generation
* [ ] Automated report generation
* [ ] Conversational workforce analytics
* [ ] Human approval workflows
* [ ] Enterprise AI governance

---

# 27. Technology Stack

### Programming

* Python
* JavaScript
* HTML
* CSS

### Data & Analytics

* Pandas
* NumPy
* Statistical analysis
* Feature engineering

### Machine Learning

* Scikit-learn
* SHAP
* Survival analysis
* Anomaly detection

### Backend

* FastAPI
* Pydantic
* REST APIs
* OpenAPI

### Frontend

* HTML
* CSS
* JavaScript
* Analytics visualizations

### DevOps

* Docker
* Docker Compose
* Git
* GitHub

### Testing

* Pytest

---

# 28. Why This Project Matters

Retention Intelligence demonstrates how an analytics project can move beyond a static dashboard.

```text
Traditional Analytics

Data → Dashboard → Human Interpretation
```

This project extends that architecture:

```text
Data
 ↓
Analytics
 ↓
Machine Learning
 ↓
Prediction
 ↓
Explainability
 ↓
Anomaly Detection
 ↓
AI Assistance
 ↓
API
 ↓
Dashboard
 ↓
Human Decision Support
```

The result is a portfolio project demonstrating multiple layers of modern data and AI engineering.

---

# 29. Skills Demonstrated

This project demonstrates practical experience with:

### Data Analytics

* Data cleaning
* Exploratory analysis
* Feature engineering
* Workforce analytics
* KPI analysis
* Trend analysis

### Data Science

* Classification
* Time-aware modeling
* Probability calibration
* Model evaluation
* Survival analysis
* Anomaly detection

### Machine Learning

* Predictive modeling
* Explainable AI
* Model registry concepts
* Multi-horizon prediction
* Leakage prevention

### Software Engineering

* Modular Python architecture
* REST APIs
* Configuration management
* Testing
* Documentation

### Deployment

* Docker
* Docker Compose
* Environment configuration
* API deployment

### AI Engineering

* AI-assisted analytics
* Analytics copilot architecture
* Explainable predictions
* Human-in-the-loop decision support

---

# 30. Portfolio Positioning

This project can demonstrate capability across several roles:

| Role               | Demonstrated Capability                      |
| ------------------ | -------------------------------------------- |
| Data Analyst       | Analytics, KPIs, workforce insights          |
| Data Scientist     | ML modeling, evaluation, feature engineering |
| ML Engineer        | Model serving, scoring, APIs                 |
| AI Engineer        | AI copilot and explainability                |
| Analytics Engineer | Data pipeline and transformation             |
| MLOps Engineer     | Docker, testing, model lifecycle foundation  |

The strongest portfolio story is the **end-to-end integration** rather than any individual model.

---

# 31. Limitations

This repository is a portfolio and engineering demonstration.

It is **not a validated production HR decision system**.

Important limitations include:

* Synthetic data
* Limited real-world organizational variation
* No claim of production predictive performance
* No guarantee of fairness
* No guarantee that model relationships are causal
* No automatic employment decisioning
* Production identity/security infrastructure requires additional implementation

Real deployment requires organization-specific validation and governance.

---

# 32. License

This project is intended as a portfolio and educational demonstration.

If you publish the repository under an open-source license, add the selected license file and update this section accordingly.

Recommended starting point for a personal portfolio project:

```text
MIT License
```

---

# 33. Author

**Omkar Gadhave**
(Data Analyst) 

Data Analytics | Data Science | Machine Learning | AI Engineering

### Areas of interest

* Data Analytics
* Data Science
* Machine Learning
* Generative AI
* Agentic AI
* Data Engineering
* MLOps
* Business Intelligence

---

# 34. Disclaimer

This project uses synthetic/demo workforce data.

No real employee or confidential organizational information is intentionally included.

The predictions and analytics produced by this project are intended for research, education, portfolio demonstration, and decision-support experimentation.

They should not be treated as definitive assessments of individual employees or used as the sole basis for employment decisions.

---

## ⭐ If you find this project useful

Consider giving the repository a ⭐ on GitHub and exploring the architecture, ML pipeline, API, and analytics implementation.

Mail Id - omkarg3737@gmail.com
Linkeden - https://www.linkedin.com/in/omkar-gadhave-data/
