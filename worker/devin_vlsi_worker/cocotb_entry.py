"""Subprocess entry point that drives the cocotb runner inside the sandbox.

Invoked as ``python3 -m devin_vlsi_worker.cocotb_entry sim_config.json`` with
the run directory as the working directory. The worker parses the JUnit file
cocotb writes; this script's own exit status is informational only.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    cfg = json.loads(Path(sys.argv[1]).read_text())
    from cocotb_tools.runner import get_runner

    runner = get_runner(cfg["simulator"])
    build_dir = Path(cfg["build_dir"]).resolve()
    runner.build(
        sources=[Path(s).resolve() for s in cfg["sources"]],
        hdl_toplevel=cfg["top"],
        parameters=cfg["parameters"],
        includes=[Path(d).resolve() for d in cfg.get("include_dirs", [])],
        build_dir=build_dir,
        always=True,
        timescale=("1ns", "1ps"),
    )
    results = runner.test(
        hdl_toplevel=cfg["top"],
        test_module=cfg["test_module"],
        test_dir=Path(cfg["test_dir"]).resolve(),
        build_dir=build_dir,
        results_xml=str(Path(cfg["results_xml"]).resolve()),
        extra_env=cfg["extra_env"],
        seed=cfg["seed"],
    )
    print(f"cocotb results file: {results}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
