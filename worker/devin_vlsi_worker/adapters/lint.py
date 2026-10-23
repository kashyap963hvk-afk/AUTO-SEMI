"""RTL lint and elaboration adapters: Verilator --lint-only and Yosys elaboration checks."""

from __future__ import annotations

import re
from pathlib import Path

from ..models import Finding, Job, StageStatus
from ..sandbox import ExecResult
from .base import AdapterOutput, ToolAdapter

_VERILATOR_MSG = re.compile(
    r"^%(?P<sev>Warning|Error)(?:-(?P<code>[A-Z0-9_]+))?:\s*(?:(?P<file>[^:\s]+):(?P<line>\d+):(?:\d+:)?)?\s*(?P<msg>.*)$"
)


def include_dirs(job: Job) -> list[str]:
    dirs = job.options.get("include_dirs", [])
    for d in dirs:
        if not isinstance(d, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}", d) or ".." in d:
            raise ValueError(f"invalid include dir {d!r}")
    return list(dirs)


def waived(job: Job, finding: Finding) -> bool:
    for waiver in job.options.get("waivers", []):
        if waiver.get("tool") == finding.tool and waiver.get("code") == finding.code and waiver.get("reason") and waiver.get("approved_by"):
            if waiver.get("file") in (None, finding.file):
                return True
    return False


class VerilatorLint(ToolAdapter):
    tool = "verilator"
    executable = "verilator"

    def build_command(self, job: Job, run_dir: Path) -> list[str]:
        cmd = ["verilator", "--lint-only", "-Wall", "--top-module", job.top]
        cmd += [f"-I{d}" for d in include_dirs(job)]
        cmd += [f"-G{k}={v}" for k, v in sorted(job.parameters.items())]
        return cmd + list(job.filelist)

    def parse_results(self, job: Job, run_dir: Path, res: ExecResult) -> AdapterOutput:
        findings: list[Finding] = []
        for line in (res.stderr + "\n" + res.stdout).splitlines():
            m = _VERILATOR_MSG.match(line.strip())
            if not m or m.group("msg").startswith("Exiting due to"):
                continue
            sev = "error" if m.group("sev") == "Error" else "warning"
            findings.append(
                Finding(
                    severity=sev,
                    code=m.group("code") or ("ERROR" if sev == "error" else "WARNING"),
                    message=m.group("msg"),
                    tool=self.tool,
                    file=m.group("file"),
                    line=int(m.group("line")) if m.group("line") else None,
                )
            )
        status = self.classify_exit_status(res)
        blocking = [f for f in findings if not waived(job, f)]
        if status == StageStatus.PASS and blocking:
            status = StageStatus.FAIL  # warning policy: unwaived -Wall warnings block
        return AdapterOutput(step=self.step(res, status), findings=findings)


class YosysElaborate(ToolAdapter):
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
        script = f"{reads}; {chparam}hierarchy -check -top {job.top}; proc; check -assert"
        return ["yosys", "-q", "-l", "yosys_elab.log", "-p", script]

    def parse_results(self, job: Job, run_dir: Path, res: ExecResult) -> AdapterOutput:
        findings: list[Finding] = []
        log = (run_dir / "yosys_elab.log").read_text(errors="replace") if (run_dir / "yosys_elab.log").exists() else ""
        for line in (log + "\n" + res.stderr).splitlines():
            line = line.strip()
            if line.startswith("ERROR:"):
                findings.append(Finding(severity="error", code="YOSYS_ERROR", message=line[6:].strip(), tool=self.tool))
            elif line.startswith("Warning:"):
                findings.append(Finding(severity="warning", code="YOSYS_WARNING", message=line[8:].strip(), tool=self.tool))
        uniq = {(f.severity, f.message): f for f in findings}
        findings = list(uniq.values())
        status = self.classify_exit_status(res)
        if status == StageStatus.PASS and any(not waived(job, f) for f in findings):
            status = StageStatus.FAIL
        return AdapterOutput(step=self.step(res, status), findings=findings)
