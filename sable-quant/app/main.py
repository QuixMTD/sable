"""sable-quant — the trusted quantitative compute engine.

Pure compute: no DB, no Redis, no outbound calls. Trusted because only
Sable services reach it (sable-engine / sable-gateway) over signed
HMAC — so unlike sable-sandbox there's no AST jail; this is our code
running our maths, optimised, full library access.

Middleware (outermost first):
  RequestIdMiddleware   → correlation id on every request/response
  ServiceAuthMiddleware → HMAC verify; /healthz + /readyz exempt
  install_error_handlers → AppError / unhandled → standard JSON envelope
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
from app.routers import (
    attribution,
    black_litterman,
    factors,
    health,
    mean_variance,
    montecarlo,
    portfolio,
    risk,
    risk_analytics,
)

configure_logging("sable-quant")

app = FastAPI(title="sable-quant", version="1.0.0")

app.include_router(health.router)
app.include_router(montecarlo.router)
app.include_router(black_litterman.router)
app.include_router(mean_variance.router)
app.include_router(portfolio.router)
app.include_router(risk.router)
app.include_router(risk_analytics.router)
app.include_router(factors.router)
app.include_router(attribution.router)

install_error_handlers(app)

if not service_auth_disabled():
    _hmac_keys = load_hmac_keys()
    if not _hmac_keys:
        raise RuntimeError(
            "No HMAC_KEY_V<n> env vars found and QUANT_DISABLE_SERVICE_AUTH "
            "is not set — refusing to start an unauthenticated quant engine."
        )
    app.add_middleware(
        ServiceAuthMiddleware,
        hmac_keys=_hmac_keys,
        exempt_paths=frozenset({"/healthz", "/readyz"}),
    )

# Added last → runs outermost (Starlette reverse-add order) so every
# response, including auth rejections, carries the correlation id.
app.add_middleware(RequestIdMiddleware)
