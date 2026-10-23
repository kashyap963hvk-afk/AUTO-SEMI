"""OpenROAD Flow Scripts (ORFS) physical-design adapter.

Status in this repository: preflight and gating are implemented and tested;
the execution path follows the documented ORFS entry point
(``make DESIGN_CONFIG=<config.mk>``) but has NOT been executed against a real
ORFS installation in this repository's environments. The result always says
so in ``limitations``.
"""

from __future__ import annotations

import os
from pathlib import Path

from ..models import Finding, Job, StageStatus
from ..sandbox import ExecResult
from .base import AdapterOutput, Capability, ToolAdapter

SUPPORTED_PLATFORMS = {"sky130hd", "gf180"}


class OrfsPhysical(ToolAdapter):
    tool = "openroad-flow-scripts"
    executable = "openroad"
    version_args = ("-version",)
    version_pattern = r"(v?\d+\.\d+[^\s]*)"

    def flow_home(self) -> Path | None:
        home = os.environ.get("ORFS_FLOW_HOME")
        if home and (Path(home) / "Makefile").exists():
            return Path(home)
        return None

    def probe_capabilities(self) -> Capability:
        cap = super().probe_capabilities()
        flow = self.flow_home()
        if not flow:
            cap.available = False
            cap.notes.append("ORFS_FLOW_HOME is not set or has no Makefile: physical implementation is blocked.")
        else:
            platforms = sorted(p.name for p in (flow / "platforms").glob("*") if p.name in SUPPORTED_PLATFORMS)
            cap.notes.append(f"platforms present: {platforms or 'none'}")
        cap.notes.append("Public-PDK DRC/LVS results are prototype checks, not foundry sign-off.")
        return cap

    def preflight(self, job: Job) -> tuple[StageStatus, list[Finding]] | None:
        """Return a blocking status before anything runs, or None when the job may run."""
        findings: list[Finding] = []
        platform = job.options.get("platform")
        if not job.options.get("clock_period_ns") or not job.options.get("constraints_approved"):
            findings.append(Finding(severity="error", code="TIMING_CONSTRAINTS_INCOMPLETE", message="clock period is unknown or the SDC draft has not been approved", tool=self.tool))
            return StageStatus.BLOCKED_MISSING_CONSTRAINTS, findings
        if platform not in SUPPORTED_PLATFORMS:
            findings.append(Finding(severity="error", code="PDK_UNCONFIRMED", message=f"target platform {platform!r} is not a supported, confirmed ORFS platform", tool=self.tool))
            return StageStatus.BLOCKED_MISSING_CONSTRAINTS, findings
        cap = self.probe_capabilities()
        flow = self.flow_home()
        if not cap.available or not flow or not (flow / "platforms" / platform).exists():
            findings.append(Finding(severity="error", code="TOOL_UNAVAILABLE", message="OpenROAD/ORFS or the selected platform collateral is not installed on this worker", tool=self.tool))
            return StageStatus.BLOCKED_TOOL_UNAVAILABLE, findings
        return None

    def build_command(self, job: Job, run_dir: Path) -> list[str]:
        platform = job.options["platform"]
        verilog = " ".join(str(run_dir / f) for f in job.filelist)
        (run_dir / "constraint.sdc").write_text(job.files.get("constraints/approved.sdc", ""))
        config = "\n".join(
            [
                f"export DESIGN_NAME = {job.top}",
                f"export PLATFORM = {platform}",
                f"export VERILOG_FILES = {verilog}",
                f"export SDC_FILE = {run_dir / 'constraint.sdc'}",
                f"export CORE_UTILIZATION = {int(job.options.get('core_utilization', 30))}",
                f"export PLACE_DENSITY = {float(job.options.get('place_density', 0.6))}",
                "",
            ]
        )
        (run_dir / "config.mk").write_text(config)
        return ["make", "-C", str(self.flow_home()), f"DESIGN_CONFIG={run_dir / 'config.mk'}"]

    def parse_results(self, job: Job, run_dir: Path, res: ExecResult) -> AdapterOutput:
        status = self.classify_exit_status(res)
        flow = self.flow_home()
        gds = flow / "results" / job.options["platform"] / job.top / "base" / "6_final.gds" if flow else None
        findings: list[Finding] = []
        if status == StageStatus.PASS and not (gds and gds.exists()):
            status = StageStatus.ERROR
            findings.append(Finding(severity="error", code="NO_GDS", message="flow exited 0 but no final GDS was found", tool=self.tool))
        return AdapterOutput(step=self.step(res, status), findings=findings, extra={"metrics": {"gds_present": bool(gds and gds.exists())}})


def blocked_output(tool: str, status: StageStatus) -> AdapterOutput:
    from ..models import StepResult

    return AdapterOutput(
        step=StepResult(tool=tool, version=None, command=[], exit_code=None, status=status, duration_s=0.0, stdout="", stderr=""),
    )

