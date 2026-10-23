"""FastAPI surface for the worker. Exposes typed stage jobs only, never arbitrary commands."""

from __future__ import annotations

import asyncio
import hmac
import os

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool

from . import __version__
from .jobs import run_job
from .models import Job, StageResult
from .preflight import capability_profile

app = FastAPI(title="Devin AI for VLSI worker", version=__version__)
_slots = asyncio.Semaphore(int(os.environ.get("WORKER_CONCURRENCY", "2")))


def require_token(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("WORKER_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="WORKER_TOKEN is not configured; refusing to accept jobs")
    supplied = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="invalid worker token")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "worker_version": __version__}


@app.get("/v1/capabilities", dependencies=[Depends(require_token)])
def capabilities() -> dict:
    return capability_profile()


@app.post("/v1/jobs", response_model=StageResult, dependencies=[Depends(require_token)])
async def submit(job: Job) -> StageResult:
    total = sum(len(v) for v in job.files.values())
    if total > 2_000_000:
        raise HTTPException(status_code=413, detail="job inputs exceed 2 MB")
    async with _slots:
        return await run_in_threadpool(run_job, job)
