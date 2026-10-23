"""Bounded subprocess execution for allowlisted EDA tools.

Commands are always argument arrays (never a shell string), run in a private
process group with CPU/memory/file-size/process limits, a wall-clock timeout,
a scrubbed environment and output truncation. This is defence in depth: the
deployment is still expected to run the worker in an unprivileged container
with no secrets mounted and restricted network access.
"""

from __future__ import annotations

import os
import re
import resource
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

ALLOWED_EXECUTABLES = frozenset(
    {"verilator", "iverilog", "vvp", "yosys", "yosys-smtbmc", "sby", "z3", "boolector", "python3", "make", "openroad", "klayout"}
)

# Environment variables that may be passed through to tools. Everything else,
# notably credentials, is dropped.
_ENV_PASSTHROUGH = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PYTHONPATH", "VIRTUAL_ENV")

_SECRET_PATTERNS = [
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._-]{8,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)(api[_-]?key|token|secret|password)(\s*[=:]\s*)(\S+)"),
]


@dataclass(frozen=True)
class ExecResult:
    command: list[str]
    exit_code: int | None
    stdout: str
    stderr: str
    duration_s: float
    timed_out: bool
    truncated: bool


def redact(text: str) -> str:
    for pattern in _SECRET_PATTERNS:
        if pattern.groups >= 3:
            text = pattern.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", text)
        else:
            text = pattern.sub("[REDACTED]", text)
    return text


def which(executable: str) -> str | None:
    if executable not in ALLOWED_EXECUTABLES:
        raise PermissionError(f"executable {executable!r} is not on the worker allowlist")
    return shutil.which(executable)


def _limits(memory_mb: int, cpu_s: int):
    def apply() -> None:
        os.setsid()
        mem = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    return apply


def run(
    command: list[str],
    *,
    cwd: Path,
    timeout_s: int,
    memory_mb: int,
    max_output_bytes: int,
    extra_env: dict[str, str] | None = None,
) -> ExecResult:
    if not command or not isinstance(command, list) or not all(isinstance(a, str) for a in command):
        raise TypeError("command must be a non-empty list of strings")
    exe = os.path.basename(command[0])
    if exe not in ALLOWED_EXECUTABLES:
        raise PermissionError(f"executable {exe!r} is not on the worker allowlist")

    env = {k: os.environ[k] for k in _ENV_PASSTHROUGH if k in os.environ}
    env["HOME"] = str(cwd)
    env["TMPDIR"] = str(cwd)
    for key, value in (extra_env or {}).items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", key):
            raise ValueError(f"invalid environment variable name {key!r}")
        env[key] = value

    started = time.monotonic()
    proc = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=_limits(memory_mb, timeout_s * 2),
    )
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, err = proc.communicate()
    duration = time.monotonic() - started

    truncated = False

    def clip(data: bytes) -> str:
        nonlocal truncated
        if len(data) > max_output_bytes:
            truncated = True
            head = data[: max_output_bytes // 2]
            tail = data[-max_output_bytes // 2 :]
            data = head + b"\n...[output truncated by worker]...\n" + tail
        return redact(data.decode("utf-8", errors="replace").replace(str(cwd), "$RUN_DIR"))

    return ExecResult(
        command=[a.replace(str(cwd), "$RUN_DIR") for a in command],
        exit_code=None if timed_out else proc.returncode,
        stdout=clip(out),
        stderr=clip(err),
        duration_s=round(duration, 3),
        timed_out=timed_out,
        truncated=truncated,
    )
