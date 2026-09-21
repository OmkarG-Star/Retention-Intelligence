#!/usr/bin/env bash
# One-time setup: virtual environment, dependencies, full data + model pipeline.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python 3.10+ is required but '$PY' was not found on PATH." >&2
  exit 1
fi

echo "==> Creating virtual environment (.venv)"
"$PY" -m venv .venv

# shellcheck disable=SC1091
source .venv/bin/activate

echo "==> Installing dependencies"
python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements.txt

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Wrote .env (copy of .env.example)"
fi

export PYTHONPATH="$ROOT/src"

echo "==> Building dataset, warehouse, features, models and scores"
echo "    (this takes roughly 3-5 minutes on a laptop)"
python -m attrition.cli pipeline

cat <<'EOF'

Setup complete.

Start the app with:
    ./scripts/run.sh
then open http://127.0.0.1:8000

Sign in with:
    admin      / Admin@2026
    hr.manager / HrManager@2026
    viewer     / Viewer@2026
EOF
