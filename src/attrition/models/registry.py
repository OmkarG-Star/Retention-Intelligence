"""Model registry.

Every training run gets an immutable version stamp, its own artefact folder, and
a JSON record of the features, metrics and data fingerprint behind it. Nothing
in the app loads "the model" — it loads a version, so a prediction made in March
can still be explained in September.
"""
from __future__ import annotations

import hashlib
import json
import pickle
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import paths

REGISTRY_FILE = paths.models / "registry.json"


def new_version(prefix: str = "v") -> str:
    return f"{prefix}{datetime.now(timezone.utc).strftime('%Y%m%d.%H%M%S')}"


def artefact_dir(version: str) -> Path:
    d = paths.models / version
    d.mkdir(parents=True, exist_ok=True)
    return d


def data_fingerprint(*frames) -> str:
    h = hashlib.sha256()
    for f in frames:
        h.update(str(f.shape).encode())
        h.update(",".join(map(str, f.columns)).encode())
        h.update(str(f.iloc[:50].to_numpy().tobytes() if len(f) else b"").encode()[:4096])
    return h.hexdigest()[:16]


def save_artefact(version: str, name: str, obj: Any) -> Path:
    p = artefact_dir(version) / f"{name}.pkl"
    with open(p, "wb") as fh:
        pickle.dump(obj, fh, protocol=pickle.HIGHEST_PROTOCOL)
    return p


def load_artefact(version: str, name: str) -> Any:
    with open(artefact_dir(version) / f"{name}.pkl", "rb") as fh:
        return pickle.load(fh)


def _read() -> dict:
    if REGISTRY_FILE.exists():
        return json.loads(REGISTRY_FILE.read_text())
    return {"current": None, "versions": {}}


def register(version: str, record: dict, make_current: bool = True) -> None:
    reg = _read()
    record = {**record, "version": version,
              "registered_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    reg["versions"][version] = record
    if make_current:
        reg["current"] = version
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_FILE.write_text(json.dumps(reg, indent=2, default=str))


def current_version() -> str | None:
    return _read().get("current")


def get(version: str | None = None) -> dict:
    reg = _read()
    version = version or reg.get("current")
    if not version or version not in reg["versions"]:
        raise FileNotFoundError("No trained model found. Run: python -m attrition.cli train")
    return reg["versions"][version]


def list_versions() -> list[dict]:
    reg = _read()
    items = sorted(reg["versions"].values(), key=lambda r: r.get("registered_at", ""), reverse=True)
    for it in items:
        it["is_current"] = it["version"] == reg.get("current")
    return items


def promote(version: str) -> None:
    reg = _read()
    if version not in reg["versions"]:
        raise KeyError(version)
    reg["current"] = version
    REGISTRY_FILE.write_text(json.dumps(reg, indent=2, default=str))
