import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/black-litterman", tags=["black-litterman"])


class BlackLittermanRequest(BaseModel):
    cov: list[list[float]] = Field(..., description="Asset return covariance matrix (NxN)")
    market_weights: list[float] = Field(..., description="Equilibrium market-cap weights")
    risk_aversion: float = Field(2.5, gt=0)
    tau: float = Field(0.05, gt=0, lt=1)
    P: list[list[float]] | None = None
    Q: list[float] | None = None
    omega: list[list[float]] | None = None


class BlackLittermanResponse(BaseModel):
    posterior_returns: list[float]
    posterior_cov: list[list[float]]


@router.post("", response_model=BlackLittermanResponse)
def run_black_litterman(req: BlackLittermanRequest) -> BlackLittermanResponse:
    cov = np.asarray(req.cov, dtype=float)
    w = np.asarray(req.market_weights, dtype=float)

    if cov.shape[0] != cov.shape[1] or cov.shape[0] != w.size:
        raise HTTPException(400, "cov must be NxN and match market_weights length")

    pi = req.risk_aversion * cov @ w  # implied equilibrium returns

    if req.P is None or req.Q is None:
        return BlackLittermanResponse(
            posterior_returns=pi.tolist(),
            posterior_cov=cov.tolist(),
        )

    P = np.asarray(req.P, dtype=float)
    Q = np.asarray(req.Q, dtype=float)
    omega = (
        np.asarray(req.omega, dtype=float)
        if req.omega is not None
        else np.diag(np.diag(P @ (req.tau * cov) @ P.T))
    )

    tau_cov = req.tau * cov
    inv_tau_cov = np.linalg.inv(tau_cov)
    inv_omega = np.linalg.inv(omega)

    posterior_cov = np.linalg.inv(inv_tau_cov + P.T @ inv_omega @ P)
    posterior_returns = posterior_cov @ (inv_tau_cov @ pi + P.T @ inv_omega @ Q)

    return BlackLittermanResponse(
        posterior_returns=posterior_returns.tolist(),
        posterior_cov=posterior_cov.tolist(),
    )
