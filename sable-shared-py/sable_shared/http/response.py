"""Standard response envelope returned by every Sable service. Used over
REST and WebSocket — same shape so clients have one parser.

Discriminated on ``ok``: clients narrow on the literal True / False and
either ``data`` or ``error`` is present accordingly.

Mirrors TS ``sable-shared/src/http/response.ts``.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from sable_shared.errors.app_error import AppError
from sable_shared.errors.codes import ErrorCode
from sable_shared.log_safety.safe_log import redact


class SuccessResponse(TypedDict, total=False):
    ok: Literal[True]
    data: Any
    requestId: str


class ErrorBody(TypedDict, total=False):
    code: ErrorCode
    message: str
    details: dict[str, Any]


class ErrorResponse(TypedDict, total=False):
    ok: Literal[False]
    error: ErrorBody
    requestId: str


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

_UNSET: Any = object()


def success(data: Any = _UNSET, request_id: str | None = None) -> SuccessResponse:
    """Build a success envelope.

    Call shapes (mirroring the TS overloads):
      - ``success()``                       — no data, no requestId
      - ``success(request_id='abc')``       — no data, with requestId
      - ``success(payload)``                — data only
      - ``success(payload, 'abc')``         — data + requestId
    """
    body: SuccessResponse = {"ok": True}
    if data is not _UNSET:
        body["data"] = data
    if request_id is not None:
        body["requestId"] = request_id
    return body


def failure(
    error: AppError | ErrorCode,
    *,
    message: str | None = None,
    details: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> ErrorResponse:
    """Build an error envelope.

    Pass either an ``AppError`` (preferred — the codes table supplies
    status + message) or a bare ``ErrorCode`` plus ``message`` /
    ``details`` for ad-hoc cases.
    """
    if isinstance(error, AppError):
        body_dict = error.to_dict()
        # Defence in depth: ``details`` is contractually client-safe, but
        # redact at the wire boundary so an accidental PII field doesn't escape.
        if "details" in body_dict:
            body_dict["details"] = redact(body_dict["details"])
        envelope: ErrorResponse = {"ok": False, "error": body_dict}  # type: ignore[typeddict-item]
        if request_id is not None:
            envelope["requestId"] = request_id
        return envelope

    err_body: ErrorBody = {"code": error, "message": message or ""}
    if details is not None:
        err_body["details"] = redact(details)
    plain_envelope: ErrorResponse = {"ok": False, "error": err_body}
    if request_id is not None:
        plain_envelope["requestId"] = request_id
    return plain_envelope


# ---------------------------------------------------------------------------
# Type guards
# ---------------------------------------------------------------------------

def is_success(response: SuccessResponse | ErrorResponse) -> bool:
    return response.get("ok") is True


def is_failure(response: SuccessResponse | ErrorResponse) -> bool:
    return response.get("ok") is False
