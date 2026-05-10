import json
import os
import subprocess
import sys
import tempfile
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app.validator import ValidationError, validate

EXEC_TIMEOUT_SECONDS = 30

app = FastAPI(title="sable-sandbox", version="0.1.0")


class ExecuteRequest(BaseModel):
    code: str = Field(..., min_length=1)
    context: dict[str, Any] = Field(default_factory=dict)


class ExecuteResponse(BaseModel):
    stdout: str
    stderr: str
    returncode: int
    timed_out: bool = False


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/execute", response_model=ExecuteResponse)
def execute(req: ExecuteRequest) -> ExecuteResponse:
    try:
        validate(req.code)
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    ticker = req.context.get("ticker", "")
    preamble = (
        f"data = {json.dumps(req.context)}\n"
        f"ticker = {json.dumps(ticker)}\n\n"
    )
    full_code = preamble + req.code

    with tempfile.NamedTemporaryFile(
        suffix=".py", mode="w", delete=False, dir="/tmp"
    ) as f:
        f.write(full_code)
        path = f.name

    try:
        result = subprocess.run(
            [sys.executable, path],
            capture_output=True,
            text=True,
            timeout=EXEC_TIMEOUT_SECONDS,
            cwd="/tmp",
        )
    except subprocess.TimeoutExpired as e:
        return ExecuteResponse(
            stdout=e.stdout or "",
            stderr=(e.stderr or "") + f"\nExecution exceeded {EXEC_TIMEOUT_SECONDS}s timeout",
            returncode=-1,
            timed_out=True,
        )
    finally:
        os.unlink(path)

    return ExecuteResponse(
        stdout=result.stdout,
        stderr=result.stderr,
        returncode=result.returncode,
    )
