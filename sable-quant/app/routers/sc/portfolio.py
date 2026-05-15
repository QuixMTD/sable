"""Portfolio construction — the methods beyond Markowitz / Black-
Litterman (those have their own routers).

All four use scipy.optimize.SLSQP with an explicit fully-invested
(sum w = 1) constraint and per-asset bounds. Long-only is the default;
`allow_short` flips the lower bound to -hi. Every response reports the
realised diagnostics so the caller can *verify* the optimiser did what
it claims (e.g. risk-parity returns the realised risk contributions —
they should match the requested budget).

No cvxpy: each of these has a standard differentiable formulation
SLSQP handles well. General-convex-with-arbitrary-constraints is a
later slice.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from scipy.optimize import minimize
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/portfolio", tags=["portfolio"])

_FTOL = 1e-12
_MAXITER = 1000


def _bounds(n: int, lo: float, hi: float, allow_short: bool) -> list[tuple[float, float]]:
    return [((-hi if allow_short else lo), hi)] * n


def _budget_constraint() -> dict[str, object]:
    return {"type": "eq", "fun": lambda w: float(np.sum(w) - 1.0)}


def _validate_cov(cov_list: list[list[float]], n_expected: int | None = None) -> np.ndarray:
    cov = np.asarray(cov_list, dtype=float)
    if cov.ndim != 2 or cov.shape[0] != cov.shape[1]:
        raise AppError("VALIDATION_FAILED", status_code=400, message="cov must be a square NxN matrix")
    if n_expected is not None and cov.shape[0] != n_expected:
        raise AppError("VALIDATION_FAILED", status_code=400, message="cov dimension mismatch")
    return cov


def _portfolio_stats(
    w: np.ndarray, cov: np.ndarray, mu: np.ndarray | None
) -> tuple[float, float | None]:
    vol = float(np.sqrt(w @ cov @ w))
    ret = float(mu @ w) if mu is not None else None
    return vol, ret


def _solve(obj, x0: np.ndarray, bounds, constraints) -> np.ndarray:
    res = minimize(
        obj,
        x0,
        method="SLSQP",
        bounds=bounds,
        constraints=constraints,
        options={"maxiter": _MAXITER, "ftol": _FTOL},
    )
    if not res.success:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=422,
            message=f"optimiser did not converge: {res.message}",
        )
    w = np.asarray(res.x, dtype=float)
    w[np.abs(w) < 1e-9] = 0.0
    return w


# ---------------------------------------------------------------------------
# 1. Minimum variance
# ---------------------------------------------------------------------------

class MinVarRequest(BaseModel):
    cov: list[list[float]]
    expected_returns: list[float] | None = None
    weight_bounds: tuple[float, float] = (0.0, 1.0)
    allow_short: bool = False


class MinVarResult(BaseModel):
    weights: list[float]
    volatility: float
    expected_return: float | None


@router.post("/min-variance")
def min_variance(req: MinVarRequest) -> dict[str, object]:
    cov = _validate_cov(req.cov)
    n = cov.shape[0]
    mu = np.asarray(req.expected_returns, dtype=float) if req.expected_returns is not None else None
    if mu is not None and mu.size != n:
        raise AppError("VALIDATION_FAILED", status_code=400, message="expected_returns length must match cov")

    lo, hi = req.weight_bounds
    w = _solve(
        lambda w: float(w @ cov @ w),
        np.full(n, 1.0 / n),
        _bounds(n, lo, hi, req.allow_short),
        [_budget_constraint()],
    )
    vol, ret = _portfolio_stats(w, cov, mu)
    return success(MinVarResult(weights=w.tolist(), volatility=vol, expected_return=ret).model_dump())


# ---------------------------------------------------------------------------
# 2. Risk parity / Equal risk contribution
# ---------------------------------------------------------------------------

class RiskParityRequest(BaseModel):
    cov: list[list[float]]
    # Per-asset target share of total risk. Omit → equal (= ERC).
    risk_budget: list[float] | None = None
    weight_bounds: tuple[float, float] = Field(
        (1e-6, 1.0), description="Long-only required — risk parity is undefined with shorts"
    )


class RiskParityResult(BaseModel):
    weights: list[float]
    volatility: float
    risk_budget: list[float]
    risk_contributions: list[float]   # realised — should ≈ risk_budget


@router.post("/risk-parity")
def risk_parity(req: RiskParityRequest) -> dict[str, object]:
    cov = _validate_cov(req.cov)
    n = cov.shape[0]

    if req.risk_budget is None:
        budget = np.full(n, 1.0 / n)
    else:
        budget = np.asarray(req.risk_budget, dtype=float)
        if budget.size != n:
            raise AppError("VALIDATION_FAILED", status_code=400, message="risk_budget length must match cov")
        if np.any(budget <= 0):
            raise AppError("VALIDATION_FAILED", status_code=400, message="risk_budget entries must be positive")
        budget = budget / budget.sum()

    def objective(w: np.ndarray) -> float:
        port_var = w @ cov @ w
        if port_var <= 0:
            return 1e9
        mrc = cov @ w                      # marginal risk contribution
        rc = w * mrc / port_var            # fractional risk contribution
        return float(np.sum((rc - budget) ** 2))

    lo, hi = req.weight_bounds
    w = _solve(
        objective,
        np.full(n, 1.0 / n),
        _bounds(n, max(lo, 1e-9), hi, allow_short=False),
        [_budget_constraint()],
    )
    port_var = float(w @ cov @ w)
    rc = (w * (cov @ w) / port_var) if port_var > 0 else np.zeros(n)
    return success(
        RiskParityResult(
            weights=w.tolist(),
            volatility=float(np.sqrt(port_var)),
            risk_budget=budget.tolist(),
            risk_contributions=rc.tolist(),
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# 3. Maximum diversification
# ---------------------------------------------------------------------------

class MaxDivRequest(BaseModel):
    cov: list[list[float]]
    weight_bounds: tuple[float, float] = (0.0, 1.0)
    allow_short: bool = False


class MaxDivResult(BaseModel):
    weights: list[float]
    diversification_ratio: float       # (wᵀσ) / √(wᵀΣw); 1.0 = no diversification
    volatility: float


@router.post("/max-diversification")
def max_diversification(req: MaxDivRequest) -> dict[str, object]:
    cov = _validate_cov(req.cov)
    n = cov.shape[0]
    sigma = np.sqrt(np.diag(cov))

    def neg_dr(w: np.ndarray) -> float:
        port_vol = np.sqrt(w @ cov @ w)
        if port_vol <= 0:
            return 0.0
        return float(-(w @ sigma) / port_vol)

    lo, hi = req.weight_bounds
    w = _solve(
        neg_dr,
        np.full(n, 1.0 / n),
        _bounds(n, lo, hi, req.allow_short),
        [_budget_constraint()],
    )
    port_vol = float(np.sqrt(w @ cov @ w))
    dr = float((w @ sigma) / port_vol) if port_vol > 0 else 1.0
    return success(
        MaxDivResult(weights=w.tolist(), diversification_ratio=dr, volatility=port_vol).model_dump()
    )


# ---------------------------------------------------------------------------
# 4. Factor-tilted
# ---------------------------------------------------------------------------

class FactorTiltedRequest(BaseModel):
    cov: list[list[float]]
    # K x N — row per factor, column per asset. exposures = B @ w.
    factor_loadings: list[list[float]]
    target_exposures: list[float]
    # Tilt away from this base while controlling tracking error. Omit → equal.
    base_weights: list[float] | None = None
    weight_bounds: tuple[float, float] = (0.0, 1.0)
    allow_short: bool = False


class FactorTiltedResult(BaseModel):
    weights: list[float]
    achieved_exposures: list[float]    # should ≈ target_exposures
    tracking_error: float              # √((w-b)ᵀΣ(w-b))
    volatility: float


@router.post("/factor-tilted")
def factor_tilted(req: FactorTiltedRequest) -> dict[str, object]:
    cov = _validate_cov(req.cov)
    n = cov.shape[0]
    B = np.asarray(req.factor_loadings, dtype=float)
    if B.ndim != 2 or B.shape[1] != n:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="factor_loadings must be K x N (N = number of assets)",
        )
    target = np.asarray(req.target_exposures, dtype=float)
    if target.size != B.shape[0]:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="target_exposures length must equal the number of factors (rows of factor_loadings)",
        )

    base = (
        np.asarray(req.base_weights, dtype=float)
        if req.base_weights is not None
        else np.full(n, 1.0 / n)
    )
    if base.size != n:
        raise AppError("VALIDATION_FAILED", status_code=400, message="base_weights length must match cov")

    def tracking_var(w: np.ndarray) -> float:
        d = w - base
        return float(d @ cov @ d)

    lo, hi = req.weight_bounds
    constraints = [
        _budget_constraint(),
        {"type": "eq", "fun": lambda w: (B @ w - target)},  # vector eq — SLSQP ok
    ]
    w = _solve(tracking_var, base.copy(), _bounds(n, lo, hi, req.allow_short), constraints)

    d = w - base
    return success(
        FactorTiltedResult(
            weights=w.tolist(),
            achieved_exposures=(B @ w).tolist(),
            tracking_error=float(np.sqrt(max(d @ cov @ d, 0.0))),
            volatility=float(np.sqrt(w @ cov @ w)),
        ).model_dump()
    )
