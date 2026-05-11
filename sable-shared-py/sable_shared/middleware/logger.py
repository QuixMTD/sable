"""Structured JSON logger that emits Cloud Logging-compatible records.

Cloud Logging expects:
    severity (uppercase: INFO, WARNING, ERROR, ...)
    message
    Any other fields land in jsonPayload.

Stdlib `logging` plus a JSON formatter — no external deps. Per-request
context (request_id, user_id, org_id, role) is read from contextvars
so every log line picks it up without the caller passing it explicitly.

Usage at startup:

    from sable_shared.middleware.logger import configure_logging
    log = configure_logging("sable-quant", level="info")
    log.info("starting up")
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import sys
from typing import Any

from sable_shared.utils.context import get_context

# Cloud Logging severity values. Python uses 'WARNING'; Cloud Logging
# accepts both 'WARNING' and 'WARN' so default mapping is fine.
_SEVERITY = {
    logging.DEBUG: "DEBUG",
    logging.INFO: "INFO",
    logging.WARNING: "WARNING",
    logging.ERROR: "ERROR",
    logging.CRITICAL: "CRITICAL",
}


class CloudLoggingFormatter(logging.Formatter):
    def __init__(self, service_name: str, version: str | None = None) -> None:
        super().__init__()
        self.service_name = service_name
        self.version = version

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "severity": _SEVERITY.get(record.levelno, record.levelname.upper()),
            "message": record.getMessage(),
            "service": self.service_name,
            "logger": record.name,
            "timestamp": _dt.datetime.fromtimestamp(record.created, _dt.UTC).isoformat(),
        }
        if self.version:
            payload["version"] = self.version

        # Pull request-scoped context (request_id, user_id, org_id, role).
        payload.update(get_context())

        # Anything passed via `extra=` lands in record.__dict__; copy over
        # the fields that aren't internal LogRecord attributes.
        for key, value in record.__dict__.items():
            if key in _RESERVED_ATTRS or key.startswith("_"):
                continue
            payload[key] = value

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=_json_default)


_RESERVED_ATTRS = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "taskName", "message",
    }
)


def _json_default(value: Any) -> Any:
    if isinstance(value, _dt.datetime):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return repr(value)


def configure_logging(
    service_name: str,
    *,
    level: str = "info",
    version: str | None = None,
) -> logging.Logger:
    """Install the JSON formatter on the root logger and return a child
    logger named after the service. Idempotent — safe to call twice.
    """
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(CloudLoggingFormatter(service_name, version=version))

    root = logging.getLogger()
    # Replace any pre-existing handlers (uvicorn / gunicorn may have added
    # their own) so we control the format end-to-end.
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())

    # uvicorn / starlette propagate to root; silence their access log noise.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(logging.WARNING)

    return logging.getLogger(service_name)
