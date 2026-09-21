.PHONY: setup pipeline serve test clean
PY ?= python

setup:
	$(PY) -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -r requirements.txt

pipeline:
	PYTHONPATH=src $(PY) -m attrition.cli pipeline

serve:
	PYTHONPATH=src $(PY) -m attrition.cli serve --reload

test:
	PYTHONPATH=src $(PY) -m pytest -q

clean:
	rm -rf data/processed/* models/v* models/registry.json
