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


# (lever, description, value from the person's current settings, expected sign, applies to this person)
MOVES = [
    ("overtime", "Overtime down 10 h/week", lambda c: max(c["overtime"] - 10, 0), -1, lambda c: c["overtime"] > 0),
    ("overtime", "Overtime up 10 h/week", lambda c: c["overtime"] + 10, +1, lambda c: True),
    ("night_shift", "Night shifts down 20 points", lambda c: max(c["night_shift"] - 20, 0), -1, lambda c: c["night_shift"] > 0),
    ("night_shift", "Night shifts up 20 points", lambda c: min(c["night_shift"] + 20, 90), +1, lambda c: True),
    ("pay_delay", "Salary 7 days late", lambda c: 7, +1, lambda c: c["pay_delay"] < 7),
    ("absence", "One more absent day a week", lambda c: c["absence"] + 1, +1, lambda c: True),
    ("engagement", "Engagement up 2", lambda c: min(c["engagement"] + 2, 10), -1, lambda c: True),
    ("engagement", "Engagement down 2", lambda c: max(c["engagement"] - 2, 1), +1, lambda c: True),
    ("raise", "10% raise", lambda c: 10, -1, lambda c: True),
    ("promote", "Promotion", lambda c: 1, -1, lambda c: True),
    ("training", "Two trainings", lambda c: 2, -1, lambda c: True),
    ("accommodation", "Site accommodation", lambda c: 1, -1, lambda c: c["accommodation"] < 1),
]


def lever_moves(cur: dict) -> list[tuple[str, str, dict, int]]:
    """(lever key, description, change, expected sign) for one person."""
    return [(key, desc, {key: value(cur)}, sign) for key, desc, value, sign, ok in MOVES if ok(cur)]


def project_sample(n: int = 200, seed: int = 11) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Feature rows before/after every lever move for `n` active employees.

    Model independent, so one projection serves every model being audited.
    Batched: one projection per move for everyone at once (`project_many`),
    about 25x faster than projecting person by person."""
    snap = latest_snapshots()
    ids = snap["EmployeeID"].sample(min(n, len(snap)), random_state=seed).tolist()
    weekly = warehouse.query("SELECT * FROM employee_weekly")
    master = warehouse.query("SELECT * FROM employee_master")
    weekly, master = weekly[weekly["EmployeeID"].isin(ids)], master[master["EmployeeID"].isin(ids)]
    last = weekly.assign(SnapshotDate=pd.to_datetime(weekly["SnapshotDate"])) \
        .sort_values("SnapshotDate").groupby("EmployeeID").tail(1).set_index("EmployeeID")
    cur = {e: whatif.current_values(last.loc[e], master.set_index("EmployeeID").loc[e]) for e in last.index}

    base = whatif.project_many(weekly, master, {}).set_index("EmployeeID")
    base_rows, scen_rows, meta = [], [], []
    for key, desc, value, sign, ok in MOVES:
        who = [e for e in cur if ok(cur[e])]
        if not who:
            continue
        vals = {e: value(cur[e]) for e in who}
        kind = whatif.LEVER_BY_KEY[key].kind
        change = {key: pd.Series(vals)} if kind == "level" and len(set(vals.values())) > 1 else {key: next(iter(vals.values()))}
        scen = whatif.project_many(weekly[weekly["EmployeeID"].isin(who)],
                                   master[master["EmployeeID"].isin(who)], change).set_index("EmployeeID")
        base_rows.append(base.loc[who].reset_index())
        scen_rows.append(scen.loc[who].reset_index())
        meta += [{"EmployeeID": e, "lever": key, "move": desc, "expected": sign} for e in who]
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
