"""SymbiYosys formal adapter.

Runs three SymbiYosys jobs in sequence within the job's time budget:
  1. cover   (smtbmc): reachability checks so a proof cannot be vacuous;
  2. main    (smtbmc, k-induction): fast proof, and a replayable counterexample trace;
  3. pdr     (abc pdr / IC3): only if step 2 is inconclusive or times out.
Every step is recorded. The engine that produced the verdict is reported.

Status mapping is explicit so a bounded result can never be shown as a proof:
  prove PASS by k-induction or PDR -> PROVED
  bmc mode PASS                    -> BOUNDED_PASS_ONLY
  FAIL with a failed assertion     -> COUNTEREXAMPLE_FOUND
  inconclusive                     -> UNKNOWN
  time budget exhausted            -> TIMEOUT
"""

from __future__ import annotations

import re
import time
from pathlib import Path

from .. import sandbox
from ..models import Finding, FormalStatus, Job, PropertyResult, StageStatus, StepResult
from ..sandbox import ExecResult
from .base import AdapterOutput, ToolAdapter

ENGINES = {"z3": "smtbmc z3", "z3_unroll": "smtbmc --unroll z3", "boolector": "smtbmc boolector", "yices": "smtbmc yices"}
FALLBACKS = {"abc_pdr": "abc pdr"}
_FAILED = re.compile(r"failed assertion \S+ at (?P<file>[^:\s]+):(?P<line>\d+)\.\S+ in step (?P<step>\d+)")
_REACHED = re.compile(r"reached cover statement \S+ at (?P<file>[^:\s]+):(?P<line>\d+)\.\S+ in step (?P<step>\d+)")
_UNREACHED = re.compile(r"^\s*\S+\$cover\S* at (?P<file>[^:\s]+):(?P<line>\d+)\.")
_DONE = re.compile(r"DONE \((?P<status>[A-Z]+), rc=(?P<rc>\d+)\)")
_RETURNED = re.compile(r"summary: engine_\d+ \((?P<engine>[^)]+)\) returned (?P<status>[A-Za-z]+)")
_REQ = re.compile(r"REQ-[A-Z]+-\d{3}")


def requirement_map(props_source: str) -> dict[int, list[str]]:
    """Line number -> requirement IDs from the closest preceding comment that names them."""
    current: list[str] = []
    out: dict[int, list[str]] = {}
    for lineno, line in enumerate(props_source.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("//"):
            ids = _REQ.findall(stripped)
            if ids:
                current = ids
        out[lineno] = list(current)
    return out


def _log(run_dir: Path, name: str) -> str:
    log = run_dir / name / "logfile.txt"
    return log.read_text(errors="replace") if log.exists() else ""


def _done(log: str) -> str | None:
    found = _DONE.findall(log)
    return found[-1][0] if found else None


class SbyFormal(ToolAdapter):
    tool = "symbiyosys"
    executable = "sby"
    version_args = ("--help",)

    def tool_version(self) -> str | None:
        from .synthesis import YosysSynth

        if not sandbox.which("sby"):
            return None
        yv = YosysSynth().tool_version()
        return f"sby (yosys {yv})" if yv else "sby"

    def validate_inputs(self, job: Job) -> None:
        super().validate_inputs(job)
        if job.options.get("formal_mode", "prove") not in ("prove", "bmc"):
            raise ValueError("formal_mode must be 'prove' or 'bmc'")
        if job.options.get("formal_engine", "z3") not in ENGINES:
            raise ValueError(f"formal_engine must be one of {sorted(ENGINES)}")
        if job.options.get("fallback_engine") not in (None, *FALLBACKS):
            raise ValueError(f"fallback_engine must be one of {sorted(FALLBACKS)}")
        depth = int(job.options.get("formal_depth", 20))
        if not 1 <= depth <= 200:
            raise ValueError("formal_depth must be within 1..200")

    def _sby(self, job: Job, mode: str, depth: int, engine: str) -> str:
        sets = " ".join(f"-set {k} {v}" for k, v in sorted(job.parameters.items()))
        # SBY copies [files] into src/ flat, so includes resolve by basename.
        reads = "\n".join(f"read_verilog -sv -formal -DFORMAL {Path(f).name}" for f in job.filelist)
        chparam = f"chparam {sets} {job.top}" if sets else ""
        files = "\n".join(sorted(job.files))
        return f"[options]\nmode {mode}\ndepth {depth}\n\n[engines]\n{engine}\n\n[script]\n{reads}\n{chparam}\nprep -top {job.top}\n\n[files]\n{files}\n"

    def build_command(self, job: Job, run_dir: Path) -> list[str]:
        return ["sby", "-f", "job_main.sby"]

    def _exec(self, job: Job, run_dir: Path, name: str, timeout_s: int) -> ExecResult:
        return sandbox.run(
            ["sby", "-f", f"{name}.sby"],
            cwd=run_dir,
            timeout_s=max(timeout_s, 5),
            memory_mb=job.limits.memory_mb,
            max_output_bytes=job.limits.max_output_bytes,
        )

    def _step(self, res: ExecResult, log: str, status: StageStatus, label: str) -> StepResult:
        step = self.step(res, status)
        step.tool = f"symbiyosys:{label}"
        step.stdout = (step.stdout + f"\n--- {label} log ---\n" + log[-40_000:]).strip()
        return step

    def run(self, job: Job, run_dir: Path, version: str | None) -> AdapterOutput:
        self.validate_inputs(job)
        mode = job.options.get("formal_mode", "prove")
        depth = int(job.options.get("formal_depth", 20))
        cover_depth = int(job.options.get("cover_depth", 24))
        engine = ENGINES[job.options.get("formal_engine", "z3")]
        fallback = job.options.get("fallback_engine")
        primary_share = float(job.options.get("primary_time_share", 0.5 if fallback else 1.0))
        budget = job.limits.timeout_s
        started = time.monotonic()
        remaining = lambda: int(budget - (time.monotonic() - started))  # noqa: E731

        props_file = next((f for f in job.files if f.endswith(".svh") or "props" in f), None)
        req_map = requirement_map(job.files[props_file]) if props_file else {}
        steps: list[StepResult] = []
        findings: list[Finding] = []
        properties: list[PropertyResult] = []

        # 1. cover
        (run_dir / "job_cover.sby").write_text(self._sby(job, "cover", cover_depth, engine))
        res_c = self._exec(job, run_dir, "job_cover", min(remaining(), max(30, budget // 3)))
        cover_log = _log(run_dir, "job_cover")
        cover_status = "TIMEOUT" if res_c.timed_out else _done(cover_log)
        steps.append(self._step(res_c, cover_log, StageStatus.PASS if cover_status == "PASS" else StageStatus.TIMEOUT if res_c.timed_out else StageStatus.FAIL, "cover"))
        for m in _REACHED.finditer(cover_log):
            line = int(m.group("line"))
            properties.append(PropertyResult(kind="cover", location=f"{m.group('file')}:{line}", status="REACHED", step=int(m.group("step")), covers=req_map.get(line, [])))
        in_unreached = False
        for raw in cover_log.splitlines():
            text = raw.split("summary:", 1)[-1] if "summary:" in raw else raw
            if "unreached cover statements" in text:
                in_unreached = True
                continue
            if in_unreached:
                m = _UNREACHED.match(text)
                if m:
                    line = int(m.group("line"))
                    properties.append(PropertyResult(kind="cover", location=f"{m.group('file')}:{line}", status="UNREACHED", covers=req_map.get(line, [])))
                    findings.append(Finding(severity="warning", code="COVER_UNREACHED", message=f"cover at {m.group('file')}:{line} unreachable within depth {cover_depth} (properties may be vacuous)", tool=self.tool))
                else:
                    in_unreached = False

        # 2. main proof / bmc
        (run_dir / "job_main.sby").write_text(self._sby(job, mode, depth, engine))
        res_m = self._exec(job, run_dir, "job_main", min(remaining(), int(budget * primary_share)))
        main_log = _log(run_dir, "job_main")
        main_status = "TIMEOUT" if res_m.timed_out else _done(main_log)
        verdict_engine = engine
        fstatus = self._classify(mode, main_status, main_log, engine)
        for m in _FAILED.finditer(main_log):
            line = int(m.group("line"))
            loc = f"{m.group('file')}:{line}"
            if any(p.location == loc for p in properties):
                continue
            properties.append(PropertyResult(kind="assert", location=loc, status="FAIL", step=int(m.group("step")), covers=req_map.get(line, [])))
            findings.append(Finding(severity="error", code="ASSERTION_FAILED", message=f"assertion at {loc} fails in step {m.group('step')}", tool=self.tool, file=m.group("file"), line=line))
        if fstatus == FormalStatus.COUNTEREXAMPLE_FOUND and not any(p.status == "FAIL" for p in properties):
            fstatus = FormalStatus.UNKNOWN
        steps.append(self._step(res_m, main_log, {FormalStatus.PROVED: StageStatus.PASS, FormalStatus.BOUNDED_PASS_ONLY: StageStatus.PASS, FormalStatus.TIMEOUT: StageStatus.TIMEOUT}.get(fstatus, StageStatus.FAIL), f"{mode}:{engine}"))

        # 3. fallback engine for an unbounded proof
        if mode == "prove" and fallback and fstatus in (FormalStatus.TIMEOUT, FormalStatus.UNKNOWN) and remaining() > 10:
            fb = FALLBACKS[fallback]
            (run_dir / "job_pdr.sby").write_text(self._sby(job, "prove", depth, fb))
            res_p = self._exec(job, run_dir, "job_pdr", remaining())
            pdr_log = _log(run_dir, "job_pdr")
            returned = _RETURNED.findall(pdr_log)
            eng_status = returned[-1][1].upper() if returned else None
            if res_p.timed_out:
                fstatus = FormalStatus.TIMEOUT
            elif eng_status == "PASS":
                fstatus = FormalStatus.PROVED
                verdict_engine = fb
            elif eng_status == "FAIL":
                fstatus = FormalStatus.COUNTEREXAMPLE_FOUND
                verdict_engine = fb
                findings.append(Finding(severity="error", code="ASSERTION_FAILED", message=f"{fb} found a counterexample; trace replay is unavailable on this worker", tool=self.tool))
                properties.append(PropertyResult(kind="assert", location="(reported by abc pdr)", status="FAIL"))
            steps.append(self._step(res_p, pdr_log, StageStatus.PASS if fstatus == FormalStatus.PROVED else StageStatus.TIMEOUT if res_p.timed_out else StageStatus.FAIL, f"prove:{fb}"))

        if fstatus in (FormalStatus.PROVED, FormalStatus.BOUNDED_PASS_ONLY) and cover_status == "PASS":
            status = StageStatus.PASS
        elif fstatus == FormalStatus.TIMEOUT:
            status = StageStatus.TIMEOUT
        elif fstatus == FormalStatus.NOT_RUN:
            status = StageStatus.ERROR
            findings.append(Finding(severity="error", code="SBY_ERROR", message="SymbiYosys did not produce a status; see log", tool=self.tool))
        else:
            status = StageStatus.FAIL
        if fstatus == FormalStatus.PROVED and cover_status != "PASS":
            findings.append(Finding(severity="error", code="COVER_FAILED", message="proof passed but cover checks did not; the proof may be vacuous", tool=self.tool))
        for s in steps:
            s.version = version
        return AdapterOutput(
            step=steps[0],
            findings=findings,
            extra={
                "steps": steps,
                "properties": properties,
                "formal_status": fstatus,
                "metrics": {"mode": mode, "depth": depth, "cover_depth": cover_depth, "engine": engine, "verdict_engine": verdict_engine, "main_task": main_status, "cover_task": cover_status},
            },
        )

    @staticmethod
    def _classify(mode: str, status: str | None, log: str, engine: str) -> FormalStatus:
        if status == "TIMEOUT":
            return FormalStatus.TIMEOUT
        if status == "PASS" and mode == "prove" and "successful proof by k-induction" in log:
            return FormalStatus.PROVED
        if status == "PASS" and mode == "bmc":
            return FormalStatus.BOUNDED_PASS_ONLY
        if status == "FAIL":
            return FormalStatus.COUNTEREXAMPLE_FOUND
        if status in ("UNKNOWN", "PASS", "ERROR"):
            return FormalStatus.UNKNOWN
        return FormalStatus.NOT_RUN

    def parse_results(self, job: Job, run_dir: Path, res: ExecResult) -> AdapterOutput:  # pragma: no cover - run() is overridden
        raise NotImplementedError

    def collect_artifacts(self, job: Job, run_dir: Path) -> list[Path]:
        return sorted(run_dir.glob("job_*/engine_*/*.vcd"))
