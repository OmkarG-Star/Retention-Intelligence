"""EPC workforce simulator.

Generates a weekly behavioural panel for a construction / EPC company and lets
people leave according to an explicit discrete-time hazard. Because the hazard
is written down here, the data has real causal structure: models trained on it
learn recoverable drivers instead of fitting noise, and the SHAP output can be
checked against `GROUND_TRUTH_DRIVERS` below.

Everything the simulator emits mirrors fields an Indian EPC contractor actually
keeps (attendance punches, overtime registers, site transfers, salary credit
dates, onboarding checklists, pulse surveys), so swapping in real data means
mapping columns, not rewriting the pipeline.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..config import paths, settings

# --------------------------------------------------------------------------------------
# Reference data
# --------------------------------------------------------------------------------------

SITES = [
    # name, type, remoteness 0-1, accommodation share, project phase cycle offset (weeks)
    ("Mumbai HO", "Corporate", 0.05, 0.02, 0),
    ("JNPA WOLP", "Port Infrastructure", 0.55, 0.65, 14),
    ("Mantralaya Redevelopment", "Government Building", 0.15, 0.20, 40),
    ("Pune Metro Reach-3", "Metro", 0.25, 0.35, 62),
    ("Nagpur Expressway Pkg-4", "Highway", 0.85, 0.80, 8),
    ("Bengaluru Tech Park", "Commercial", 0.20, 0.25, 30),
    ("Delhi NCR Logistics Hub", "Industrial", 0.45, 0.55, 52),
    ("Ahmedabad Water Works", "Water", 0.65, 0.60, 22),
]

DEPARTMENTS = [
    ("Civil Execution", 0.26),
    ("MEP", 0.12),
    ("Planning & Coordination", 0.08),
    ("Quality Assurance & Control", 0.07),
    ("EHS", 0.06),
    ("Stores & Logistics", 0.09),
    ("Procurement", 0.05),
    ("Accounts & Finance", 0.07),
    ("HR & Admin", 0.05),
    ("Design & Engineering", 0.08),
    ("Business Support Services", 0.07),
]

# position -> (grade 1..7, base monthly salary, criticality 1..5)
POSITIONS = {
    "Site Helper": (1, 16500, 1),
    "Junior Engineer": (2, 26000, 2),
    "Supervisor": (2, 29000, 2),
    "Site Engineer": (3, 41000, 3),
    "QA/QC Engineer": (3, 44000, 3),
    "Safety Officer": (3, 39000, 3),
    "Store Officer": (2, 28000, 2),
    "Accounts Officer": (3, 37000, 2),
    "Planning Engineer": (4, 58000, 4),
    "Senior Engineer": (4, 62000, 4),
    "Design Engineer": (4, 60000, 4),
    "Procurement Executive": (3, 45000, 3),
    "HR Executive": (3, 36000, 2),
    "Project Manager": (6, 128000, 5),
    "Construction Manager": (5, 96000, 5),
    "Deputy Manager": (5, 84000, 4),
}

DEPT_POSITIONS = {
    "Civil Execution": ["Site Helper", "Junior Engineer", "Supervisor", "Site Engineer",
                        "Senior Engineer", "Construction Manager", "Project Manager"],
    "MEP": ["Junior Engineer", "Site Engineer", "Senior Engineer", "Deputy Manager"],
    "Planning & Coordination": ["Planning Engineer", "Senior Engineer", "Deputy Manager"],
    "Quality Assurance & Control": ["QA/QC Engineer", "Junior Engineer", "Deputy Manager"],
    "EHS": ["Safety Officer", "Supervisor", "Deputy Manager"],
    "Stores & Logistics": ["Site Helper", "Store Officer", "Supervisor", "Deputy Manager"],
    "Procurement": ["Procurement Executive", "Deputy Manager"],
    "Accounts & Finance": ["Accounts Officer", "Deputy Manager"],
    "HR & Admin": ["HR Executive", "Deputy Manager"],
    "Design & Engineering": ["Design Engineer", "Senior Engineer", "Deputy Manager"],
    "Business Support Services": ["Accounts Officer", "HR Executive", "Procurement Executive"],
}

# source -> (share, early-exit propensity, screening quality)
SOURCES = {
    "Employee Referral": (0.18, -0.45, 0.35),
    "Naukri / Job Portal": (0.26, 0.05, 0.05),
    "Recruitment Consultancy": (0.17, 0.15, 0.0),
    "Labour Contractor": (0.14, 0.75, -0.35),
    "Walk-in / Site Gate": (0.11, 0.55, -0.25),
    "Campus Hiring": (0.08, -0.15, 0.15),
    "Internal Transfer": (0.06, -0.60, 0.40),
}

EMPLOYMENT_TYPES = {
    "Permanent": (0.58, -0.30),
    "Fixed Term Contract": (0.27, 0.35),
    "Retainer": (0.07, 0.20),
    "Apprentice / Trainee": (0.08, 0.15),
}

EXIT_REASONS_BY_TYPE = {
    "Resignation": ["Better Offer", "Career Growth", "Salary", "Personal / Family",
                    "Relocation", "Work Conditions", "Manager Relationship"],
    "Absconding": ["No Intimation", "Site Conditions", "Wage Dispute"],
    "Termination": ["Performance", "Disciplinary", "Attendance"],
    "End of Contract": ["Project Demobilisation", "Contract Not Renewed"],
}

# Ground-truth hazard weights (log-odds per unit of the standardised driver).
# Exposed so the SHAP output can be validated against what actually generated the data.
GROUND_TRUTH_DRIVERS = {
    "overtime_pressure": 0.52,
    "overtime_trend": 0.44,
    "absence_pressure": 0.46,
    "absence_trend": 0.38,
    "engagement_deficit": 0.58,
    "engagement_decline": 0.41,
    "onboarding_gap": 0.62,
    "pay_delay": 0.49,
    "pay_below_benchmark": 0.43,
    "promotion_stagnation": 0.28,
    "manager_churn": 0.31,
    "commute_burden": 0.26,
    "night_shift_load": 0.22,
    "grievance": 0.36,
    "demobilisation": 0.54,
    "source_risk": 0.40,
    "contract_risk": 0.33,
    "training_protective": -0.27,
    "referral_protective": -0.22,
    "tenure_baseline": "bathtub: peaks at week 2-4, dips at 6-18 months, rises again at appraisal cycles",
}


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------

def _pick(rng: np.random.Generator, options: list[str], weights: list[float]) -> str:
    w = np.asarray(weights, dtype=float)
    return str(rng.choice(options, p=w / w.sum()))


def _sigmoid(x: float | np.ndarray):
    return 1.0 / (1.0 + np.exp(-x))


def _baseline_hazard(week: int, employment_type: str) -> float:
    """Bathtub baseline on the log-odds scale: honeymoon cliff, settled middle,
    appraisal-cycle bumps at 12 and 24 months."""
    w = max(week, 0)
    early = 2.05 * np.exp(-((w - 2.0) ** 2) / 18.0)      # first-month cliff
    settle = -0.55 * np.exp(-((w - 30.0) ** 2) / 900.0)   # settled period
    appraisal = 0.65 * np.exp(-((w - 52) ** 2) / 26.0) + 0.5 * np.exp(-((w - 104) ** 2) / 30.0)
    drift = 0.0032 * w
    base = -6.15 + early + settle + appraisal + drift
    if employment_type == "Fixed Term Contract":
        base += 0.32 + 0.9 * np.exp(-((w - 48) ** 2) / 40.0)  # renewal points
    if employment_type == "Apprentice / Trainee":
        base += 0.18
    return float(base)


def _project_phase(week_index: int, offset: int) -> tuple[str, float]:
    """Projects cycle mobilisation -> peak execution -> demobilisation over ~110 weeks."""
    pos = (week_index + offset) % 110
    if pos < 18:
        return "Mobilisation", 0.25
    if pos < 78:
        return "Peak Execution", 0.0
    if pos < 96:
        return "Finishing", 0.35
    return "Demobilisation", 1.0


# --------------------------------------------------------------------------------------
# Simulator
# --------------------------------------------------------------------------------------

def simulate(n_employees: int | None = None, seed: int | None = None,
             start: str | None = None, end: str | None = None) -> dict[str, pd.DataFrame]:
    n_employees = n_employees or settings.sim_employees
    rng = np.random.default_rng(seed if seed is not None else settings.sim_seed)
    t0 = pd.Timestamp(start or settings.sim_start)
    cutoff = pd.Timestamp(end or settings.sim_end)
    total_weeks = int((cutoff - t0).days / 7)

    site_names = [s[0] for s in SITES]
    site_meta = {s[0]: s for s in SITES}
    dept_names = [d[0] for d in DEPARTMENTS]
    dept_w = [d[1] for d in DEPARTMENTS]

    # Site-level salary-credit delay shocks (cash-flow crunches hit a whole site at once).
    site_pay_delay = {}
    for name in site_names:
        series = np.zeros(total_weeks + 2)
        n_shocks = rng.integers(2, 6)
        for _ in range(n_shocks):
            s = rng.integers(0, max(total_weeks - 6, 1))
            length = rng.integers(3, 10)
            peak = rng.uniform(3, 14)
            for k in range(length):
                if s + k < len(series):
                    series[s + k] = max(series[s + k], peak * (1 - k / (length + 1)))
        site_pay_delay[name] = series

    managers = [f"MGR{str(i).zfill(3)}" for i in range(1, 121)]

    master_rows, weekly_rows, outcome_rows, event_rows = [], [], [], []

    for i in range(n_employees):
        emp = f"EMP{10001 + i}"

        # ---------------- static profile ----------------
        dept = _pick(rng, dept_names, dept_w)
        position = str(rng.choice(DEPT_POSITIONS[dept]))
        grade, base_pay, criticality = POSITIONS[position]
        site = str(rng.choice(site_names, p=_site_weights(dept)))
        _, site_type, remoteness, accom_share, phase_offset = site_meta[site]

        emp_type = _pick(rng, list(EMPLOYMENT_TYPES), [v[0] for v in EMPLOYMENT_TYPES.values()])
        if grade <= 2 and rng.random() < 0.45:
            emp_type = "Fixed Term Contract"
        source = _pick(rng, list(SOURCES), [v[0] for v in SOURCES.values()])
        if grade >= 5:
            source = _pick(rng, ["Employee Referral", "Recruitment Consultancy", "Naukri / Job Portal",
                                 "Internal Transfer"], [0.3, 0.35, 0.25, 0.10])
        if grade <= 1:
            source = _pick(rng, ["Labour Contractor", "Walk-in / Site Gate", "Employee Referral"],
                           [0.55, 0.3, 0.15])

        age = int(np.clip(rng.normal(22 + grade * 3.4, 6), 19, 59))
        prior_exp = float(np.clip(rng.gamma(1.6, 1.0) + (grade - 1) * 1.5, 0, 28).round(1))
        pay_noise = rng.normal(0, 0.14)
        salary = int(round(base_pay * (1 + pay_noise) * (1 + 0.012 * prior_exp) / 100) * 100)
        role_median = base_pay * (1 + 0.012 * prior_exp)
        salary_vs_benchmark = float(np.clip((salary - role_median) / role_median, -0.45, 0.55))
        distance_km = float(np.clip(rng.gamma(2.0, 6.0) * (1 + remoteness * 2.2), 1, 180).round(1))
        accommodation = bool(rng.random() < accom_share) if remoteness > 0.3 else False
        if accommodation:
            distance_km = float(np.clip(distance_km * 0.12, 0.5, 25).round(1))
        manager = str(rng.choice(managers))

        # joiners spread across the window, with a hiring peak before monsoon demobilisation
        if rng.random() < 0.34:
            join_week = 0  # legacy headcount already on rolls at window start
            doj = t0 - pd.Timedelta(days=int(rng.integers(30, 1500)))
        else:
            join_week = int(rng.integers(0, max(total_weeks - 4, 1)))
            doj = t0 + pd.Timedelta(weeks=join_week)
        tenure_weeks_at_start = max(int((t0 - doj).days / 7), 0) if join_week == 0 else 0

        # latent disposition: lower = more retention-prone
        src_share, src_early, src_quality = SOURCES[source]
        disposition = float(
            rng.normal(0, 1)
            + src_early * 0.8
            + EMPLOYMENT_TYPES[emp_type][1]
            + (0.35 if remoteness > 0.6 else 0.0)
            - 0.25 * min(prior_exp / 6, 1.0)
        )
        realistic_preview = bool(rng.random() < 0.5 + src_quality)   # did recruitment set expectations
        onboarding_quality = float(np.clip(rng.beta(4, 2) + src_quality * 0.3, 0.05, 1.0))

        master_rows.append(dict(
            EmployeeID=emp, DOJ=doj.date(), Department=dept, Position=position, Grade=grade,
            Site=site, SiteType=site_type, ManagerID=manager, EmploymentType=emp_type,
            RecruitmentSource=source, Age=age, PriorExperienceYears=prior_exp,
            MonthlySalary=salary, SalaryVsRoleBenchmark=round(salary_vs_benchmark, 4),
            DistanceFromSiteKm=distance_km, AccommodationProvided=int(accommodation),
            BusinessCriticality=criticality, RealisticJobPreview=int(realistic_preview),
            SiteRemoteness=remoteness,
        ))
        event_rows.append(dict(EmployeeID=emp, EventDate=doj.date(), EventType="Joined",
                               EventDetail=f"Joined as {position} at {site} via {source}"))

        # ---------------- weekly simulation ----------------
        disengagement = float(np.clip(rng.normal(0.15, 0.35) + disposition * 0.25, -1.5, 2.5))
        engagement = float(np.clip(rng.normal(7.4, 0.9) - disposition * 0.5, 1, 10))
        onboarding_pct = 100.0 if tenure_weeks_at_start > 10 else 0.0
        months_since_promo = float(rng.integers(0, 30)) if tenure_weeks_at_start > 60 else 0.0
        performance = float(np.clip(rng.normal(3.3, 0.55), 1, 5))
        manager_changes = 0
        trainings = 0
        grievances = 0
        exit_date, exit_type, exit_reason = None, None, None
        salary_hike_pct = 0.0

        start_week = max(join_week, 0)
        for w in range(start_week, total_weeks):
            tenure_weeks = tenure_weeks_at_start + (w - start_week)
            snap_date = t0 + pd.Timedelta(weeks=w)
            if snap_date < doj:
                continue
            phase, demob = _project_phase(w, phase_offset)
            pay_delay = float(site_pay_delay[site][w]) * (1.0 if grade <= 3 else 0.55)

            # onboarding ramps over the first ~8 weeks, gated by onboarding quality
            if tenure_weeks <= 10:
                onboarding_pct = float(np.clip(
                    onboarding_pct + rng.uniform(4, 22) * onboarding_quality, 0, 100))
            onboarding_gap = max(0.0, (100 - onboarding_pct) / 100) if tenure_weeks <= 12 else 0.0

            # workload: phase + role + noise, with an autocorrelated stress component
            ot_base = 6 + 16 * (1 - remoteness * 0.2) * (1.25 if phase == "Peak Execution" else 0.8)
            ot_base *= 1.25 if dept in ("Civil Execution", "MEP") else 0.85
            overtime = float(np.clip(rng.normal(ot_base, 5) + disengagement * 3.0 +
                                     (8 if phase == "Finishing" else 0), 0, 70))
            night_ratio = float(np.clip(rng.beta(1.5, 6) + (0.25 if phase == "Finishing" else 0), 0, 0.9))

            # behaviour responds to the latent state
            absent = int(np.clip(rng.poisson(max(0.12 + 0.42 * max(disengagement, 0), 0.02)), 0, 7))
            late = int(np.clip(rng.poisson(max(0.35 + 0.55 * max(disengagement, 0), 0.05)), 0, 12))
            engagement = float(np.clip(
                0.82 * engagement + 0.18 * (7.8 - 1.5 * disengagement) + rng.normal(0, 0.35), 1, 10))
            if rng.random() < 0.035:
                trainings += 1
                event_rows.append(dict(EmployeeID=emp, EventDate=snap_date.date(),
                                       EventType="Training", EventDetail="Training completed"))
                disengagement -= 0.16
            if rng.random() < 0.012:
                manager_changes += 1
                disengagement += 0.32
                event_rows.append(dict(EmployeeID=emp, EventDate=snap_date.date(),
                                       EventType="Manager Change", EventDetail="Reporting manager changed"))
            grievance_flag = int(rng.random() < 0.006 + 0.02 * max(disengagement, 0))
            grievances += grievance_flag
            if grievance_flag:
                event_rows.append(dict(EmployeeID=emp, EventDate=snap_date.date(),
                                       EventType="Grievance", EventDetail="Grievance raised with HR"))
            if tenure_weeks > 0 and tenure_weeks % 13 == 0:
                performance = float(np.clip(0.75 * performance + 0.25 * rng.normal(3.3 - disengagement * 0.45, 0.5), 1, 5))
            if tenure_weeks > 0 and tenure_weeks % 52 == 0:
                hike = float(np.clip(rng.normal(8.5 - disengagement * 1.5, 3.5), 0, 28))
                salary_hike_pct = hike
                salary = int(salary * (1 + hike / 100))
                salary_vs_benchmark = float(np.clip(salary_vs_benchmark + hike / 100 - 0.07, -0.5, 0.6))
                if rng.random() < 0.18 + 0.1 * (performance - 3):
                    months_since_promo = 0.0
                    disengagement -= 0.45
                    event_rows.append(dict(EmployeeID=emp, EventDate=snap_date.date(),
                                           EventType="Promotion", EventDetail="Promoted / re-graded"))
            months_since_promo += 0.23

            # latent disengagement update — the mechanism the model has to rediscover
            shock = (
                0.055 * max(overtime - 28, 0)
                + 0.085 * pay_delay
                + 0.30 * onboarding_gap
                + 0.22 * max(-salary_vs_benchmark, 0) * 3
                + 0.14 * demob
                + 0.010 * max(distance_km - 25, 0) / 5
                + 0.35 * night_ratio
                + 0.30 * grievance_flag
                + 0.004 * max(months_since_promo - 24, 0)
                - 0.05 * max(engagement - 7, 0)
                - (0.12 if realistic_preview else -0.10)
            )
            disengagement = float(np.clip(0.9 * disengagement + 0.1 * disposition + shock * 0.35
                                          + rng.normal(0, 0.18), -2.0, 4.0))

            # ---- discrete-time hazard ----
            g = GROUND_TRUTH_DRIVERS
            logit = _baseline_hazard(tenure_weeks, emp_type)
            logit += g["overtime_pressure"] * max(overtime - 30, 0) / 12
            logit += g["absence_pressure"] * absent / 2.0
            logit += g["engagement_deficit"] * max(6.5 - engagement, 0) / 2.0
            logit += g["onboarding_gap"] * onboarding_gap * 1.6
            logit += g["pay_delay"] * pay_delay / 8.0
            logit += g["pay_below_benchmark"] * max(-salary_vs_benchmark, 0) * 2.4
            logit += g["promotion_stagnation"] * max(months_since_promo - 26, 0) / 14
            logit += g["manager_churn"] * min(manager_changes, 3) * 0.45
            logit += g["commute_burden"] * min(distance_km / 60, 1.6)
            logit += g["night_shift_load"] * night_ratio * 1.6
            logit += g["grievance"] * grievance_flag * 1.4
            logit += g["demobilisation"] * demob * (1.4 if emp_type == "Fixed Term Contract" else 0.7)
            logit += g["source_risk"] * SOURCES[source][1] * 1.3
            logit += g["contract_risk"] * EMPLOYMENT_TYPES[emp_type][1] * 1.4
            logit += g["training_protective"] * min(trainings, 5) * 0.35
            logit += g["referral_protective"] * (1.0 if source in ("Employee Referral", "Internal Transfer") else 0.0)
            logit += 0.42 * disengagement
            logit += -0.16 * min(prior_exp, 10) / 5
            hazard = float(_sigmoid(logit))

            weekly_rows.append(dict(
                EmployeeID=emp, SnapshotDate=snap_date.date(), TenureDays=tenure_weeks * 7,
                TenureMonths=round(tenure_weeks / 4.345, 2),
                OvertimeHours7D=round(overtime, 2), AbsenceDays7D=absent, LateCount7D=late,
                NightShiftRatio=round(night_ratio, 3),
                OnboardingCompletionPct=round(onboarding_pct, 1),
                EngagementScore=round(engagement, 2), PerformanceRating=round(performance, 2),
                TrainingCountToDate=trainings, MonthsSincePromotion=round(months_since_promo, 2),
                ManagerChangesToDate=manager_changes, GrievanceFlag=grievance_flag,
                GrievancesToDate=grievances,
                SalaryCreditDelayDays=round(pay_delay, 2), MonthlySalary=salary,
                SalaryVsRoleBenchmark=round(salary_vs_benchmark, 4),
                LastHikePct=round(salary_hike_pct, 2),
                ProjectPhase=phase, DemobilisationPressure=round(demob, 2),
                HeadcountAtSite=0,  # filled after the loop
            ))

            if rng.random() < hazard:
                # notice period: seniors serve it, helpers and contract staff often do not
                notice_days = int(np.clip(rng.normal(20 + grade * 6, 10), 0, 90))
                if tenure_weeks < 8 or emp_type == "Fixed Term Contract":
                    notice_days = int(rng.integers(0, 10))
                exit_dt = snap_date + pd.Timedelta(days=notice_days)
                if exit_dt > cutoff:
                    break
                if phase == "Demobilisation" and emp_type == "Fixed Term Contract" and rng.random() < 0.6:
                    exit_type = "End of Contract"
                elif tenure_weeks <= 6 and rng.random() < 0.45:
                    exit_type = "Absconding"
                elif performance < 2.5 and rng.random() < 0.25:
                    exit_type = "Termination"
                else:
                    exit_type = "Resignation"
                exit_reason = str(rng.choice(EXIT_REASONS_BY_TYPE[exit_type]))
                exit_date = exit_dt
                if notice_days > 3 and exit_type == "Resignation":
                    event_rows.append(dict(EmployeeID=emp, EventDate=snap_date.date(),
                                           EventType="Resignation Submitted",
                                           EventDetail=f"{notice_days}-day notice, reason: {exit_reason}"))
                event_rows.append(dict(EmployeeID=emp, EventDate=exit_dt.date(), EventType="Exit",
                                       EventDetail=f"{exit_type} - {exit_reason}"))
                outcome_rows.append(dict(EmployeeID=emp, ExitDate=exit_dt.date(), ExitType=exit_type,
                                         ExitReason=exit_reason,
                                         TenureDaysAtExit=int((exit_dt - doj).days)))
                break

    master = pd.DataFrame(master_rows)
    weekly = pd.DataFrame(weekly_rows)
    outcomes = pd.DataFrame(outcome_rows)
    events = pd.DataFrame(event_rows)

    # site headcount per week — a real dashboard signal (thin crews raise load on those left)
    weekly = weekly.merge(master[["EmployeeID", "Site"]], on="EmployeeID", how="left")
    site_hc = weekly.groupby(["Site", "SnapshotDate"]).size().rename("HeadcountAtSite").reset_index()
    weekly = weekly.drop(columns=["HeadcountAtSite"]).merge(site_hc, on=["Site", "SnapshotDate"], how="left")
    weekly = weekly.drop(columns=["Site"])

    for df, col in ((weekly, "SnapshotDate"), (outcomes, "ExitDate"), (events, "EventDate")):
        if not df.empty:
            df[col] = pd.to_datetime(df[col])
    master["DOJ"] = pd.to_datetime(master["DOJ"])
    weekly = weekly.sort_values(["EmployeeID", "SnapshotDate"]).reset_index(drop=True)
    events = events.sort_values(["EmployeeID", "EventDate"]).reset_index(drop=True)

    return {"employee_master": master, "employee_weekly": weekly,
            "attrition_outcomes": outcomes, "employee_events": events,
            "data_dictionary": data_dictionary()}


def _site_weights(dept: str) -> np.ndarray:
    """Corporate functions skew to the head office; execution skews to project sites."""
    corporate = dept in ("Accounts & Finance", "HR & Admin", "Procurement",
                         "Business Support Services", "Design & Engineering")
    w = np.array([0.30 if corporate else 0.05] + [0.10] * 7, dtype=float)
    if not corporate:
        w[1:] = np.array([0.18, 0.12, 0.14, 0.16, 0.13, 0.12, 0.10])
    return w / w.sum()


def data_dictionary() -> pd.DataFrame:
    rows = [
        ("EmployeeID", "employee_master", "Unique employee key", "Join key across all tables"),
        ("DOJ", "employee_master", "Date of joining", "Tenure and day-0 features"),
        ("Grade", "employee_master", "Internal grade 1-7", "Seniority, criticality weighting"),
        ("RecruitmentSource", "employee_master", "Channel the hire came through", "Early-exit driver, funnel quality"),
        ("BusinessCriticality", "employee_master", "1-5 impact if the role goes vacant", "Retention priority = risk x criticality"),
        ("DistanceFromSiteKm", "employee_master", "Home to site distance", "Commute burden driver"),
        ("AccommodationProvided", "employee_master", "Company accommodation at site", "Offsets commute burden"),
        ("SnapshotDate", "employee_weekly", "Week-ending observation date", "Panel time index, as-of scoring"),
        ("OvertimeHours7D", "employee_weekly", "Overtime hours in the week", "Workload pressure, trend features"),
        ("AbsenceDays7D", "employee_weekly", "Absent days in the week", "Withdrawal behaviour"),
        ("LateCount7D", "employee_weekly", "Late punches in the week", "Early disengagement signal"),
        ("NightShiftRatio", "employee_weekly", "Share of night shifts", "Fatigue driver"),
        ("OnboardingCompletionPct", "employee_weekly", "Onboarding checklist completion", "Strongest first-30-day driver"),
        ("EngagementScore", "employee_weekly", "Pulse survey 1-10", "Sentiment level and decline"),
        ("PerformanceRating", "employee_weekly", "Rolling appraisal rating 1-5", "Performance trend"),
        ("SalaryCreditDelayDays", "employee_weekly", "Days salary credited late", "Site-level cash-flow shock driver"),
        ("SalaryVsRoleBenchmark", "employee_weekly", "Pay gap vs role median", "Equity driver"),
        ("MonthsSincePromotion", "employee_weekly", "Months since last movement", "Stagnation driver"),
        ("ManagerChangesToDate", "employee_weekly", "Cumulative manager changes", "Supervisory churn driver"),
        ("GrievanceFlag", "employee_weekly", "Grievance raised that week", "Acute dissatisfaction event"),
        ("ProjectPhase", "employee_weekly", "Mobilisation/Peak/Finishing/Demobilisation", "Project lifecycle risk"),
        ("DemobilisationPressure", "employee_weekly", "0-1 closeout intensity", "Contract-staff exit driver"),
        ("HeadcountAtSite", "employee_weekly", "Active headcount at the site that week", "Crew thinning context"),
        ("ExitDate", "attrition_outcomes", "Last working day", "Label construction"),
        ("ExitType", "attrition_outcomes", "Resignation/Absconding/Termination/End of Contract", "Outcome segmentation"),
        ("TenureDaysAtExit", "attrition_outcomes", "Tenure at exit", "Early-attrition cohorts"),
        ("EventType", "employee_events", "Joined/Onboarding/Training/Promotion/Grievance/Exit", "Timeline and audit trail"),
    ]
    return pd.DataFrame(rows, columns=["Column", "Table", "Meaning", "Use"])


def write_dataset(tables: dict[str, pd.DataFrame], compress: bool = True) -> list[str]:
    paths.data_raw.mkdir(parents=True, exist_ok=True)
    written = []
    for name, df in tables.items():
        suffix = ".csv.gz" if compress and name == "employee_weekly" else ".csv"
        out = paths.data_raw / f"{name}{suffix}"
        df.to_csv(out, index=False, compression="gzip" if out.suffix == ".gz" else None)
        written.append(str(out))
    return written


def main() -> None:
    tables = simulate()
    written = write_dataset(tables)
    print("Generated dataset:")
    for name, df in tables.items():
        print(f"  {name:22s} {len(df):>8,} rows  x {df.shape[1]:>2} cols")
    exits = len(tables["attrition_outcomes"])
    n = len(tables["employee_master"])
    early = (tables["attrition_outcomes"]["TenureDaysAtExit"] <= 30).sum() if exits else 0
    print(f"\nExits: {exits:,} of {n:,} employees ({exits / n:.1%}); "
          f"{early:,} within 30 days ({(early / exits if exits else 0):.1%} of exits)")
    for w in written:
        print(f"  wrote {w}")


if __name__ == "__main__":
    main()
