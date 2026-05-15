"""Liveness + readiness. No DB/Redis — readiness is a tiny numeric
self-check so a broken numpy/scipy build fails the probe instead of
serving wrong maths.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from sable_shared.http import success

router = APIRouter()


@router.get("/healthz")
def healthz() -> dict[str, object]:
    return success({"status": "ok"})


@router.get("/readyz")
def readyz() -> dict[str, object]:
    # Exercise the actual stack: a matrix solve + a percentile. If
    # numpy/scipy are mis-linked this is where it shows.
    a = np.array([[3.0, 1.0], [1.0, 2.0]])
    x = np.linalg.solve(a, np.array([9.0, 8.0]))
    ok = bool(np.allclose(a @ x, [9.0, 8.0]))
    return success({"status": "ready" if ok else "degraded"})
