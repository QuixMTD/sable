"""Mean-variance (Markowitz) optimisation.

scipy.optimize.minimize (SLSQP) with a long-only, fully-invested
default and optional per-asset weight bounds. SLSQP keeps the service
dependency-light and fully testable now; the general-convex path
(arbitrary linear constraints via cvxpy) is a later slice.

Objectives:
  max_sharpe → maximise (μᵀw − rf) / √(wᵀΣw)
  min_vol    → minimise wᵀΣw
  target_return → min variance s.t. μᵀw = target
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from scipy.optimize import minimize
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/mean-variance", tags=["mean-variance"])


class MeanVarianceRequest(BaseModel):
    expected_returns: list[float] = Field(..., min_length=2, description="Annualised μ per asset")
    cov: list[list[float]] = Field(..., description="Annualised covariance NxN")
    objective: str = Field("max_sharpe", description="max_sharpe | min_vol | target_return")
    risk_free_rate: float = Field(0.0)
    target_return: float | None = Field(None, description="Required when objective=target_return")
    weight_bounds: tuple[float, float] = Field((0.0, 1.0), description="(min, max) per asset")
    allow_short: bool = Field(False, description="If true, lower bound becomes -max")


class MeanVarianceResult(BaseModel):
    objective: str
    weights: list[float]
    expected_return: float
    volatility: float
    sharpe: float


def _bounds(n: int, lo: float, hi: float, allow_short: bool) -> list[tuple[float, float]]:
    low = -hi if allow_short else lo
    return [(low, hi)] * n


@router.post("")
def optimise(req: MeanVarianceRequest) -> dict[str, object]:
    mu = np.asarray(req.expected_returns, dtype=float)
    cov = np.asarray(req.cov, dtype=float)
    n = mu.size

    if cov.shape != (n, n):
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="cov must be NxN and match expected_returns length",
        )
    if req.objective not in {"max_sharpe", "min_vol", "target_return"}:
        raise AppError("VALIDATION_FAILED", status_code=400, message="unknown objective")
    if req.objective == "target_return" and req.target_return is None:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="target_return is required for objective=target_return",
        )

    lo, hi = req.weight_bounds
    bounds = _bounds(n, lo, hi, req.allow_short)
    x0 = np.full(n, 1.0 / n)
    constraints: list[dict[str, object]] = [
        {"type": "eq", "fun": lambda w: float(np.sum(w) - 1.0)}  # fully invested
    ]

    def variance(w: np.ndarray) -> float:
        return float(w @ cov @ w)

    if req.objective == "min_vol":
        obj = variance
    elif req.objective == "target_return":
        tgt = float(req.target_return)  # type: ignore[arg-type]
        constraints.append({"type": "eq", "fun": lambda w: float(mu @ w - tgt)})
        obj = variance
    else:  # max_sharpe → minimise the negative Sharpe
        def neg_sharpe(w: np.ndarray) -> float:
            vol = np.sqrt(w @ cov @ w)
            if vol == 0:
                return 0.0
            return float(-(mu @ w - req.risk_free_rate) / vol)

        obj = neg_sharpe

    res = minimize(
        obj,
        x0,
        method="SLSQP",
        bounds=bounds,
        constraints=constraints,
        options={"maxiter": 500, "ftol": 1e-10},
    )
    if not res.success:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=422,
            message=f"optimiser did not converge: {res.message}",
        )

    w = np.asarray(res.x, dtype=float)
    w[np.abs(w) < 1e-9] = 0.0  # clean numerical dust
    port_ret = float(mu @ w)
    port_vol = float(np.sqrt(w @ cov @ w))
    sharpe = float((port_ret - req.risk_free_rate) / port_vol) if port_vol > 0 else 0.0

    return success(
        MeanVarianceResult(
            objective=req.objective,
            weights=w.tolist(),
            expected_return=port_ret,
            volatility=port_vol,
            sharpe=sharpe,
        ).model_dump()
    )
