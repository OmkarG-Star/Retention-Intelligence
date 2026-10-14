"""What-if simulator.

Answers the question a manager actually asks: "if we cut his overtime to 30
hours and fix the salary delay, how much does his risk come down?"

A lever is not applied by editing one model input. Overtime alone feeds about
fifteen features (this week's level, 4/8/13-week means, the 13-week maximum,
the 8-week trend, the excess over 30 hours...), and changing one of them while
leaving the rest says "overtime is 30 this week but averaged 48 for a quarter",
which no real person looks like. Instead the person's own weekly history is
extended `weeks` weeks into the future and every feature is rebuilt by the same
code that built the training data:

    history (real weeks) ─┬─ + 8 future weeks, unchanged ─► features ─► "if nothing changes"
                          └─ + 8 future weeks, levers on ─► features ─► "with your changes"

Both projections age the person by the same 8 weeks, so the difference between
them is the effect of the levers alone, not of tenure moving on. Everything not
touched by a lever is held at its latest weekly value.

The result is what the model expects, not a causal promise. On the demo data
the model's directions were checked against the simulator's planted causes
(docs/MODEL_STUDY.md, section 7.2); on real data the same caveat as any
observational model applies.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..data import warehouse
from ..features.build import build_features
from ..models import explain
from ..models.horizon import monotone_horizons


@dataclass(frozen=True)
class Lever:
    key: str
    label: str
    hint: str
    unit: str
    lo: float
    hi: float
    step: float
    kind: str = "level"        # level | raise | promote | training | toggle
    column: str | None = None
    better: str = "down"       # which way usually lowers risk, for the UI only


LEVERS: tuple[Lever, ...] = (
    Lever("overtime", "Overtime", "Hours of overtime per week", "h/week", 0, 60, 1,
          column="OvertimeHours7D"),
    Lever("night_shift", "Night shifts", "Share of shifts worked at night", "%", 0, 90, 5,
          column="NightShiftRatio"),
    Lever("pay_delay", "Salary delay", "Days the salary credit is late", "days", 0, 15, 1,
          column="SalaryCreditDelayDays"),
    Lever("absence", "Absence", "Days absent per week", "days/week", 0, 5, 0.5,
          column="AbsenceDays7D"),
    Lever("engagement", "Engagement", "Weekly pulse score, if it recovers to", "/10", 1, 10, 0.5,
          column="EngagementScore", better="up"),
    Lever("raise", "Pay raise", "Raise on current monthly salary", "%", 0, 30, 1,
          kind="raise", better="up"),
    Lever("promote", "Promotion", "Promote now (resets time since last promotion)", "", 0, 1, 1,
          kind="promote", better="up"),
    Lever("training", "Training", "Extra trainings completed", "courses", 0, 5, 1,
          kind="training", better="up"),
    Lever("accommodation", "Site accommodation", "Provide accommodation near site", "", 0, 1, 1,
          kind="toggle", column="AccommodationProvided", better="up"),
)
LEVER_BY_KEY = {lv.key: lv for lv in LEVERS}
DEFAULT_WEEKS = 8
KEEP_WEEKS = 26


def current_values(last_week: pd.Series, master_row: pd.Series) -> dict[str, float]:
    """The lever positions that mean 'no change' for this person."""
    out = {}
    for lv in LEVERS:
        if lv.kind == "level":
            v = float(last_week[lv.column])
            out[lv.key] = round(v * 100, 1) if lv.key == "night_shift" else round(v, 2)
        elif lv.kind == "toggle":
            out[lv.key] = int(master_row[lv.column])
        else:
            out[lv.key] = 0
    return out


def _future_weeks(hist: pd.DataFrame, weeks: int) -> pd.DataFrame:
    last = hist.iloc[-1]
    rows = []
    for k in range(1, weeks + 1):
        r = last.copy()
        r["SnapshotDate"] = last["SnapshotDate"] + pd.Timedelta(weeks=k)
        r["TenureDays"] = last["TenureDays"] + 7 * k
        r["TenureMonths"] = r["TenureDays"] / 30.44
        r["MonthsSincePromotion"] = last["MonthsSincePromotion"] + 7 * k / 30.44
        r["GrievanceFlag"] = 0
        rows.append(r)
    return pd.DataFrame(rows)


def _apply(future: pd.DataFrame, master: pd.DataFrame, changes: dict[str, float]) -> tuple[pd.DataFrame, pd.DataFrame]:
    future, master = future.copy(), master.copy()
    for key, value in changes.items():
        lv = LEVER_BY_KEY.get(key)
        if lv is None or value is None:
            continue
        v = float(np.clip(float(value), lv.lo, lv.hi))
        if lv.kind == "level":
            future[lv.column] = v / 100 if key == "night_shift" else v
        elif lv.kind == "raise" and v > 0:
            r = v / 100
            future["MonthlySalary"] = future["MonthlySalary"] * (1 + r)
            future["SalaryVsRoleBenchmark"] = (1 + future["SalaryVsRoleBenchmark"]) * (1 + r) - 1
            # LastHikePct is left alone: overwriting it would read a 10% raise
            # after last year's 14% hike as a step down.
        elif lv.kind == "promote" and v >= 1:
            future["MonthsSincePromotion"] = np.arange(1, len(future) + 1) * 7 / 30.44
        elif lv.kind == "training" and v > 0:
            future["TrainingCountToDate"] = future["TrainingCountToDate"] + int(v)
        elif lv.kind == "toggle" and lv.key == "accommodation":
            if v >= 0.5 and int(master[lv.column].iloc[0]) == 0:
                # Accommodated staff live at or near the site camp. The data
                # records that as a short distance, so the lever does the same
                # (the generator uses 12% of the home distance, 0.5 to 25 km).
                master[lv.column] = 1
                master["DistanceFromSiteKm"] = np.clip(master["DistanceFromSiteKm"] * 0.12, 0.5, 25)
            elif v < 0.5:
                master[lv.column] = 0
    return future, master


def project(hist: pd.DataFrame, master_row: pd.DataFrame, changes: dict[str, float],
            weeks: int = DEFAULT_WEEKS) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Feature rows at the end of the projection: (if nothing changes, with changes).

    `hist` is the person's raw weekly rows, `master_row` their one-row master record.
    """
    hist = hist.copy()
    hist["SnapshotDate"] = pd.to_datetime(hist["SnapshotDate"])
    hist = hist.sort_values("SnapshotDate").reset_index(drop=True)
    future = _future_weeks(hist, weeks)
    fut_c, master_c = _apply(future, master_row, changes)
    # The longest look-back in the feature code is 13 weeks, so only the last
    # KEEP_WEEKS real weeks can reach the projected row. Trimming makes a call
    # about 5x faster; the one cumulative feature is corrected after the build.
    dropped = max(len(hist) - KEEP_WEEKS, 0)
    hist = hist.iloc[dropped:]
    base = build_features(pd.concat([hist, future], ignore_index=True), master_row).iloc[[-1]]
    scen = build_features(pd.concat([hist, fut_c], ignore_index=True), master_c).iloc[[-1]]
    for row in (base, scen):
        row["weeks_observed"] = row["weeks_observed"] + dropped
    return base.reset_index(drop=True), scen.reset_index(drop=True)


def _area_totals(model, row: pd.DataFrame) -> dict[str, float]:
    contrib, _ = model.contributions(row)
    out: dict[str, float] = {}
    for name, c in zip(model.features, contrib[0]):
        cat = explain.pretty(name)[1]
        out[cat] = out.get(cat, 0.0) + float(c)
    return out


def simulate(bundle: dict, employee_id: str, changes: dict[str, float] | None = None,
             weeks: int = DEFAULT_WEEKS, band_horizon: int = 90) -> dict:
    hist = warehouse.query("SELECT * FROM employee_weekly WHERE EmployeeID = ? ORDER BY SnapshotDate",
                           (employee_id,))
    master = warehouse.query("SELECT * FROM employee_master WHERE EmployeeID = ?", (employee_id,))
    if hist.empty or master.empty:
        raise KeyError(employee_id)
    weeks = int(np.clip(weeks, 1, 26))
    changes = {k: v for k, v in (changes or {}).items() if k in LEVER_BY_KEY}
    base, scen = project(hist, master, changes, weeks)

    models = bundle["horizons"]
    pb = monotone_horizons({h: m.predict_proba(base) for h, m in models.items()})
    ps = monotone_horizons({h: m.predict_proba(scen) for h, m in models.items()})

    driver = models.get(band_horizon) or models[max(models)]
    ab, as_ = _area_totals(driver, base), _area_totals(driver, scen)
    moved = []
    for cat in set(ab) | set(as_):
        d = as_.get(cat, 0.0) - ab.get(cat, 0.0)
        if abs(d) >= 0.005:
            moved.append({"area": explain.CATEGORY_LABEL.get(cat, cat), "category": cat,
                          "logodds": round(d, 4)})
    moved.sort(key=lambda m: m["logodds"])

    last = hist.iloc[-1]
    return {
        "employee_id": employee_id,
        "weeks": weeks,
        "as_of": str(pd.to_datetime(last["SnapshotDate"]).date()),
        "levers": [{**lv.__dict__, "current": current_values(last, master.iloc[0])[lv.key]}
                   for lv in LEVERS],
        "applied": changes,
        "baseline": {str(h): round(float(v[0]), 4) for h, v in pb.items()},
        "scenario": {str(h): round(float(v[0]), 4) for h, v in ps.items()},
        "moved": moved,
        "model_version": bundle["version"],
        "caveat": ("Model expectation if the change holds for the whole period and nothing else "
                   "changes. Not a guarantee for one person."),
    }
