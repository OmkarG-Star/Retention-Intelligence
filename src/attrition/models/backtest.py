"""Rolling-origin backtest.

One train/valid/test split gives one number, and one number can be lucky. Here
the whole procedure (embargoed split, three candidates, champion picked on
validation, scored on test) is replayed with the data cutoff moved back in
steps of `step_months`. With the default 4-month step the test windows never
overlap, so each origin is an independent look at how the method would have
done at that point in time.

    origin 0  |---- train ----|emb|-- valid --|emb|-- test --|-h-| cutoff
    origin 1  |-- train --|emb|-- valid --|emb|-- test --|-h-| cutoff - 4m
    ...

The spread across origins is a better guide to what to expect next quarter than
a bootstrap interval from a single window, because it includes the change in
the workforce over time and not only sampling noise.

Run with `python -m attrition.cli backtest`. The result is written to
docs/backtest.json, which the Model health page reads.
"""
from __future__ import annotations

import json
import time
import warnings

import numpy as np
import pandas as pd

from ..config import paths
from ..features.build import feature_columns, load_features
from . import evaluate
from .horizon import KINDS, HorizonModel, pick_champion
from .train import horizon_split

BACKTEST_FILE = paths.root / "docs" / "backtest.json"


def run_backtest(horizons: tuple[int, ...] = (30, 90), n_origins: int = 4,
                 step_months: int = 4, verbose: bool = True) -> dict:
    log = print if verbose else (lambda *a, **k: None)
    t0 = time.time()
    df = load_features()
    numeric, categorical = feature_columns(df)
    cutoff = df["SnapshotDate"].max()
    out: dict = {"step_months": step_months, "data_cutoff": str(cutoff.date()),
                 "candidates": list(KINDS), "horizons": {}}

    for h in horizons:
        y = f"label_{h}"
        eligible = df[df[f"eligible_{h}"] == 1]
        origins = []
        for k in range(n_origins):
            cut_k = cutoff - pd.DateOffset(months=step_months * k)
            sp = horizon_split(eligible[eligible["SnapshotDate"] <= cut_k], h, cut_k)
            tr, va, te = sp["train"], sp["valid"], sp["test"]
            if tr[y].sum() < 25 or va[y].nunique() < 2 or te[y].nunique() < 2:
                log(f"  [{h}d] origin {k}: skipped, too few decisions")
                continue
            cands: dict[str, HorizonModel] = {}
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                for kind in KINDS:
                    cands[kind] = (HorizonModel.blend_of(cands["lgbm"], cands["logistic"], va, y)
                                   if kind == "blend" else
                                   HorizonModel(h, numeric, categorical, kind=kind).fit(tr, va, y))
            champ = pick_champion(cands)
            argmax = max(cands, key=lambda c: cands[c].valid_pr_auc_)   # the old rule, for comparison
            yt = te[y].to_numpy()
            scores = {}
            for kind, m in cands.items():
                d = evaluate.discrimination(yt, m.predict_proba(te))
                scores[kind] = {"valid_pr_auc": round(m.valid_pr_auc_, 4),
                                "pr_auc": round(d["pr_auc"], 4), "roc_auc": round(d["roc_auc"], 4),
                                "brier": round(d["brier"], 4), "recall_at_15": round(d["recall_at_15"], 4)}
            row = {"origin": k, "test": sp["windows"]["test"], "train_end": sp["windows"]["train"][1],
                   "train_rows": int(len(tr)), "test_rows": int(len(te)),
                   "decisions": int(yt.sum()), "base_rate": round(float(yt.mean()), 4),
                   "champion": champ, "champion_scores": scores[champ], "argmax_choice": argmax,
                   "argmax_pr_auc": scores[argmax]["pr_auc"], "candidates": scores}
            # lift over the base rate: PR-AUC of a random ranking equals the base rate
            row["lift"] = round(scores[champ]["pr_auc"] / max(row["base_rate"], 1e-9), 2)
            origins.append(row)
            log(f"  [{h:>3}d] test {row['test'][0]}..{row['test'][1]}  decisions {row['decisions']:>4}"
                f"  base {row['base_rate']:.3f}  champion {champ:<8} PR-AUC "
                f"{scores[champ]['pr_auc']:.3f}  (x{row['lift']} base)  |  "
                + "  ".join(f"{c} {s['pr_auc']:.3f}" for c, s in scores.items()))
        if not origins:
            continue
        pr = np.array([o["champion_scores"]["pr_auc"] for o in origins])
        lift = np.array([o["lift"] for o in origins])
        rec = np.array([o["champion_scores"]["recall_at_15"] for o in origins])
        wins = {c: sum(o["champion"] == c for o in origins) for c in KINDS}
        argmax_pr = np.array([o["argmax_pr_auc"] for o in origins])
        best_on_test = {c: sum(max(o["candidates"], key=lambda k: o["candidates"][k]["pr_auc"]) == c
                               for o in origins) for c in KINDS}
        out["horizons"][str(h)] = {
            "origins": origins,
            "summary": {"pr_auc_mean": round(float(pr.mean()), 4), "pr_auc_min": round(float(pr.min()), 4),
                        "pr_auc_max": round(float(pr.max()), 4), "lift_mean": round(float(lift.mean()), 2),
                        "lift_min": round(float(lift.min()), 2),
                        "recall_at_15_mean": round(float(rec.mean()), 4),
                        "recall_at_15_min": round(float(rec.min()), 4),
                        "champion_counts": wins, "best_on_test_counts": best_on_test,
                        "argmax_rule_pr_auc_mean": round(float(argmax_pr.mean()), 4)},
        }
    out["seconds"] = round(time.time() - t0, 1)
    BACKTEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    BACKTEST_FILE.write_text(json.dumps(out, indent=1))
    log(f"Backtest written to {BACKTEST_FILE.relative_to(paths.root)} in {out['seconds']}s")
    return out


def load_backtest() -> dict | None:
    try:
        return json.loads(BACKTEST_FILE.read_text())
    except Exception:
        return None


if __name__ == "__main__":
    run_backtest()
