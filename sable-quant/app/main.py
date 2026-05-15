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
from app.routers import health
from app.routers.sc import (
    attribution,
    backtest,
    black_litterman,
    factors,
    mean_variance,
    montecarlo,
    portfolio,
    risk,
    risk_analytics,
    technicals,
)

configure_logging("sable-quant")

app = FastAPI(title="sable-quant", version="1.0.0")

app.include_router(health.router)

# Quant is namespaced per data module. Equities (sable-sc) mounts under
# /sc; crypto (app.routers.crypto → /crypto) and property
# (app.routers.re → /re) get the same treatment when those modules'
# quant is built. The maths is reused across modules — only the module
# that feeds it (and any asset-specific analytics) differs.
for _r in (
    montecarlo,
    black_litterman,
    mean_variance,
    portfolio,
    risk,
    risk_analytics,
    factors,
    backtest,
    attribution,
    technicals,
):
    app.include_router(_r.router, prefix="/sc")

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
