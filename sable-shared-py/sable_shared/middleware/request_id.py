"""Extracts X-Request-Id from the incoming request (or generates one if
absent), stores it in the request_id contextvar, and echoes it back on the
response so the caller can correlate logs across the gateway → Python
service → downstream chain.
"""

from __future__ import annotations

import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from sable_shared.utils.context import request_id_var

HEADER = "x-request-id"


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        incoming = request.headers.get(HEADER)
        request_id = incoming if incoming else str(uuid.uuid4())

        token = request_id_var.set(request_id)
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers[HEADER] = request_id
        return response
