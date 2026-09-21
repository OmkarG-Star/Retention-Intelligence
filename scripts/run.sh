#!/usr/bin/env bash
# Start the API + dashboard. Assumes scripts/setup.sh has already been run.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ -d .venv ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

export PYTHONPATH="$ROOT/src"

if [ ! -f data/processed/warehouse.db ]; then
  echo "No warehouse found. Running the pipeline first..."
  python -m attrition.cli pipeline
fi

echo "Serving on http://127.0.0.1:8000  (Ctrl+C to stop)"
python -m attrition.cli serve "$@"
