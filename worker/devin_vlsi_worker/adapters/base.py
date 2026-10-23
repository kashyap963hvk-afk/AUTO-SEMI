"""ToolAdapter contract (spec section 19).

An adapter owns one tool invocation pattern. Outcome classification uses exit
codes, structured reports and artifact presence only, never model prose.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

from .. import sandbox
from ..models import Finding, Job, StageStatus, StepResult


@dataclass
class Capability:
    tool: str
    available: bool
    version: str | None
    path: str | None
    notes: list[str] = field(default_factory=list)


@dataclass
class AdapterOutput:
    step: StepResult
    findings: list[Finding] = field(default_factory=list)
    extra: dict = field(default_factory=dict)


class ToolAdapter(ABC):
    tool: str = ""
    executable: str = ""
    version_args: tuple[str, ...] = ("--version",)
    version_pattern: str = r"(\d+\.\d+(?:\.\d+)?)"

    def tool_version(self) -> str | None:
        path = sandbox.which(self.executable)
        if not path:
            return None
        res = sandbox.run(
            [path, *self.version_args], cwd=Path("/tmp"), timeout_s=20, memory_mb=1024, max_output_bytes=10_000
        )
        match = re.search(self.version_pattern, res.stdout + res.stderr)
        return match.group(1) if match else None

    def probe_capabilities(self) -> Capability:
        path = sandbox.which(self.executable)
        version = self.tool_version() if path else None
        return Capability(tool=self.tool, available=bool(path and version), version=version, path=path)

    def validate_inputs(self, job: Job) -> None:
        missing = [f for f in job.filelist if f not in job.files]
        if missing:
            raise ValueError(f"filelist references files that were not provided: {missing}")

    @abstractmethod
    def build_command(self, job: Job, run_dir: Path) -> list[str]: ...

    def execute(self, job: Job, run_dir: Path, command: list[str], extra_env: dict[str, str] | None = None) -> sandbox.ExecResult:
        return sandbox.run(
            command,
            cwd=run_dir,
            timeout_s=job.limits.timeout_s,
            memory_mb=job.limits.memory_mb,
            max_output_bytes=job.limits.max_output_bytes,
            extra_env=extra_env,
        )

    def classify_exit_status(self, res: sandbox.ExecResult) -> StageStatus:
        if res.timed_out:
            return StageStatus.TIMEOUT
        return StageStatus.PASS if res.exit_code == 0 else StageStatus.FAIL

    @abstractmethod
    def parse_results(self, job: Job, run_dir: Path, res: sandbox.ExecResult) -> AdapterOutput: ...

    def collect_artifacts(self, job: Job, run_dir: Path) -> list[Path]:
        return []

    def run(self, job: Job, run_dir: Path, version: str | None) -> AdapterOutput:
        self.validate_inputs(job)
        command = self.build_command(job, run_dir)
        res = self.execute(job, run_dir, command, self.extra_env(job))
        out = self.parse_results(job, run_dir, res)
        out.step.version = version
        return out

    def extra_env(self, job: Job) -> dict[str, str] | None:
        return None

    def step(self, res: sandbox.ExecResult, status: StageStatus) -> StepResult:
        return StepResult(
            tool=self.tool,
            version=None,
            command=res.command,
            exit_code=res.exit_code,
            status=status,
            duration_s=res.duration_s,
            stdout=res.stdout,
            stderr=res.stderr,
            truncated=res.truncated,
        )
