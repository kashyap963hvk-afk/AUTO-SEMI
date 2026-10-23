"""Canonical hashing. Must stay byte-compatible with apps/web/src/lib/hash.ts."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def job_input_hash(job: dict[str, Any]) -> str:
    """Hash everything that can change a tool outcome; ignore run identity and quotas."""
    keyed = {k: job[k] for k in ("schema_version", "stage", "top", "parameters", "files", "filelist", "options") if k in job}
    return sha256_text(canonical_json(keyed))
