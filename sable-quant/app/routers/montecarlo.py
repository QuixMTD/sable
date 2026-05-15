"""Monte Carlo terminal-value simulation (geometric Brownian motion
fitted to the supplied price history). Returns the terminal-value
distribution summary plus a VaR/CVaR read on the simulated P&L.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/montecarlo", tags=["montecarlo"])

_MAX_CELLS = 2_000_000_000  # simulations * horizon guard


class MonteCarloRequest(BaseModel):
    prices: list[float] = Field(..., min_length=2, description="Historical close prices")
    horizon_days: int = Field(252, ge=1, le=10_000)
    simulations: int = Field(10_000, ge=100, le=200_000)
    seed: int | None = None


class MonteCarloResult(BaseModel):
    start_price: float
    horizon_days: int
    simulations: int
    mean: float
    std: float
    p5: float
    p50: float
    p95: float
    var_95: float          # fractional loss at the 95% level
    cvar_95: float          # mean loss beyond the 95% VaR


@router.post("")
def run_montecarlo(req: MonteCarloRequest) -> dict[str, object]:
    if req.simulations * req.horizon_days > _MAX_CELLS:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="simulations * horizon_days exceeds the compute guard",
        )

    prices = np.asarray(req.prices, dtype=float)
    if np.any(prices <= 0):
        raise AppError("VALIDATION_FAILED", status_code=400, message="prices must be positive")

    log_returns = np.diff(np.log(prices))
    mu = float(log_returns.mean())
    sigma = float(log_returns.std(ddof=1))
    start = float(prices[-1])

    rng = np.random.default_rng(req.seed)
    shocks = rng.normal(mu, sigma, size=(req.simulations, req.horizon_days))
    terminal = start * np.exp(shocks.sum(axis=1))

    pnl_frac = terminal / start - 1.0
    pnl_p5 = np.percentile(pnl_frac, 5)
    tail = pnl_frac[pnl_frac <= pnl_p5]
    var_95 = float(-pnl_p5)
    cvar_95 = float(-tail.mean()) if tail.size else var_95

    return success(
        MonteCarloResult(
            start_price=start,
            horizon_days=req.horizon_days,
            simulations=req.simulations,
            mean=float(terminal.mean()),
            std=float(terminal.std(ddof=1)),
            p5=float(np.percentile(terminal, 5)),
            p50=float(np.percentile(terminal, 50)),
            p95=float(np.percentile(terminal, 95)),
            var_95=var_95,
            cvar_95=cvar_95,
        ).model_dump()
    )
