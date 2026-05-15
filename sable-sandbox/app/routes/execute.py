"""POST /execute — the only real endpoint.

Flow: validate (AST gate) → run (subprocess jail) → return envelope.
Validation failures are a client error (400 via AppError). Everything
else — user code raising, timing out, OOM — is a *successful* execution
that produced an error envelope, returned 200 with killed/error set.
That distinction matters: sable-engine needs to tell "your script was
rejected" apart from "your script ran and blew up".
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.errors import AppError
from sable_shared.http import success

from app.sandbox.runner import run
from app.sandbox.validate import ValidationError, validate

router = APIRouter()

# Hard ceilings — a caller can ask for *less* but never more.
_MAX_TIMEOUT_S = 30
_MAX_MEM_MB = 1024
_MAX_STDOUT_KB = 256
_MAX_CODE_CHARS = 100_000


class Limits(BaseModel):
    timeout_s: int = Field(default=30, ge=1, le=_MAX_TIMEOUT_S)
    mem_mb: int = Field(default=512, ge=64, le=_MAX_MEM_MB)
    stdout_kb: int = Field(default=256, ge=1, le=_MAX_STDOUT_KB)


class ExecuteRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=_MAX_CODE_CHARS)
    # The single injected blob. sable-engine fetches from the correct
    # modules and packs everything under `data` (data['holdings'],
    # data['prices'], data['properties'], data['unified_portfolio'], …).
    # The sandbox stays source-agnostic — it never knows where any of
    # this came from.
    data: Any = None
    limits: Limits = Field(default_factory=Limits)


@router.post("/execute")
def execute(req: ExecuteRequest) -> dict[str, object]:
    try:
        validate(req.code)
    except ValidationError as e:
        # Client error — the code never ran.
        raise AppError(
            "SANDBOX_FORBIDDEN_IMPORT",
            status_code=400,
            message=str(e),
        ) from e

    envelope = run(
        code=req.code,
        data=req.data,
        limits=req.limits.model_dump(),
    )
    # 200 even for user-code errors / timeouts — the envelope carries the
    # outcome (killed / error / returncode). Only validation is a 4xx.
    return success(envelope)
