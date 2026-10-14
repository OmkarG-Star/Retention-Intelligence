"""Lever-direction audit for the what-if simulator.

A what-if tool is only trustworthy if "less overtime" never shows up as "more
risk" for the wrong reason. LightGBM can be forced to respect a direction
(monotone constraints, see horizon.py), but the logistic regression and the
blend cannot: with 106 correlated inputs a linear model can give a level a
negative weight and its rolling mean a positive one, and the net effect of a
real change is then anyone's guess.

So the deployed models are checked the way the simulator uses them. A sample
of active employees is projected forward with each lever moved in a direction
whose effect the simulator's ground truth fixes (more overtime raises the
hazard, a raise lowers it...). The raw log-odds are compared before and after.
Raw, not calibrated: isotonic calibration only flattens, it never reverses an
ordering, so the raw score is the stricter test.

Run with `python -m attrition.cli audit-levers`; the result is written to
docs/lever_audit.json and shown on the Model health page.
"""
from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd

from ..config import paths
from ..data import warehouse
from ..scoring import whatif
from ..scoring.score import latest_snapshots

AUDIT_FILE = paths.root / "docs" / "lever_audit.json"
TOLERANCE = 0.01  # log-odds; smaller moves are treated as "no reaction"


def lever_moves(cur: dict) -> list[tuple[str, str, dict, int]]:
    """(lever key, description, change, expected sign of the risk change)."""
    moves = [
        ("overtime", "Overtime down 10 h/week", {"overtime": max(cur["overtime"] - 10, 0)}, -1),
        ("overtime", "Overtime up 10 h/week", {"overtime": cur["overtime"] + 10}, +1),
        ("night_shift", "Night shifts down 20 points", {"night_shift": max(cur["night_shift"] - 20, 0)}, -1),
        ("night_shift", "Night shifts up 20 points", {"night_shift": min(cur["night_shift"] + 20, 90)}, +1),
        ("pay_delay", "Salary 7 days late", {"pay_delay": 7}, +1),
        ("absence", "One more absent day a week", {"absence": cur["absence"] + 1}, +1),
        ("engagement", "Engagement up 2", {"engagement": min(cur["engagement"] + 2, 10)}, -1),
        ("engagement", "Engagement down 2", {"engagement": max(cur["engagement"] - 2, 1)}, +1),
        ("raise", "10% raise", {"raise": 10}, -1),
        ("promote", "Promotion", {"promote": 1}, -1),
        ("training", "Two trainings", {"training": 2}, -1),
        ("accommodation", "Site accommodation", {"accommodation": 1}, -1),
    ]
    out = []
    for key, desc, change, sign in moves:
        if key == "accommodation" and cur["accommodation"] >= 1:
            continue
        if key == "pay_delay" and cur["pay_delay"] >= 7:
            continue
        if key == "night_shift" and sign < 0 and cur["night_shift"] <= 0:
            continue
        if key == "overtime" and sign < 0 and cur["overtime"] <= 0:
            continue
        out.append((key, desc, change, sign))
    return out


def project_sample(n: int = 200, seed: int = 11) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Feature rows before/after every lever move for `n` active employees.
    Model independent, so one projection serves every model being audited."""
    snap = latest_snapshots()
    ids = snap["EmployeeID"].sample(min(n, len(snap)), random_state=seed).tolist()
    weekly = warehouse.query("SELECT * FROM employee_weekly")
    master = warehouse.query("SELECT * FROM employee_master")
    weekly = weekly[weekly["EmployeeID"].isin(ids)]
    base_rows, scen_rows, meta = [], [], []
    for emp, hist in weekly.groupby("EmployeeID"):
        m = master[master["EmployeeID"] == emp]
        last = hist.sort_values("SnapshotDate").iloc[-1]
        cur = whatif.current_values(last, m.iloc[0])
        for key, desc, change, sign in lever_moves(cur):
            b, s = whatif.project(hist, m, change)
            base_rows.append(b)
            scen_rows.append(s)
            meta.append({"EmployeeID": emp, "lever": key, "move": desc, "expected": sign})
    return (pd.concat(base_rows, ignore_index=True), pd.concat(scen_rows, ignore_index=True),
            pd.DataFrame(meta))


def audit_model(model, base: pd.DataFrame, scen: pd.DataFrame, meta: pd.DataFrame) -> dict:
    rb = model._raw_logit(model._prepare(base))
    rs = model._raw_logit(model._prepare(scen))
    right = (rs - rb) * meta["expected"].to_numpy()       # > 0: moved the expected way
    moves = []
    for desc, idx in meta.groupby("move", sort=False).groups.items():
        r = right[np.asarray(idx)]
        moves.append({"move": desc, "lever": meta.loc[idx[0], "lever"], "n": int(len(r)),
                      "expected_share": round(float((r > TOLERANCE).mean()), 3),
                      "no_reaction_share": round(float((np.abs(r) <= TOLERANCE).mean()), 3),
                      "wrong_share": round(float((r < -TOLERANCE).mean()), 3),
                      "median_logodds": round(float(np.median(r)), 3)})
    return {"kind": model.kind, "wrong_share": round(float((right < -TOLERANCE).mean()), 4),
            "moves": moves}


def run_audit(bundle: dict | None = None, n: int = 200, verbose: bool = True) -> dict:
    from .train import load_bundle
    log = print if verbose else (lambda *a, **k: None)
    t0 = time.time()
    bundle = bundle or load_bundle()
    base, scen, meta = project_sample(n)
    log(f"  projected {len(meta):,} lever moves for {meta['EmployeeID'].nunique()} people "
        f"in {time.time() - t0:.0f}s")
    rec = bundle["record"]
    out = {"model_version": bundle["version"], "data_fingerprint": rec.get("data_fingerprint"),
           "champions": rec.get("champions"), "people": int(meta["EmployeeID"].nunique()),
           "tolerance_logodds": TOLERANCE, "horizons": {}}
    for h, model in sorted(bundle["horizons"].items()):
        res = audit_model(model, base, scen, meta)
        out["horizons"][str(h)] = res
        bad = [m for m in res["moves"] if m["wrong_share"] > 0.05]
        log(f"  [{h:>3}d] {res['kind']:<8} wrong-way moves {res['wrong_share']:.1%}"
            + ("" if not bad else "  |  " + ", ".join(f"{m['move']} {m['wrong_share']:.0%}" for m in bad)))
    out["seconds"] = round(time.time() - t0, 1)
    AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
    AUDIT_FILE.write_text(json.dumps(out, indent=1))
    log(f"Lever audit written to {AUDIT_FILE.relative_to(paths.root)}")
    return out


def load_audit() -> dict | None:
    try:
        return json.loads(AUDIT_FILE.read_text())
    except Exception:
        return None
