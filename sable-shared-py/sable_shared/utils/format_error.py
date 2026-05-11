"""Normalises any Python exception into an AppError with a consistent
response shape. The error_handler middleware then renders these as the
standard JSON envelope.

The AppError class is intentionally loose — `code` is a free-form string
that matches the TS sable-shared error codes (VALIDATION_FAILED,
AUTH_FAILED, MODULE_NOT_ACTIVE, INTERNAL_ERROR, etc.). Services pass
whatever code makes sense; we don't keep a separate constants table in
Python.
"""

from __future__ import annotations

import asyncio
import subprocess
from typing import Any


class AppError(Exception):
    """Operational error with an HTTP status and a wire-safe code."""

    def __init__(
        self,
        code: str,
        *,
        status_code: int = 500,
        message: str | None = None,
        details: dict[str, Any] | None = None,
        cause: BaseException | None = None,
    ) -> None:
        self.code = code
        self.status_code = status_code
        self.message = message or code.replace("_", " ").lower()
        self.details = details
        self.__cause__ = cause
        super().__init__(self.message)

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe representation of the error body. Excludes cause/traceback."""
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            body["details"] = self.details
        return body


def format_error(exc: BaseException) -> AppError:
    """Map any exception to an AppError. AppErrors flow through unchanged.

    Add new cases here when a recurring third-party exception shape needs
    a friendly code on the wire (e.g. EODHD client errors).
    """
    if isinstance(exc, AppError):
        return exc

    # Sandbox-specific — sable-sandbox runs user code in a subprocess.
    if isinstance(exc, subprocess.TimeoutExpired):
        return AppError(
            "SANDBOX_TIMEOUT",
            status_code=504,
            message=f"Subprocess exceeded its {exc.timeout}s timeout",
            cause=exc,
        )

    if isinstance(exc, asyncio.TimeoutError):
        return AppError("DOWNSTREAM_FAILURE", status_code=504, message="Operation timed out", cause=exc)

    if isinstance(exc, ValueError):
        return AppError("VALIDATION_FAILED", status_code=400, message=str(exc), cause=exc)

    if isinstance(exc, PermissionError):
        return AppError("FORBIDDEN", status_code=403, message=str(exc), cause=exc)

    if isinstance(exc, FileNotFoundError):
        return AppError("NOT_FOUND", status_code=404, message=str(exc), cause=exc)

    # Pydantic v2 ValidationError lives at pydantic.ValidationError; importing
    # at module top would force pydantic on every consumer. Check by name.
    if exc.__class__.__name__ == "ValidationError" and exc.__class__.__module__.startswith("pydantic"):
        return AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="Request body failed validation",
            details={"errors": getattr(exc, "errors", lambda: [])()},
            cause=exc,
        )

    return AppError("INTERNAL_ERROR", status_code=500, message=str(exc) or "Internal error", cause=exc)
