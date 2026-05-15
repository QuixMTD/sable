"""Black-Litterman posterior. Implied equilibrium returns from
market-cap weights + risk aversion, optionally blended with investor
views (P, Q, optional Omega). Standardised onto the Sable envelope.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/black-litterman", tags=["black-litterman"])


class BlackLittermanRequest(BaseModel):
    cov: list[list[float]] = Field(..., description="Asset return covariance matrix (NxN)")
    market_weights: list[float] = Field(..., description="Equilibrium market-cap weights")
    risk_aversion: float = Field(2.5, gt=0)
    tau: float = Field(0.05, gt=0, lt=1)
    P: list[list[float]] | None = None
    Q: list[float] | None = None
    omega: list[list[float]] | None = None


class BlackLittermanResult(BaseModel):
    implied_equilibrium_returns: list[float]
    posterior_returns: list[float]
    posterior_cov: list[list[float]]
    views_applied: bool


@router.post("")
def run_black_litterman(req: BlackLittermanRequest) -> dict[str, object]:
    cov = np.asarray(req.cov, dtype=float)
    w = np.asarray(req.market_weights, dtype=float)

    if cov.ndim != 2 or cov.shape[0] != cov.shape[1] or cov.shape[0] != w.size:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="cov must be NxN and match market_weights length",
        )

    pi = req.risk_aversion * cov @ w  # implied equilibrium returns

    if req.P is None or req.Q is None:
        return success(
            BlackLittermanResult(
                implied_equilibrium_returns=pi.tolist(),
                posterior_returns=pi.tolist(),
                posterior_cov=cov.tolist(),
                views_applied=False,
            ).model_dump()
        )

    P = np.asarray(req.P, dtype=float)
    Q = np.asarray(req.Q, dtype=float)
    if P.ndim != 2 or P.shape[1] != w.size or P.shape[0] != Q.size:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="P must be KxN and Q length K (N = number of assets)",
        )

    omega = (
        np.asarray(req.omega, dtype=float)
        if req.omega is not None
        else np.diag(np.diag(P @ (req.tau * cov) @ P.T))
    )

    tau_cov = req.tau * cov
    try:
        inv_tau_cov = np.linalg.inv(tau_cov)
        inv_omega = np.linalg.inv(omega)
        posterior_cov = np.linalg.inv(inv_tau_cov + P.T @ inv_omega @ P)
    except np.linalg.LinAlgError as e:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="singular matrix — check cov / omega are positive definite",
        ) from e

    posterior_returns = posterior_cov @ (inv_tau_cov @ pi + P.T @ inv_omega @ Q)

    return success(
        BlackLittermanResult(
            implied_equilibrium_returns=pi.tolist(),
            posterior_returns=posterior_returns.tolist(),
            posterior_cov=posterior_cov.tolist(),
            views_applied=True,
        ).model_dump()
    )
