"""Toolchain capability preflight (spec section 5)."""

from __future__ import annotations

import re
from typing import Any

from . import __version__
from .jobs import STAGE_ADAPTERS

COCOTB_MIN_VERILATOR = (5, 36)


def _ver_tuple(v: str | None) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:2])


def capability_profile() -> dict[str, Any]:
    stages: dict[str, Any] = {}
    tools: dict[str, Any] = {}
    for stage, classes in STAGE_ADAPTERS.items():
        caps = [cls().probe_capabilities() for cls in classes]
        for cap in caps:
            tools[cap.tool] = {"available": cap.available, "version": cap.version, "notes": cap.notes}
        stages[stage] = {"available": all(c.available for c in caps), "tools": [c.tool for c in caps]}

    notes: list[str] = []
    vv = tools.get("verilator", {}).get("version")
    if vv and _ver_tuple(vv) < COCOTB_MIN_VERILATOR:
        notes.append(f"Verilator {vv} is older than 5.036, which cocotb 2.x requires; Verilator is used for lint only and simulation uses Icarus.")
    notes.append("UVM: not available on the open-source cocotb + Icarus path. A capability-tested simulator adapter is required for UVM.")
    notes.append("Formal engine: smtbmc with z3 (boolector is installed in some images but crashed in preflight testing; not used by default).")
    return {"worker_version": __version__, "stages": stages, "tools": tools, "notes": notes}
