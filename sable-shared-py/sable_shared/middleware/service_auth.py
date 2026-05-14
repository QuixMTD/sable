"""Verifies HMAC-SHA-256 signed requests from sable-gateway.

The gateway signs each service-to-service call with five headers:

    X-Service-Name      'sable-gateway' (informational)
    X-Service-Version   integer — HMAC key version
    X-Service-Nonce     one-time random string
    X-Service-TS        unix-ms timestamp
    X-Service-Token     hex HMAC-SHA-256 over the canonical message:
                            f'{ts}.{nonce}.{method}.{path}.{body_sha256_hex}'

The 30-second timestamp window is the only replay protection on the
Python side — the gateway does Redis-based nonce deduplication
upstream, and within the GCP VPC the Python service trusts the
gateway as the only HMAC signer (Cloud Run policy blocks direct
internet access).

Also populates the user_id / org_id / role contextvars from the
forwarded ``X-User-ID``, ``X-Org-ID``, ``X-Role`` headers so subsequent
log lines and downstream calls carry the originating identity.
"""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable, Mapping

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from sable_shared.crypto.hash import constant_time_equal, hmac_sha256, sha256_hex
from sable_shared.errors import AppError
from sable_shared.utils.context import org_id_var, role_var, user_id_var

NONCE_WINDOW_MS = 30_000


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Reject any request that doesn't carry a valid gateway HMAC.

    Pass ``hmac_keys`` as a mapping of integer version → key bytes. The
    application loads these at startup (from Secret Manager or env) and
    can hot-rotate by reloading the mapping.

    ``exempt_paths`` lets you skip healthz / metrics endpoints that need
    to be reachable without HMAC (e.g. Cloud Run health probes).
    """

    def __init__(
        self,
        app: object,
        *,
        hmac_keys: Mapping[int, bytes],
        exempt_paths: frozenset[str] = frozenset({"/healthz", "/readyz"}),
    ) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self.hmac_keys = dict(hmac_keys)
        self.exempt_paths = exempt_paths

    async def dispatch(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        if request.url.path in self.exempt_paths:
            return await call_next(request)

        try:
            body = await request.body()
            self._verify(request, body)
            # Re-stamp the receive so the downstream handler can re-read.
            request._receive = _replay_receive(body)
        except AppError as err:
            return JSONResponse(status_code=err.status_code, content={"ok": False, "error": err.to_dict()})

        # Propagate forwarded identity into contextvars for the duration of
        # this request. Reset on the way out so a pooled task doesn't leak.
        tokens = [
            user_id_var.set(request.headers.get("x-user-id")),
            org_id_var.set(request.headers.get("x-org-id")),
            role_var.set(request.headers.get("x-role")),
        ]
        try:
            return await call_next(request)
        finally:
            user_id_var.reset(tokens[0])
            org_id_var.reset(tokens[1])
            role_var.reset(tokens[2])

    def _verify(self, request: Request, body: bytes) -> None:
        version_raw = request.headers.get("x-service-version")
        nonce = request.headers.get("x-service-nonce")
        ts_raw = request.headers.get("x-service-ts")
        token = request.headers.get("x-service-token")

        if not (version_raw and nonce and ts_raw and token):
            raise AppError("INVALID_HMAC", message="Missing service-auth headers")

        try:
            version = int(version_raw)
            ts = int(ts_raw)
        except ValueError as e:
            raise AppError("INVALID_HMAC", message="Malformed HMAC headers") from e

        if abs(int(time.time() * 1000) - ts) > NONCE_WINDOW_MS:
            raise AppError("REPLAY_ATTACK", message="Timestamp outside the 30s window")

        key = self.hmac_keys.get(version)
        if key is None:
            raise AppError("INVALID_HMAC", message=f"Unknown HMAC key version {version}")

        body_hex = sha256_hex(body)
        canonical = f"{ts}.{nonce}.{request.method}.{request.url.path}.{body_hex}"
        expected = hmac_sha256(key, canonical)

        try:
            provided = bytes.fromhex(token)
        except ValueError as e:
            raise AppError("INVALID_HMAC", message="Token not hex-encoded") from e

        if not constant_time_equal(provided, expected):
            raise AppError("INVALID_HMAC")


def _replay_receive(body: bytes) -> Callable[[], Awaitable[dict[str, Any]]]:
    """Return a fresh ASGI receive() that yields the cached body once."""
    sent = False

    async def receive() -> dict[str, Any]:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive
