"""Typed job and result contracts shared with the web application.

The JSON shapes here are mirrored by apps/web/src/lib/eda/contracts.ts. Bump
SCHEMA_VERSION on any incompatible change.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

SCHEMA_VERSION = "1.0"

Stage = Literal["lint", "simulation", "formal", "synthesis", "physical"]


class StageStatus(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    ERROR = "ERROR"
    TIMEOUT = "TIMEOUT"
    NOT_RUN = "NOT_RUN"
    BLOCKED_TOOL_UNAVAILABLE = "BLOCKED_TOOL_UNAVAILABLE"
    BLOCKED_MISSING_CONSTRAINTS = "BLOCKED_MISSING_CONSTRAINTS"
    BLOCKED_UNSUPPORTED_FEATURE = "BLOCKED_UNSUPPORTED_FEATURE"


class FormalStatus(str, Enum):
    PROVED = "PROVED"
    COUNTEREXAMPLE_FOUND = "COUNTEREXAMPLE_FOUND"
    BOUNDED_PASS_ONLY = "BOUNDED_PASS_ONLY"
    UNKNOWN = "UNKNOWN"
    TIMEOUT = "TIMEOUT"
    NOT_RUN = "NOT_RUN"


class Limits(BaseModel):
    timeout_s: int = Field(default=300, ge=1, le=3600)
    memory_mb: int = Field(default=2048, ge=128, le=32768)
    max_output_bytes: int = Field(default=200_000, ge=1_000, le=5_000_000)


class Job(BaseModel):
    schema_version: str = SCHEMA_VERSION
    job_id: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,80}$")
    stage: Stage
    top: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
    parameters: dict[str, int] = Field(default_factory=dict)
    files: dict[str, str]
    filelist: list[str]
    options: dict[str, Any] = Field(default_factory=dict)
    limits: Limits = Field(default_factory=Limits)

    @field_validator("files")
    @classmethod
    def _safe_paths(cls, files: dict[str, str]) -> dict[str, str]:
        for path in files:
            validate_relative_path(path)
        return files

    @field_validator("parameters")
    @classmethod
    def _safe_param_names(cls, params: dict[str, int]) -> dict[str, int]:
        for name in params:
            if not name.isidentifier():
                raise ValueError(f"invalid parameter name {name!r}")
        return params


class Finding(BaseModel):
    severity: Literal["error", "warning", "info"]
    code: str
    message: str
    tool: str
    file: str | None = None
    line: int | None = None


class StepResult(BaseModel):
    tool: str
    version: str | None
    command: list[str]
    exit_code: int | None
    status: StageStatus
    duration_s: float
    stdout: str = ""
    stderr: str = ""
    truncated: bool = False


class TestCaseResult(BaseModel):
    name: str
    status: Literal["PASS", "FAIL", "SKIP", "ERROR"]
    covers: list[str] = Field(default_factory=list)
    duration_s: float | None = None
    message: str | None = None


class PropertyResult(BaseModel):
    kind: Literal["assert", "cover"]
    location: str
    status: Literal["PASS", "FAIL", "REACHED", "UNREACHED", "UNKNOWN"]
    covers: list[str] = Field(default_factory=list)
    step: int | None = None


class Artifact(BaseModel):
    path: str
    sha256: str
    size: int
    content: str | None = None  # included for small text artifacts only


class StageResult(BaseModel):
    schema_version: str = SCHEMA_VERSION
    job_id: str
    stage: Stage
    status: StageStatus
    summary: str
    input_hash: str
    started_at: str
    finished_at: str
    duration_s: float
    execution: dict[str, Any]
    steps: list[StepResult] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    tests: list[TestCaseResult] = Field(default_factory=list)
    properties: list[PropertyResult] = Field(default_factory=list)
    formal_status: FormalStatus | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[Artifact] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


def validate_relative_path(path: str) -> None:
    """Reject absolute paths, traversal and odd characters before touching disk."""
    if not path or len(path) > 200:
        raise ValueError("invalid file path length")
    if path.startswith(("/", "\\")) or ":" in path or "\\" in path:
        raise ValueError(f"absolute or platform-specific path not allowed: {path!r}")
    parts = path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError(f"path traversal not allowed: {path!r}")
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-/")
    if not set(path) <= allowed:
        raise ValueError(f"unsupported characters in path: {path!r}")
