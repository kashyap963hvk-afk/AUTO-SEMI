"""Real-tool integration tests: the reference FIFO must pass and a defective
variant must be caught by simulation and by formal (spec Phase 3/4 exit criteria)."""

import json
import shutil
from pathlib import Path

import pytest

from devin_vlsi_worker.jobs import run_job
from devin_vlsi_worker.models import Job

ROOT = Path(__file__).resolve().parents[2]
DESIGN = ROOT / "designs/sync_fifo"
TOOLS = ["verilator", "iverilog", "yosys", "sby", "z3"]
pytestmark = [pytest.mark.eda, pytest.mark.skipif(any(shutil.which(t) is None for t in TOOLS), reason="EDA toolchain not installed")]

GOOD_RTL = (DESIGN / "reference/sync_fifo.sv").read_text()
BUG_RTL = GOOD_RTL.replace("assign full    = (count_q == DEPTH_C);", "assign full    = (count_q == DEPTH_C - 1);")
assert BUG_RTL != GOOD_RTL


def job(stage: str, rtl: str, **options) -> Job:
    cfg = {"WIDTH": 8, "DEPTH": 8, "RESET": "sync_active_low", "ALLOW_WRITE_WHEN_FULL_WITH_READ": True}
    defaults = {
        "lint": {"include_dirs": ["formal"]},
        "simulation": {"test_file": "verification/cocotb/test_sync_fifo.py", "seed": 7, "test_env": {"FIFO_CONFIG": json.dumps(cfg)}},
        "formal": {"formal_mode": "prove", "formal_depth": 12},
        "synthesis": {},
        "physical": {},
    }[stage]
    return Job(
        job_id=f"it-{stage}",
        stage=stage,
        top="sync_fifo",
        parameters={"WIDTH": 8, "DEPTH": 8},
        files={
            "rtl/sync_fifo.sv": rtl,
            "formal/sync_fifo_props.svh": (DESIGN / "reference/sync_fifo_props.svh").read_text(),
            "verification/cocotb/test_sync_fifo.py": (DESIGN / "verification/cocotb/test_sync_fifo.py").read_text(),
        },
        filelist=["rtl/sync_fifo.sv"],
        options={**defaults, **options},
    )


def test_reference_lint_passes():
    r = run_job(job("lint", GOOD_RTL))
    assert r.status.value == "PASS", r.findings
    assert [s.tool for s in r.steps] == ["verilator", "yosys"]


def test_malformed_rtl_fails_lint_and_keeps_log():
    r = run_job(job("lint", GOOD_RTL.replace("endmodule", "")))
    assert r.status.value == "FAIL"
    assert r.steps[0].stderr or r.steps[0].stdout
    assert any(f.severity == "error" for f in r.findings)


def test_reference_simulation_passes():
    r = run_job(job("simulation", GOOD_RTL))
    assert r.status.value == "PASS"
    assert len(r.tests) == 7 and all(t.covers for t in r.tests)


def test_defect_caught_by_simulation():
    r = run_job(job("simulation", BUG_RTL))
    assert r.status.value == "FAIL"
    assert any(t.status == "FAIL" for t in r.tests)


def test_reference_formal_proves():
    r = run_job(job("formal", GOOD_RTL))
    assert r.formal_status.value == "PROVED" and r.status.value == "PASS"
    assert any(p.kind == "cover" and p.status == "REACHED" for p in r.properties)


def test_bmc_is_bounded_not_proof():
    r = run_job(job("formal", GOOD_RTL, formal_mode="bmc"))
    assert r.formal_status.value == "BOUNDED_PASS_ONLY"


def test_defect_caught_by_formal_with_trace():
    r = run_job(job("formal", BUG_RTL))
    assert r.formal_status.value == "COUNTEREXAMPLE_FOUND" and r.status.value == "FAIL"
    failed = [p for p in r.properties if p.status == "FAIL"]
    assert failed and "REQ-FUNC-003" in failed[0].covers
    assert any(a.path.endswith(".vcd") for a in r.artifacts)


def test_synthesis_reports_cells():
    r = run_job(job("synthesis", GOOD_RTL))
    assert r.status.value == "PASS"
    assert r.metrics["cells_total"] > 0 and r.metrics["latches"] == 0
    assert any(a.path == "netlist.v" for a in r.artifacts)


def test_physical_blocked_without_constraints():
    r = run_job(job("physical", GOOD_RTL))
    assert r.status.value == "BLOCKED_MISSING_CONSTRAINTS"
    assert r.findings[0].code == "TIMING_CONSTRAINTS_INCOMPLETE"


def test_physical_blocked_without_tool():
    r = run_job(job("physical", GOOD_RTL, clock_period_ns=20, constraints_approved=True, platform="sky130hd"))
    assert r.status.value == "BLOCKED_TOOL_UNAVAILABLE"


def test_pdr_fallback_proves_hard_case():
    """32-bit async-reset FIFO: k-induction does not converge within its time share; IC3/PDR proves it."""
    rtl = GOOD_RTL.replace("always @(posedge clk) begin\n    if (!rst_n) begin", "always @(posedge clk or negedge rst_n) begin\n    if (!rst_n) begin")
    assert rtl != GOOD_RTL
    j = job("formal", rtl, fallback_engine="abc_pdr", primary_time_share=0.25, cover_depth=12)
    j = j.model_copy(update={"parameters": {"WIDTH": 32, "DEPTH": 4}, "limits": j.limits.model_copy(update={"timeout_s": 160})})
    r = run_job(j)
    assert r.formal_status.value == "PROVED", (r.summary, r.metrics)
    assert r.metrics["verdict_engine"] in ("abc pdr", "smtbmc z3")
    assert [s.tool for s in r.steps][:2] == ["symbiyosys:cover", "symbiyosys:prove:smtbmc z3"]


def test_unrolled_engine_proves_hard_case_quickly():
    rtl = GOOD_RTL.replace("always @(posedge clk) begin\n    if (!rst_n) begin", "always @(posedge clk or negedge rst_n) begin\n    if (!rst_n) begin")
    j = job("formal", rtl, formal_engine="z3_unroll", fallback_engine="abc_pdr", cover_depth=12)
    j = j.model_copy(update={"parameters": {"WIDTH": 32, "DEPTH": 4}})
    r = run_job(j)
    assert r.status.value == "PASS" and r.formal_status.value == "PROVED", r.summary
    assert r.metrics["verdict_engine"] == "smtbmc --unroll z3"
