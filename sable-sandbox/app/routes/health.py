"""Liveness + readiness. The sandbox has no DB/Redis, so readiness is
just "can I fork a worker and get a result back?" — a 1+1 smoke run
through the real runner path so a broken interpreter / missing lib /
seccomp surprise fails the probe instead of serving 500s.
"""

from __future__ import annotations

from fastapi import APIRouter
from sable_shared.http import success

from app.sandbox.runner import run

router = APIRouter()


@router.get("/healthz")
def healthz() -> dict[str, object]:
    return success({"status": "ok"})


@router.get("/readyz")
def readyz() -> dict[str, object]:
    envelope = run(
        code="result = 1 + 1\n",
        inject={},
        limits={"timeout_s": 5, "mem_mb": 128, "stdout_kb": 4},
    )
    ready = envelope.get("result") == 2 and not envelope.get("killed")
    return success(
        {
            "status": "ready" if ready else "degraded",
            "self_check_ms": envelope.get("duration_ms"),
        }
    )
