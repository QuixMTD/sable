"""Spawn → supervise → collect. The runner owns the wall-clock kill and
the result-file contract; the worker owns rlimits + execution.

Why a result *file* and not stdout parsing: user code writes to stdout
freely, so the only reliable channel for the structured envelope is a
separate file the harness writes and we read back. If the file is
absent or corrupt, the process was killed (timeout / OOM) and we
synthesise a `killed` envelope.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any

# Wall-clock grace on top of the CPU limit so the parent's hard kill is
# normally what fires (cleaner than a SIGXCPU traceback).
_WALL_GRACE_S = 5


def run(code: str, data: Any, limits: dict[str, Any]) -> dict[str, Any]:
    timeout_s = int(limits.get("timeout_s", 30))

    tmpdir = tempfile.mkdtemp(prefix="sbx-")
    job_path = os.path.join(tmpdir, "job.json")
    result_path = os.path.join(tmpdir, "result.json")

    with open(job_path, "w", encoding="utf-8") as fh:
        json.dump({"code": code, "data": data, "limits": limits}, fh)

    # Minimal, scrubbed environment. Pin every known BLAS / OpenMP thread
    # pool to 1 so RLIMIT_NPROC can stay low without breaking numpy.
    #
    # The `app` package root is three parents up from this file
    # (app/sandbox/runner.py → app/sandbox → app → <service root>).
    # Derive it deterministically rather than trusting the server's cwd
    # at request time.
    pkg_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "PYTHONPATH": pkg_root,
        "HOME": tmpdir,
        "TMPDIR": tmpdir,
        "MPLBACKEND": "Agg",
        "MPLCONFIGDIR": tmpdir,
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "NUMEXPR_NUM_THREADS": "1",
        "PYTHONHASHSEED": "0",
    }

    started = time.monotonic()
    # Not `-I`/`-E`: those ignore PYTHONPATH, and we *need* our scrubbed
    # PYTHONPATH honoured so the harness can import the `app` package.
    # Env isolation from the parent is already total — Popen gets a fresh
    # `env` dict, the child inherits nothing. `-s` drops user site,
    # `-B` skips .pyc writes.
    proc = subprocess.Popen(
        [sys.executable, "-s", "-B", "-m", "app.sandbox.worker_entry", job_path, result_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=tmpdir,
        env=env,
        start_new_session=True,  # own process group → killpg on timeout
    )

    killed = False
    try:
        proc.communicate(timeout=timeout_s + _WALL_GRACE_S)
    except subprocess.TimeoutExpired:
        killed = True
        _hard_kill(proc)
        proc.communicate()

    duration_ms = int((time.monotonic() - started) * 1000)

    envelope = _read_result(result_path)
    if envelope is None or killed:
        envelope = {
            "stdout": "",
            "stderr": "",
            "returncode": -1,
            "result": None,
            "figures": [],
            "killed": True,
            "error": (
                f"execution exceeded the {timeout_s}s limit and was terminated"
                if killed
                else "the sandbox process exited without producing a result"
            ),
        }

    envelope["duration_ms"] = duration_ms
    _cleanup(tmpdir)
    return envelope


def _hard_kill(proc: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _read_result(path: str) -> dict[str, Any] | None:
    try:
        with open(path, "rb") as fh:
            return json.loads(fh.read().decode("utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return None


def _cleanup(tmpdir: str) -> None:
    # Conservative manual teardown — no shutil.rmtree (avoid pulling
    # shutil into this surface for a two-file dir).
    for name in ("job.json", "result.json"):
        try:
            os.unlink(os.path.join(tmpdir, name))
        except OSError:
            pass
    try:
        os.rmdir(tmpdir)
    except OSError:
        pass
