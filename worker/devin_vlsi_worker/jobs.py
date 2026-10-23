"""Stage execution: materialise inputs, run adapters, write run records."""

from __future__ import annotations

import hashlib
import json
import platform
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .adapters.base import AdapterOutput, ToolAdapter
from .adapters.formal import SbyFormal
from .adapters.lint import VerilatorLint, YosysElaborate
from .adapters.physical import OrfsPhysical, blocked_output
from .adapters.simulation import CocotbIcarus
from .adapters.synthesis import YosysSynth
from .hashing import job_input_hash
from .models import Artifact, Finding, Job, StageResult, StageStatus

STAGE_ADAPTERS: dict[str, list[type[ToolAdapter]]] = {
    "lint": [VerilatorLint, YosysElaborate],
    "simulation": [CocotbIcarus],
    "formal": [SbyFormal],
    "synthesis": [YosysSynth],
    "physical": [OrfsPhysical],
}

STAGE_LIMITATIONS = {
    "lint": ["Lint covers the configured Verilator -Wall and Yosys check policies only; it does not prove functional correctness."],
    "simulation": [
        "Simulation covers only the listed tests and seed; it is not exhaustive.",
        "Code/functional coverage collection is not enabled on this path; no coverage figures are reported.",
        "Waveforms are not captured for passing or failing tests on this path.",
    ],
    "formal": [
        "Results hold only under the stated assumptions (reset in the first cycle) and the formal engine's limits.",
        "Cover (vacuity) checks run to a bounded depth; for DEPTH > 16 they target 16 stored items, and full-flag reachability is shown by simulation.",
    ],
    "synthesis": ["Generic Yosys gates without a Liberty file: cell counts are estimates, not silicon area, timing or power."],
    "physical": ["ORFS execution path has not been run against a real ORFS installation in this repository's environments."],
}

MAX_ARTIFACT_INLINE = 256_000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _versions(adapters: list[ToolAdapter]) -> dict[str, str | None]:
    return {a.tool: a.tool_version() for a in adapters}


def _materialise(job: Job, run_dir: Path) -> None:
    for rel, content in job.files.items():
        target = (run_dir / rel).resolve()
        if run_dir.resolve() not in target.parents:
            raise ValueError(f"refusing to write outside the run directory: {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)


def _artifact(path: Path, run_dir: Path, inline: bool) -> Artifact:
    data = path.read_bytes()
    text = None
    if inline and len(data) <= MAX_ARTIFACT_INLINE:
        text = data.decode("utf-8", errors="replace")
    return Artifact(path=str(path.relative_to(run_dir)), sha256=hashlib.sha256(data).hexdigest(), size=len(data), content=text)


def summarise(stage: str, status: StageStatus, outputs: list[AdapterOutput], result: StageResult) -> str:
    if status in (StageStatus.BLOCKED_TOOL_UNAVAILABLE, StageStatus.BLOCKED_MISSING_CONSTRAINTS, StageStatus.BLOCKED_UNSUPPORTED_FEATURE):
        return f"{stage} blocked: " + "; ".join(f.message for f in result.findings if f.severity == "error")[:300]
    if stage == "simulation" and result.tests:
        passed = sum(t.status == "PASS" for t in result.tests)
        return f"{passed}/{len(result.tests)} tests passed"
    if stage == "formal" and result.formal_status:
        failed = sum(p.status == "FAIL" for p in result.properties)
        cover = result.metrics.get("cover_task")
        cover_note = "" if cover in (None, "PASS") else f"; cover/vacuity checks {cover}, so the result is incomplete"
        return f"formal: {result.formal_status.value}" + (f" ({failed} failing assertion(s))" if failed else "") + cover_note
    if stage == "synthesis" and result.metrics.get("cells_total") is not None:
        return f"synthesised: {result.metrics['cells_total']} generic cells, {result.metrics.get('sequential_cells')} sequential, {result.metrics.get('latches')} latches"
    errors = sum(f.severity == "error" for f in result.findings)
    warnings = sum(f.severity == "warning" for f in result.findings)
    return f"{stage}: {status.value} ({errors} error(s), {warnings} warning(s))"


def run_job(job: Job, keep_dir: Path | None = None) -> StageResult:
    started = _now()
    adapters = [cls() for cls in STAGE_ADAPTERS[job.stage]]
    versions = _versions(adapters)
    workdir = Path(tempfile.mkdtemp(prefix=f"run-{job.job_id}-"))
    run_dir = workdir / "run"
    run_dir.mkdir()
    outputs: list[AdapterOutput] = []
    findings: list[Finding] = []
    status = StageStatus.PASS
    try:
        _materialise(job, run_dir)
        for adapter in adapters:
            if isinstance(adapter, OrfsPhysical):
                blocked = adapter.preflight(job)
                if blocked:
                    status, pre_findings = blocked
                    findings += pre_findings
                    outputs.append(blocked_output(adapter.tool, status))
                    break
            if not versions.get(adapter.tool):
                status = StageStatus.BLOCKED_TOOL_UNAVAILABLE
                findings.append(Finding(severity="error", code="TOOL_UNAVAILABLE", message=f"{adapter.tool} is not installed on this worker", tool=adapter.tool))
                outputs.append(blocked_output(adapter.tool, status))
                break
            out = adapter.run(job, run_dir, versions[adapter.tool])
            outputs.append(out)
            findings += out.findings
            if out.step.status != StageStatus.PASS and status == StageStatus.PASS:
                status = out.step.status
        result = StageResult(
            job_id=job.job_id,
            stage=job.stage,
            status=status,
            summary="",
            input_hash=job_input_hash(job.model_dump(mode="json")),
            started_at=started,
            finished_at=_now(),
            duration_s=round(sum(s.duration_s for o in outputs for s in o.extra.get("steps", [o.step])), 3),
            execution={
                "mode": "live-worker",
                "worker_version": __version__,
                "host_os": f"{platform.system()} {platform.release()}",
                "python": platform.python_version(),
                "tool_versions": versions,
            },
            steps=[s for o in outputs for s in o.extra.get("steps", [o.step])],
            findings=findings,
            limitations=list(STAGE_LIMITATIONS[job.stage]),
        )
        for o in outputs:
            result.tests += o.extra.get("tests", [])
            result.properties += o.extra.get("properties", [])
            result.metrics.update(o.extra.get("metrics", {}))
            if o.extra.get("formal_status"):
                result.formal_status = o.extra["formal_status"]
        for adapter in adapters:
            for path in adapter.collect_artifacts(job, run_dir):
                result.artifacts.append(_artifact(path, run_dir, inline=True))
        if job.stage == "formal" and result.formal_status is None:
            from .models import FormalStatus

            result.formal_status = FormalStatus.NOT_RUN
        result.summary = summarise(job.stage, status, outputs, result)
        _write_run_record(job, result, run_dir)
        if keep_dir:
            shutil.copytree(run_dir, keep_dir, dirs_exist_ok=True)
        return result
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _write_run_record(job: Job, result: StageResult, run_dir: Path) -> None:
    record = run_dir / "_record"
    record.mkdir(exist_ok=True)
    (record / "command.json").write_text(json.dumps([s.command for s in result.steps], indent=2))
    (record / "environment.json").write_text(json.dumps(result.execution, indent=2))
    (record / "result.json").write_text(result.model_dump_json(indent=2))
