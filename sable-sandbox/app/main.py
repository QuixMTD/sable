"""sable-sandbox — untrusted Python execution jail.

Middleware order (outermost first):
  RequestIdMiddleware  → correlation id on every request + response
  ServiceAuthMiddleware → HMAC verify (sable-engine is the only caller);
                          /healthz + /readyz exempt for Cloud Run probes
  install_error_handlers → AppError / unhandled → standard JSON envelope

The service holds no DB/Redis handles — readiness is a self-executed
1+1 through the real runner. HMAC keys come from env only (no DB
fallback by design — see app/config.py).
"""

from __future__ import annotations

from fastapi import FastAPI
from sable_shared.middleware import (
    RequestIdMiddleware,
    ServiceAuthMiddleware,
    configure_logging,
    install_error_handlers,
)

from app.config import load_hmac_keys, service_auth_disabled
from app.routes.analyze import router as analyze_router
from app.routes.execute import router as execute_router
from app.routes.health import router as health_router

configure_logging("sable-sandbox")

app = FastAPI(title="sable-sandbox", version="1.0.0")

app.include_router(health_router)
app.include_router(execute_router)
app.include_router(analyze_router)

install_error_handlers(app)

# Inbound is always sable-engine over signed HMAC. The local-dev escape
# hatch drops it entirely — guarded so it can't silently ship.
if not service_auth_disabled():
    _hmac_keys = load_hmac_keys()
    if not _hmac_keys:
        raise RuntimeError(
            "No HMAC_KEY_V<n> env vars found and SANDBOX_DISABLE_SERVICE_AUTH "
            "is not set — refusing to start an unauthenticated sandbox."
        )
    app.add_middleware(
        ServiceAuthMiddleware,
        hmac_keys=_hmac_keys,
        exempt_paths=frozenset({"/healthz", "/readyz"}),
    )

# RequestId is added last so it runs OUTERMOST (Starlette applies
# middleware in reverse add order) — every response, including auth
# rejections, carries the correlation id.
app.add_middleware(RequestIdMiddleware)
