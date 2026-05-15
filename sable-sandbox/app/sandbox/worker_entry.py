"""The harness exec'd inside the locked-down child process.

Invoked as:  python -m app.sandbox.worker_entry <job_path> <result_path>

Lifecycle:
  1. Apply rlimits (CPU, memory, file size, procs, core) FIRST — before
     any user-influenced work happens.
  2. Force matplotlib's Agg backend (no display, no GUI thread).
  3. Read the job spec ({code, inject, limits}) from <job_path>.
  4. Build a restricted namespace: injected vars + safe builtins.
  5. exec the user code with stdout/stderr redirected into buffers.
  6. Collect `result` (best-effort JSON) and any matplotlib figures.
  7. Write the envelope to <result_path> and exit 0.

The parent never trusts this process's own stdout/stderr for the
payload — everything the caller sees comes from <result_path>. If this
process is killed (timeout / OOM), the parent finds no result file and
synthesises a killed envelope.
"""

from __future__ import annotations

import base64
import io
import json
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
from typing import Any

MAX_RESULT_BYTES = 256 * 1024
MAX_FIGURES = 10


def _apply_rlimits(limits: dict[str, Any]) -> None:
    import resource

    cpu_s = int(limits.get("timeout_s", 30))
    mem_bytes = int(limits.get("mem_mb", 512)) * 1024 * 1024

    def _cap(which: int, soft: int) -> None:
        """Lower a limit toward `soft` without ever exceeding the existing
        hard cap. Best-effort: a platform that rejects a given limit
        (macOS RLIMIT_AS, NPROC quirks, …) must NOT abort the harness —
        the Linux container's own cgroup limits are the real backstop and
        these are defence-in-depth on top.
        """
        try:
            _cur_soft, cur_hard = resource.getrlimit(which)
            if cur_hard != resource.RLIM_INFINITY:
                soft = min(soft, cur_hard)
            new_hard = cur_hard if cur_hard != resource.RLIM_INFINITY else soft
            resource.setrlimit(which, (soft, new_hard))
        except (ValueError, OSError):
            pass

    # CPU seconds — SIGXCPU then SIGKILL. Slightly above the wall clock
    # so the parent's hard kill is normally what fires first.
    _cap(resource.RLIMIT_CPU, cpu_s + 1)
    # Address space (virtual memory) — allocations beyond raise
    # MemoryError in user code rather than OOM-killing the container.
    _cap(resource.RLIMIT_AS, mem_bytes)
    # No core dumps.
    _cap(resource.RLIMIT_CORE, 0)
    # File writes capped — the harness's own result file is small; user
    # code can't open() anyway. 8 MiB headroom.
    _cap(resource.RLIMIT_FSIZE, 8 * 1024 * 1024)
    # Process/thread ceiling — fork-bomb guard. BLAS thread pools pinned
    # to 1 via env in the parent so this can stay low.
    _cap(resource.RLIMIT_NPROC, 64)


def _collect_figures() -> list[str]:
    figures: list[str] = []
    try:
        import matplotlib.pyplot as plt  # noqa: WPS433 — intentional late import
    except Exception:
        return figures
    for num in plt.get_fignums()[:MAX_FIGURES]:
        try:
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=100, bbox_inches="tight")
            figures.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        except Exception:
            continue
    return figures


def _jsonable(value: Any) -> Any:
    """Best-effort conversion of a `result` value to something JSON can
    take. numpy / pandas objects get a sensible representation; anything
    exotic falls back to repr()."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        pass
    # Lazy — only import if we actually need the fallbacks.
    try:
        import numpy as np  # noqa: WPS433

        if isinstance(value, np.ndarray):
            return value.tolist()
        if isinstance(value, (np.integer,)):
            return int(value)
        if isinstance(value, (np.floating,)):
            return float(value)
    except Exception:
        pass
    try:
        import pandas as pd  # noqa: WPS433

        if isinstance(value, pd.DataFrame):
            return json.loads(value.to_json(orient="records"))
        if isinstance(value, pd.Series):
            return json.loads(value.to_json())
    except Exception:
        pass
    return repr(value)


def _truncate(text: str, cap_bytes: int) -> str:
    raw = text.encode("utf-8", errors="replace")
    if len(raw) <= cap_bytes:
        return text
    return raw[:cap_bytes].decode("utf-8", errors="ignore") + "\n…[truncated]"


def _run(job: dict[str, Any], result_path: str) -> None:
    limits = job.get("limits", {})
    _apply_rlimits(limits)

    # Headless plotting — set before user code can import pyplot. If
    # matplotlib isn't present we still run non-plotting code rather than
    # crashing the harness (a crashed harness reads as a false "killed").
    try:
        import matplotlib

        matplotlib.use("Agg")
    except Exception:
        pass

    from app.sandbox.allowlist import safe_builtins

    inject = job.get("inject", {})
    namespace: dict[str, Any] = {
        "__builtins__": safe_builtins(),
        "__name__": "__sandbox__",
        "data": inject.get("data"),
        "ticker": inject.get("ticker"),
        "portfolio": inject.get("portfolio"),
        "fundamentals": inject.get("fundamentals"),
        "result": None,
    }

    out_buf, err_buf = io.StringIO(), io.StringIO()
    error: str | None = None
    stdout_cap = int(limits.get("stdout_kb", 256)) * 1024

    try:
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            exec(compile(job["code"], "<sandbox>", "exec"), namespace, namespace)
    except SystemExit:
        # User called exit()/quit() (also AST-blocked, but be defensive).
        error = "code called exit()"
    except BaseException as exc:  # noqa: BLE001 — we must catch everything
        # Trim the traceback so internal harness frames don't leak.
        tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        error = "".join(tb[-6:]).strip()

    envelope = {
        "stdout": _truncate(out_buf.getvalue(), stdout_cap),
        "stderr": _truncate(err_buf.getvalue(), stdout_cap),
        "returncode": 0 if error is None else 1,
        "result": _jsonable(namespace.get("result")),
        "figures": _collect_figures(),
        "killed": False,
        "error": error,
    }

    payload = json.dumps(envelope).encode("utf-8")
    if len(payload) > MAX_RESULT_BYTES * 4:
        # Pathological result — drop it, keep the streams.
        envelope["result"] = None
        envelope["error"] = (envelope["error"] or "") + " [result dropped: too large]"
        payload = json.dumps(envelope).encode("utf-8")

    with open(result_path, "wb") as fh:
        fh.write(payload)


def _write_harness_failure(result_path: str, message: str) -> None:
    """Last-resort envelope for a failure BEFORE/AROUND user execution
    (bad argv, unreadable job, setup explosion). Distinct from a kill:
    the runner can show a precise infra error instead of a phantom
    'timeout'."""
    try:
        with open(result_path, "wb") as fh:
            fh.write(
                json.dumps(
                    {
                        "stdout": "",
                        "stderr": "",
                        "returncode": -1,
                        "result": None,
                        "figures": [],
                        "killed": False,
                        "error": f"sandbox harness failure: {message}",
                    }
                ).encode("utf-8")
            )
    except OSError:
        pass


def main() -> int:
    if len(sys.argv) < 3:
        return 2
    result_path = sys.argv[2]
    try:
        with open(sys.argv[1], encoding="utf-8") as fh:
            job = json.load(fh)
        _run(job, result_path)
        return 0
    except BaseException as exc:  # noqa: BLE001 — must always emit an envelope
        tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        _write_harness_failure(result_path, "".join(tb[-4:]).strip())
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
