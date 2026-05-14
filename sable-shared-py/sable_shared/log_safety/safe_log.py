"""PII-stripping log helpers.

The gateway DB doc requires "no PII in any log field" — every service
routes structured log meta through ``redact()`` so a sensitive field
name can't leak into stdout.

Two exports:
  - ``redact(value)``  — pure function; returns a deeply-cloned value
                          with sensitive fields replaced by ``[REDACTED]``.
  - ``safe_extra(meta)`` — convenience wrapper for use with stdlib
                          ``logging`` calls: ``log.info(msg, extra=safe_extra({...}))``.

Mirrors TS ``sable-shared/src/logging/safeLog.ts``.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Any, Iterable

from sable_shared.log_safety.sensitive_fields import is_sensitive_field, normalise_field

REDACTED = "[REDACTED]"
CIRCULAR = "[CIRCULAR]"
DEPTH_EXCEEDED = "[DEPTH_EXCEEDED]"

# Patterns scanned inside string values when ``scan_strings=True``.
# Default off — these regexes have a perf cost and can false-positive in
# URLs or non-PII text. Enable explicitly for error / stack-trace logging
# where the content is opaque and may contain inlined PII.
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")


def _scan_string(value: str) -> str:
    return _EMAIL_RE.sub("[EMAIL]", _JWT_RE.sub("[JWT]", value))


def redact(
    value: Any,
    *,
    extra_fields: Iterable[str] | None = None,
    max_depth: int = 10,
    scan_strings: bool = False,
) -> Any:
    """Return a deeply-cloned ``value`` with sensitive fields replaced.

    Args:
        extra_fields: Field names to redact in addition to the canonical
            ``SENSITIVE_FIELDS``. Case / underscore variations are
            normalised internally.
        max_depth: Recursion cap. Default 10 — anything deeper becomes
            ``[DEPTH_EXCEEDED]``.
        scan_strings: When True, scan inside string values for email and
            JWT patterns. Off by default.
    """
    extras = frozenset(normalise_field(f) for f in extra_fields) if extra_fields else None
    seen: set[int] = set()
    return _walk(value, extras, seen, 0, max_depth, scan_strings)


def _walk(
    value: Any,
    extras: frozenset[str] | None,
    seen: set[int],
    depth: int,
    max_depth: int,
    scan_strings: bool,
) -> Any:
    if depth >= max_depth:
        return DEPTH_EXCEEDED
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, complex)):
        return value
    if isinstance(value, str):
        return _scan_string(value) if scan_strings else value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"[bytes {len(value)}]"
    if isinstance(value, _dt.datetime):
        return value.isoformat()
    if isinstance(value, _dt.date):
        return value.isoformat()
    if isinstance(value, BaseException):
        return {
            "type": value.__class__.__name__,
            "message": str(value),
        }

    if isinstance(value, dict):
        ref = id(value)
        if ref in seen:
            return CIRCULAR
        seen.add(ref)
        out_dict: dict[str, Any] = {}
        for k, v in value.items():
            key = str(k)
            if is_sensitive_field(key, extras):
                out_dict[key] = REDACTED
            else:
                out_dict[key] = _walk(v, extras, seen, depth + 1, max_depth, scan_strings)
        return out_dict

    if isinstance(value, (list, tuple, set, frozenset)):
        ref = id(value)
        if ref in seen:
            return CIRCULAR
        seen.add(ref)
        return [_walk(v, extras, seen, depth + 1, max_depth, scan_strings) for v in value]

    # Fallback for arbitrary objects — never log __dict__ directly because
    # it may contain sensitive attrs we don't know to redact.
    return repr(value)


def safe_extra(meta: dict[str, Any], **redact_options: Any) -> dict[str, Any]:
    """Redact ``meta`` for direct use as the stdlib logger ``extra=`` arg.

    Returns a flat dict the logger can drop into ``record.__dict__``;
    nested redaction still applies.
    """
    redacted = redact(meta, **redact_options)
    return redacted if isinstance(redacted, dict) else {"value": redacted}
