"""Adapter parsing and safety tests that need no EDA tools."""

from pathlib import Path

import pytest

from devin_vlsi_worker import sandbox
from devin_vlsi_worker.adapters.formal import requirement_map
from devin_vlsi_worker.adapters.simulation import parse_covers, parse_junit
from devin_vlsi_worker.adapters.synthesis import parse_stat
from devin_vlsi_worker.hashing import canonical_json, job_input_hash
from devin_vlsi_worker.models import Job, validate_relative_path

FIX = Path(__file__).parent / "fixtures"
ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("bad", ["/etc/passwd", "../x.sv", "rtl/../../x", "rtl//a.sv", "C:\\a.sv", "a b.sv", "rtl/./a.sv", ""])
def test_rejects_unsafe_paths(bad):
    with pytest.raises(ValueError):
        validate_relative_path(bad)


def test_accepts_normal_paths():
    validate_relative_path("rtl/sync_fifo.sv")
    validate_relative_path("verification/cocotb/test_sync_fifo.py")


def test_job_rejects_traversal_in_files():
    with pytest.raises(ValueError):
        Job(job_id="x", stage="lint", top="t", files={"../evil.sv": ""}, filelist=[])


def test_job_rejects_bad_top_and_params():
    with pytest.raises(ValueError):
        Job(job_id="x", stage="lint", top="t; rm -rf /", files={}, filelist=[])
    with pytest.raises(ValueError):
        Job(job_id="x", stage="lint", top="t", parameters={"A;B": 1}, files={}, filelist=[])


def test_sandbox_allowlist():
    with pytest.raises(PermissionError):
        sandbox.run(["bash", "-c", "echo hi"], cwd=Path("/tmp"), timeout_s=5, memory_mb=256, max_output_bytes=1000)
    with pytest.raises(TypeError):
        sandbox.run("yosys -V", cwd=Path("/tmp"), timeout_s=5, memory_mb=256, max_output_bytes=1000)  # type: ignore[arg-type]


def test_sandbox_scrubs_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak-1234567890")
    script = tmp_path / "env_dump.py"
    script.write_text("import os; print(sorted(os.environ))")
    res = sandbox.run(["python3", str(script)], cwd=tmp_path, timeout_s=20, memory_mb=512, max_output_bytes=10_000)
    assert "ANTHROPIC_API_KEY" not in res.stdout
    assert res.exit_code == 0


def test_sandbox_timeout_kills(tmp_path):
    script = tmp_path / "spin.py"
    script.write_text("while True: pass")
    res = sandbox.run(["python3", str(script)], cwd=tmp_path, timeout_s=1, memory_mb=256, max_output_bytes=1000)
    assert res.timed_out and res.exit_code is None


def test_redaction():
    out = sandbox.redact("api_key=abc123 Authorization: Bearer abcdefghijkl sk-ABCDEFGHIJKLMNOPQRST")
    assert "abc123" not in out and "abcdefghijkl" not in out and "sk-ABCDEFGHIJKLMNOPQRST" not in out


def test_canonical_hash_matches_web_fixture():
    # Mirrors apps/web/src/lib/__tests__/hash.test.ts; both sides must agree byte for byte.
    value = {"b": [1, {"z": "é", "a": True}], "a": None}
    assert canonical_json(value) == '{"a":null,"b":[1,{"a":true,"z":"é"}]}'
    job = {"schema_version": "1.0", "stage": "lint", "top": "t", "parameters": {}, "files": {}, "filelist": [], "options": {}, "job_id": "ignored"}
    assert job_input_hash(job) == job_input_hash({**job, "job_id": "other"})


def test_parse_stat_fixture():
    m = parse_stat((FIX / "yosys_stat.txt").read_text())
    assert m["cells_total"] == 353
    assert m["latches"] == 0
    assert m["sequential_cells"] == 145
    assert m["cell_types"]["$_DFFE_PP_"] == 128


def test_parse_junit_failure():
    xml = """<testsuites><testsuite name="t"><testcase name="test_sync_fifo.test_a" time="0.1"/>
    <testcase name="test_sync_fifo.test_b" time="0.2"><failure message="full=1 but model holds 15 of 16 items"/></testcase>
    </testsuite></testsuites>"""
    rows = parse_junit(xml)
    assert rows[0][:2] == ("test_sync_fifo.test_a", "PASS")
    assert rows[1][1] == "FAIL" and "15 of 16" in rows[1][3]


def test_parse_covers_from_real_test_file():
    src = (ROOT / "designs/sync_fifo/verification/cocotb/test_sync_fifo.py").read_text()
    covers = parse_covers(src)
    assert covers["test_reset_state"] == ["REQ-RST-001", "REQ-FUNC-002"]
    assert "REQ-FUNC-005" in covers["test_simultaneous_read_write"]
    assert len(covers) == 7


def test_requirement_map_from_props():
    src = (ROOT / "designs/sync_fifo/reference/sync_fifo_props.svh").read_text()
    req = requirement_map(src)
    flags_line = next(i for i, l in enumerate(src.splitlines(), 1) if "assert (full" in l)
    assert "REQ-FUNC-003" in req[flags_line]


def test_sby_counterexample_log_patterns():
    from devin_vlsi_worker.adapters.formal import _DONE, _FAILED

    log = (FIX / "sby_main_counterexample.log").read_text()
    assert _DONE.findall(log)[-1][0] == "FAIL"
    assert _FAILED.search(log).group("step") == "16"
