"""cocotb regression adapter (default simulator: Icarus Verilog).

Verilator is used for lint only: cocotb 2.x requires Verilator >= 5.036, and
the preflight reports when the installed Verilator is older.
"""

from __future__ import annotations

import ast
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from ..models import Finding, Job, StageStatus, TestCaseResult
from ..sandbox import ExecResult
from .base import AdapterOutput, Capability, ToolAdapter
from .lint import include_dirs

_COVERS = re.compile(r"Covers:\s*([A-Z0-9, -]+)")


def parse_covers(test_source: str) -> dict[str, list[str]]:
    """Map test function name -> requirement IDs from 'Covers:' docstring lines."""
    covers: dict[str, list[str]] = {}
    tree = ast.parse(test_source)
    for node in tree.body:
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name.startswith("test_"):
            doc = ast.get_docstring(node) or ""
            m = _COVERS.search(doc)
            covers[node.name] = [r.strip() for r in m.group(1).split(",") if r.strip()] if m else []
    return covers


def parse_junit(xml_text: str) -> list[tuple[str, str, float | None, str | None]]:
    out = []
    root = ET.fromstring(xml_text)
    for case in root.iter("testcase"):
        name = case.get("name", "?")
        time = float(case.get("time")) if case.get("time") else None
        status, message = "PASS", None
        for child in case:
            if child.tag == "failure":
                status, message = "FAIL", child.get("message") or (child.text or "").strip()
            elif child.tag == "error":
                status, message = "ERROR", child.get("message") or (child.text or "").strip()
            elif child.tag == "skipped":
                status, message = "SKIP", child.get("message")
        if message:
            # cocotb appends pytest-style assertion rewrites; the first line carries our message.
            message = message.strip().splitlines()[0][:500]
        out.append((name, status, time, message))
    return out


class CocotbIcarus(ToolAdapter):
    tool = "cocotb+icarus"
    executable = "iverilog"
    version_args = ("-V",)
    version_pattern = r"version\s+(\d+\.\d+)"

    def tool_version(self) -> str | None:
        iv = super().tool_version()
        try:
            import cocotb

            return f"cocotb {cocotb.__version__} / icarus {iv}" if iv else None
        except ImportError:
            return None

    def probe_capabilities(self) -> Capability:
        cap = super().probe_capabilities()
        cap.notes.append("UVM: not supported on this path (cocotb + Icarus). Use a capability-tested simulator adapter.")
        return cap

    def validate_inputs(self, job: Job) -> None:
        super().validate_inputs(job)
        test_file = job.options.get("test_file")
        if not test_file or test_file not in job.files or not test_file.endswith(".py"):
            raise ValueError("simulation job needs options.test_file naming a provided .py file")

    def build_command(self, job: Job, run_dir: Path) -> list[str]:
        test_file = Path(job.options["test_file"])
        cfg = {
            "simulator": "icarus",
            "top": job.top,
            "sources": list(job.filelist),
            "parameters": job.parameters,
            "include_dirs": include_dirs(job),
            "build_dir": "sim_build",
            "test_module": test_file.stem,
            "test_dir": str(test_file.parent),
            "results_xml": "results.xml",
            "seed": int(job.options.get("seed", 1)),
            "extra_env": {k: str(v) for k, v in job.options.get("test_env", {}).items()},
        }
        (run_dir / "sim_config.json").write_text(json.dumps(cfg, indent=2))
        return ["python3", "-m", "devin_vlsi_worker.cocotb_entry", "sim_config.json"]

    def extra_env(self, job: Job) -> dict[str, str]:
        pkg_root = str(Path(__file__).resolve().parents[2])
        return {"PYTHONPATH": pkg_root}

    def execute(self, job, run_dir, command, extra_env=None):
        # Use the worker's own interpreter (where cocotb is installed) when it is a python3 binary.
        if Path(sys.executable).name == "python3":
            command = [sys.executable, *command[1:]]
        return super().execute(job, run_dir, command, extra_env)

    def parse_results(self, job: Job, run_dir: Path, res: ExecResult) -> AdapterOutput:
        covers = parse_covers(job.files[job.options["test_file"]])
        results_xml = run_dir / "results.xml"
        tests: list[TestCaseResult] = []
        findings: list[Finding] = []
        if results_xml.exists():
            for name, status, time, message in parse_junit(results_xml.read_text(errors="replace")):
                short = name.split(".")[-1]
                tests.append(TestCaseResult(name=short, status=status, covers=covers.get(short, []), duration_s=time, message=message))
        ran = {t.name for t in tests}
        for name in covers:
            if name not in ran:
                tests.append(TestCaseResult(name=name, status="ERROR", covers=covers[name], message="test did not report a result"))
        if res.timed_out:
            status = StageStatus.TIMEOUT
        elif not tests or not results_xml.exists():
            status = StageStatus.ERROR
            findings.append(Finding(severity="error", code="NO_RESULTS", message="simulator produced no results file", tool=self.tool))
        elif all(t.status == "PASS" for t in tests):
            status = StageStatus.PASS
        else:
            status = StageStatus.FAIL
        for t in tests:
            if t.status in ("FAIL", "ERROR"):
                findings.append(Finding(severity="error", code=f"TEST_{t.status}", message=f"{t.name}: {t.message}", tool=self.tool))
        return AdapterOutput(step=self.step(res, status), findings=findings, extra={"tests": tests})
