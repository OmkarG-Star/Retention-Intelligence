"""Command line entrypoint.

    python -m attrition.cli generate      simulate the EPC dataset into data/raw
    python -m attrition.cli ingest        load data/raw into the SQLite warehouse
    python -m attrition.cli features      build the leakage-safe feature table
    python -m attrition.cli train         train, evaluate and register a model version
    python -m attrition.cli score         score every active employee
    python -m attrition.cli backfill      replay past scoring runs for trend history
    python -m attrition.cli seed-users    create the login accounts
    python -m attrition.cli pipeline      all of the above, in order
    python -m attrition.cli serve         run the API and UI
"""
from __future__ import annotations

import argparse
import sys


def cmd_generate(args):
    """Simulate the dataset — but never overwrite files that are already there.

    Once real HR data is dropped into data/raw, `pipeline` must leave it alone.
    Pass --force to deliberately regenerate the simulation.
    """
    from .config import paths
    from .data.generate import main

    existing = [n for n in ("employee_master", "employee_weekly")
                if any((paths.data_raw / f"{n}{s}").exists()
                       for s in (".csv", ".csv.gz", ".parquet"))]
    if existing and not getattr(args, "force", False):
        print("  data/raw already populated - keeping it "
              "(use `generate --force` to rebuild the simulation)")
        return
    main()


def cmd_ingest(args):
    from .data.warehouse import ingest
    counts = ingest()
    for k, v in counts.items():
        print(f"  loaded {k:22s} {v:>8,} rows")


def cmd_features(args):
    from .features.build import build_and_store
    df = build_and_store()
    print(f"  feature table: {len(df):,} rows x {df.shape[1]} columns")


def cmd_train(args):
    from .models.train import train_all
    train_all()


def cmd_score(args):
    from .scoring.score import score_population
    score_population()


def cmd_backfill(args):
    from .scoring.score import backfill_history
    backfill_history(n_runs=args.runs)


def cmd_seed_users(args):
    from .api.security import seed_users
    for line in seed_users():
        print(f"  {line}")


def cmd_pipeline(args):
    steps = [("Generating dataset", cmd_generate), ("Loading warehouse", cmd_ingest),
             ("Building features", cmd_features), ("Training models", cmd_train),
             ("Backfilling history", cmd_backfill), ("Scoring population", cmd_score),
             ("Seeding users", cmd_seed_users)]
    for i, (label, fn) in enumerate(steps, 1):
        print(f"\n[{i}/{len(steps)}] {label}")
        fn(args)
    print("\nPipeline complete. Start the app with:  python -m attrition.cli serve")


def cmd_serve(args):
    import uvicorn
    from .config import settings
    uvicorn.run("attrition.api.main:app", host=args.host or settings.host,
                port=args.port or settings.port, reload=args.reload)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="attrition", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name, fn in [("ingest", cmd_ingest), ("features", cmd_features),
                     ("train", cmd_train), ("score", cmd_score), ("seed-users", cmd_seed_users)]:
        sub.add_parser(name).set_defaults(func=fn)
    p = sub.add_parser("generate")
    p.add_argument("--force", action="store_true",
                   help="regenerate the simulation even if data/raw is populated")
    p.set_defaults(func=cmd_generate)
    p = sub.add_parser("backfill"); p.add_argument("--runs", type=int, default=12); p.set_defaults(func=cmd_backfill)
    p = sub.add_parser("pipeline")
    p.add_argument("--runs", type=int, default=12)
    p.add_argument("--force", action="store_true",
                   help="regenerate the simulated dataset instead of using data/raw as-is")
    p.set_defaults(func=cmd_pipeline)
    p = sub.add_parser("serve")
    p.add_argument("--host", default=None); p.add_argument("--port", type=int, default=None)
    p.add_argument("--reload", action="store_true"); p.set_defaults(func=cmd_serve)
    args = parser.parse_args(argv)
    return args.func(args) or 0


if __name__ == "__main__":
    sys.exit(main())
