"""Factor models — one OLS workhorse behind a `model` discriminator.

excess_return_t = α + Σ βᵢ·factorᵢ_t + εₜ

The named models (FF3 / FF5 / Carhart-4) just assert which factor
series must be present; `custom` takes an arbitrary factor dict. Every
call returns the same rich result so the four spec bullets —
exposure decomposition (the βs), factor attribution (βᵢ·mean(factorᵢ)),
residual alpha (the intercept), and the model fit — come from one
endpoint.

quant is pure compute: it does NOT fetch Fama-French data. sable-sc
serves the factor return series; sable-engine injects them here.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/factors", tags=["factors"])

# Required factor keys per named model. 'custom' accepts any non-empty set.
_REQUIRED: dict[str, list[str]] = {
    "ff3": ["mkt_rf", "smb", "hml"],
    "ff5": ["mkt_rf", "smb", "hml", "rmw", "cma"],
    "carhart4": ["mkt_rf", "smb", "hml", "mom"],
}


class FactorRegressionRequest(BaseModel):
    # Asset / portfolio periodic simple returns.
    returns: list[float] = Field(..., min_length=10)
    model: str = Field("custom", description="ff3 | ff5 | carhart4 | custom")
    # name → factor return series, each same length as `returns`.
    factors: dict[str, list[float]] = Field(..., min_length=1)
    # Risk-free: scalar per-period, or a series same length as returns.
    # `mkt_rf` is already an excess series, so rf only nets the LHS.
    risk_free: float | list[float] = 0.0
    periods_per_year: int = Field(252, ge=1, le=365)


class FactorContribution(BaseModel):
    factor: str
    beta: float
    t_stat: float
    p_value: float
    mean_factor: float
    return_contribution: float     # βᵢ · mean(factorᵢ)
    pct_of_mean_return: float | None


class FactorRegressionResult(BaseModel):
    model: str
    n_obs: int
    alpha_period: float            # intercept, per period
    alpha_annualised: float        # residual alpha — unexplained return
    alpha_t_stat: float
    alpha_p_value: float
    r_squared: float
    adj_r_squared: float
    residual_std: float            # per-period σ(ε)
    factors: list[FactorContribution]
    mean_return: float
    explained_return: float        # Σ contributions
    unexplained_return: float      # mean_return − explained − alpha ≈ mean(ε)


def _ols(y: np.ndarray, x: np.ndarray):
    """OLS with an explicit intercept column. statsmodels is a hard dep
    (also pulled by arch); import lazily to keep cold-start cheap for
    the non-factor endpoints."""
    import statsmodels.api as sm

    design = sm.add_constant(x, has_constant="add")
    return sm.OLS(y, design).fit()


@router.post("/regress")
def regress(req: FactorRegressionRequest) -> dict[str, object]:
    n = len(req.returns)
    y = np.asarray(req.returns, dtype=float)

    # Validate the factor set for named models.
    required = _REQUIRED.get(req.model)
    if req.model not in {"ff3", "ff5", "carhart4", "custom"}:
        raise AppError("VALIDATION_FAILED", status_code=400, message="model must be ff3 | ff5 | carhart4 | custom")
    if required is not None:
        missing = [k for k in required if k not in req.factors]
        if missing:
            raise AppError(
                "VALIDATION_FAILED",
                status_code=400,
                message=f"model '{req.model}' requires factors {required}; missing {missing}",
            )
        factor_names = required
    else:
        factor_names = list(req.factors.keys())

    # Build the factor matrix in a deterministic column order.
    cols = []
    for name in factor_names:
        series = req.factors[name]
        if len(series) != n:
            raise AppError(
                "VALIDATION_FAILED",
                status_code=400,
                message=f"factor '{name}' length {len(series)} != returns length {n}",
            )
        cols.append(np.asarray(series, dtype=float))
    x = np.column_stack(cols)

    # Net risk-free off the LHS (mkt_rf is already an excess series).
    if isinstance(req.risk_free, list):
        rf = np.asarray(req.risk_free, dtype=float)
        if rf.size != n:
            raise AppError("VALIDATION_FAILED", status_code=400, message="risk_free series length must match returns")
    else:
        rf = float(req.risk_free)
    y_excess = y - rf

    if n <= x.shape[1] + 1:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="not enough observations for the number of factors (need n > k+1)",
        )

    res = _ols(y_excess, x)
    params = np.asarray(res.params, dtype=float)
    tvals = np.asarray(res.tvalues, dtype=float)
    pvals = np.asarray(res.pvalues, dtype=float)

    alpha = float(params[0])
    ppy = req.periods_per_year
    alpha_ann = float((1.0 + alpha) ** ppy - 1.0)

    mean_y = float(y_excess.mean())
    contributions: list[FactorContribution] = []
    explained = 0.0
    for i, name in enumerate(factor_names):
        beta = float(params[i + 1])
        mf = float(x[:, i].mean())
        contrib = beta * mf
        explained += contrib
        contributions.append(
            FactorContribution(
                factor=name,
                beta=beta,
                t_stat=float(tvals[i + 1]),
                p_value=float(pvals[i + 1]),
                mean_factor=mf,
                return_contribution=contrib,
                pct_of_mean_return=(contrib / mean_y * 100.0) if mean_y != 0 else None,
            )
        )

    return success(
        FactorRegressionResult(
            model=req.model,
            n_obs=n,
            alpha_period=alpha,
            alpha_annualised=alpha_ann,
            alpha_t_stat=float(tvals[0]),
            alpha_p_value=float(pvals[0]),
            r_squared=float(res.rsquared),
            adj_r_squared=float(res.rsquared_adj),
            residual_std=float(np.std(res.resid, ddof=x.shape[1] + 1)),
            factors=contributions,
            mean_return=mean_y,
            explained_return=explained,
            unexplained_return=mean_y - explained - alpha,
        ).model_dump()
    )
