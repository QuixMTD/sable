"""Operational error with an HTTP status and a wire-safe code.

Constructed from an ErrorCode (the table in ``codes.py`` supplies the
default status and message). Callers can override message and attach
``details`` for client-safe context — ``cause`` is preserved on
``__cause__`` for logging but never serialised to the wire.

Mirrors ``AppError`` in TS ``sable-shared/src/errors/AppError.ts``.
"""

from __future__ import annotations

from typing import Any

from sable_shared.errors.codes import ERROR_CODES, ErrorCode


class AppError(Exception):
    code: ErrorCode
    status_code: int
    message: str
    details: dict[str, Any] | None

    def __init__(
        self,
        code: ErrorCode,
        *,
        status_code: int | None = None,
        message: str | None = None,
        details: dict[str, Any] | None = None,
        cause: BaseException | None = None,
    ) -> None:
        entry = ERROR_CODES.get(code)
        if entry is None:
            # Unknown code at runtime — preserve it but fall back to 500.
            self.code = code
            self.status_code = status_code if status_code is not None else 500
            self.message = message or code.replace("_", " ").lower()
        else:
            self.code = code
            self.status_code = status_code if status_code is not None else entry["status"]
            self.message = message if message is not None else entry["message"]

        self.details = details
        if cause is not None:
            self.__cause__ = cause
        super().__init__(self.message)

    def to_dict(self) -> dict[str, Any]:
        """Wire-safe representation. Excludes cause / traceback."""
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            body["details"] = self.details
        return body

    @staticmethod
    def is_app_error(value: object) -> bool:
        return isinstance(value, AppError)
