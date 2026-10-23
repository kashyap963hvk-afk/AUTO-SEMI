"""Yosys generic synthesis adapter.

Without a Liberty file the mapped cells are Yosys internal gates, so the
reported figures are technology-independent cell counts, not silicon area.
"""

from __future__ import annotations

import re
from pathlib import Path

from ..models import Finding, Job, StageStatus
from ..sandbox import ExecResult
from .base import AdapterOutput, ToolAdapter
from .lint import include_dirs

_CELL = re.compile(r"^\s+(\$\S+|\S+_)\s+(\d+)\s*$")
_NUM = re.compile(r"^\s+Number of (?P<what>[a-z ]+):\s+(?P<n>\d+)\s*$")


def parse_stat(text: str) -> dict:
    cells: dict[str, int] = {}
    counts: dict[str, int] = {}
    for line in text.splitlines():
        m = _NUM.match(line)
        if m:
            counts[m.group("what").strip().replace(" ", "_")] = int(m.group("n"))
            continue
        m = _CELL.match(line)
        if m:
            cells[m.group(1)] = int(m.group(2))
    sequential = sum(n for c, n in cells.items() if "DFF" in c.upper() or "LATCH" in c.upper())
    latches = sum(n for c, n in cells.items() if "LATCH" in c.upper())
    return {
        "cells_total": counts.get("cells"),
        "wires": counts.get("wires"),
        "wire_bits": counts.get("wire_bits"),
        "memories": counts.get("memories"),
        "sequential_cells": sequential,
        "combinational_cells": (counts.get("cells") or 0) - sequential,
        "latches": latches,
        "cell_types": dict(sorted(cells.items())),
        "area_basis": "Yosys generic gate library (no Liberty file): technology-independent cell count, not area in um^2",
    }


class YosysSynth(ToolAdapter):
    tool = "yosys"
    executable = "yosys"
    version_args = ("-V",)

    def build_command(self, job: Job, run_dir: Path) -> list[str]:
        incs = " ".join(f"-I{d}" for d in include_dirs(job))
        reads = "; ".join(f"read_verilog -sv {incs} {f}".replace("  ", " ") for f in job.filelist)
        chparam = ""
        if job.parameters:
            sets = " ".join(f"-set {k} {v}" for k, v in sorted(job.parameters.items()))
            chparam = f"chparam {sets} {job.top}; "
        script = (
            f"{reads}; {chparam}synth -top {job.top}; check; "
            "tee -q -o stat.txt stat; write_verilog -noattr netlist.v"
        )
        return ["yosys", "-q", "-l", "synth.log", "-p", script]

    def parse_results(self, job: Job, run_dir: Path, res: ExecResult) -> AdapterOutput:
        findings: list[Finding] = []
        log = (run_dir / "synth.log").read_text(errors="replace") if (run_dir / "synth.log").exists() else ""
        for line in log.splitlines():
            if line.startswith("ERROR:"):
                findings.append(Finding(severity="error", code="YOSYS_ERROR", message=line[6:].strip(), tool=self.tool))
            elif line.startswith("Warning:"):
                findings.append(Finding(severity="warning", code="YOSYS_WARNING", message=line[8:].strip(), tool=self.tool))
        stat_path = run_dir / "stat.txt"
        metrics = parse_stat(stat_path.read_text()) if stat_path.exists() else {}
        status = self.classify_exit_status(res)
        if status == StageStatus.PASS:
            if not (run_dir / "netlist.v").exists() or not metrics.get("cells_total"):
                status = StageStatus.ERROR
                findings.append(Finding(severity="error", code="NO_NETLIST", message="synthesis exited 0 but produced no netlist/statistics", tool=self.tool))
            elif metrics.get("latches"):
                status = StageStatus.FAIL
                findings.append(Finding(severity="error", code="LATCH_INFERRED", message=f"{metrics['latches']} latch cell(s) inferred; latches are not approved for this design", tool=self.tool))
        step = self.step(res, status)
        step.stdout = (step.stdout + "\n--- synth.log (tail) ---\n" + log[-40_000:]).strip()
        return AdapterOutput(step=step, findings=findings, extra={"metrics": metrics})

    def collect_artifacts(self, job: Job, run_dir: Path) -> list[Path]:
        return [p for p in (run_dir / "netlist.v", run_dir / "stat.txt") if p.exists()]
