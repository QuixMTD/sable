"""Normalises any Python exception into an AppError with a consistent
response shape. The error_handler middleware then renders these as the
standard JSON envelope.

Mirrors ``formatError`` in TS ``sable-shared/src/errors/formatError.ts``.
"""

from __future__ import annotations

import asyncio
import subprocess

from sable_shared.errors.app_error import AppError


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
            message=f"Subprocess exceeded its {exc.timeout}s timeout",
            cause=exc,
        )

    if isinstance(exc, asyncio.TimeoutError):
        return AppError("DOWNSTREAM_FAILURE", message="Operation timed out", cause=exc)

    if isinstance(exc, ValueError):
        return AppError("VALIDATION_FAILED", message=str(exc), cause=exc)

    if isinstance(exc, PermissionError):
        return AppError("FORBIDDEN", message=str(exc), cause=exc)

    if isinstance(exc, FileNotFoundError):
        return AppError("NOT_FOUND", message=str(exc), cause=exc)

    # Pydantic v2 ValidationError lives at pydantic.ValidationError; importing
    # at module top would force pydantic on every consumer. Check by name.
    if exc.__class__.__name__ == "ValidationError" and exc.__class__.__module__.startswith("pydantic"):
        errors_fn = getattr(exc, "errors", None)
        errors = errors_fn() if callable(errors_fn) else []
        return AppError(
            "VALIDATION_FAILED",
            message="Request body failed validation",
            details={"errors": errors},
            cause=exc,
        )

    return AppError("INTERNAL_ERROR", message=str(exc) or "Internal error", cause=exc)
