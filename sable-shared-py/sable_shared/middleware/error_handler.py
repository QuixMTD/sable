"""FastAPI exception handlers that render the standard JSON envelope.

Register at app startup:

    from fastapi import FastAPI
    from sable_shared.middleware.error_handler import install_error_handlers
    app = FastAPI()
    install_error_handlers(app)

After install, any AppError (or other exception) raised from a route
returns:

    {
      "ok": false,
      "error": { "code": "...", "message": "...", "details": {...} },
      "requestId": "..."
    }

with the matching HTTP status code. Unknown exceptions are normalised to
INTERNAL_ERROR via format_error() so we never leak a raw traceback to the
client (the stack still lives in the structured log).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from sable_shared.utils.context import request_id_var
from sable_shared.utils.format_error import AppError, format_error

_log = logging.getLogger("sable_shared.error_handler")


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
        return _render(exc)

    @app.exception_handler(Exception)
    async def _generic_handler(_request: Request, exc: Exception) -> JSONResponse:
        normalised = format_error(exc)
        if normalised.status_code >= 500:
            _log.error("Unhandled exception", exc_info=exc, extra={"code": normalised.code})
        else:
            _log.warning(normalised.message, extra={"code": normalised.code})
        return _render(normalised)


def _render(err: AppError) -> JSONResponse:
    body: dict[str, Any] = {"ok": False, "error": err.to_dict()}
    request_id = request_id_var.get()
    if request_id is not None:
        body["requestId"] = request_id
    return JSONResponse(status_code=err.status_code, content=body)
