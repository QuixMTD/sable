"""Per-request context — user_id, org_id, role, request_id — extracted
from forwarded headers and stored in contextvars so they propagate through
async code and surface in every log line without being passed explicitly.

The TS gateway forwards `X-User-ID`, `X-Org-ID`, `X-Role`, `X-Request-Id`
on every service-to-service call after authentication. Python services
treat these as trusted because the request reached them via gateway
HMAC verification (service_auth middleware).

Usage at a logging call:
    from sable_shared.utils.context import get_context
    log.info("doing the thing", extra={**get_context()})
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any

request_id_var: ContextVar[str | None] = ContextVar("sable_request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("sable_user_id", default=None)
org_id_var: ContextVar[str | None] = ContextVar("sable_org_id", default=None)
role_var: ContextVar[str | None] = ContextVar("sable_role", default=None)


def get_context() -> dict[str, Any]:
    """Snapshot of the current request context, suitable for log meta."""
    snapshot: dict[str, Any] = {}
    for name, var in (
        ("requestId", request_id_var),
        ("userId", user_id_var),
        ("orgId", org_id_var),
        ("role", role_var),
    ):
        value = var.get()
        if value is not None:
            snapshot[name] = value
    return snapshot
