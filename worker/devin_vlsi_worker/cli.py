"""Command line: ``devin-vlsi-worker preflight`` / ``devin-vlsi-worker run job.json``."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .jobs import run_job
from .models import Job
from .preflight import capability_profile


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="devin-vlsi-worker")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("preflight", help="print the toolchain capability profile as JSON")
    run = sub.add_parser("run", help="run one stage job (JSON file or '-' for stdin) and print the result JSON")
    run.add_argument("job")
    run.add_argument("--keep", type=Path, help="copy the run directory here for inspection")
    serve = sub.add_parser("serve", help="start the HTTP API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8090)
    args = parser.parse_args(argv)

    if args.cmd == "preflight":
        print(json.dumps(capability_profile(), indent=2))
        return 0
    if args.cmd == "run":
        raw = sys.stdin.read() if args.job == "-" else Path(args.job).read_text()
        result = run_job(Job.model_validate_json(raw), keep_dir=args.keep)
        print(result.model_dump_json(indent=2))
        return 0
    if args.cmd == "serve":
        import uvicorn

        uvicorn.run("devin_vlsi_worker.api:app", host=args.host, port=args.port)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
