"""Portfolio risk + performance metrics from a return series.

Everything here is pure-numpy and deterministic — no optimisation, no
randomness. Returns are treated as periodic simple returns; annualise
with `periods_per_year` (252 daily, 52 weekly, 12 monthly).
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/risk", tags=["risk"])


class RiskRequest(BaseModel):
    returns: list[float] = Field(..., min_length=2, description="Periodic simple returns")
    periods_per_year: int = Field(252, ge=1, le=365)
    risk_free_rate: float = Field(0.0, description="Annualised risk-free rate")
    confidence: float = Field(0.95, gt=0.5, lt=1.0, description="VaR/CVaR confidence")
    benchmark: list[float] | None = Field(
        None, description="Benchmark returns, same length, for beta/alpha"
    )


class RiskResult(BaseModel):
    n: int
    ann_return: float
    ann_volatility: float
    sharpe: float
    sortino: float
    max_drawdown: float
    var: float           # historical, fractional loss at `confidence`
    cvar: float          # mean loss beyond VaR
    skew: float
    kurtosis: float       # excess kurtosis
    beta: float | None
    alpha: float | None   # annualised Jensen's alpha


def _max_drawdown(returns: np.ndarray) -> float:
    equity = np.cumprod(1.0 + returns)
    peak = np.maximum.accumulate(equity)
    dd = equity / peak - 1.0
    return float(-dd.min())  # positive number


@router.post("")
def compute_risk(req: RiskRequest) -> dict[str, object]:
    r = np.asarray(req.returns, dtype=float)
    ppy = req.periods_per_year
    rf_per = req.risk_free_rate / ppy

    mean = float(r.mean())
    std = float(r.std(ddof=1))
    if std == 0.0:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="return series has zero variance — metrics undefined",
        )

    ann_return = float((1.0 + mean) ** ppy - 1.0)
    ann_vol = float(std * np.sqrt(ppy))

    excess = r - rf_per
    sharpe = float(excess.mean() / std * np.sqrt(ppy))

    downside = r[r < 0.0]
    downside_dev = float(downside.std(ddof=1)) if downside.size > 1 else 0.0
    sortino = (
        float(excess.mean() / downside_dev * np.sqrt(ppy)) if downside_dev > 0 else float("inf")
    )

    pct = (1.0 - req.confidence) * 100.0
    var_q = np.percentile(r, pct)
    tail = r[r <= var_q]
    var = float(-var_q)
    cvar = float(-tail.mean()) if tail.size else var

    # Moments
    z = (r - mean) / std
    skew = float((z ** 3).mean())
    kurt = float((z ** 4).mean() - 3.0)

    beta: float | None = None
    alpha: float | None = None
    if req.benchmark is not None:
        b = np.asarray(req.benchmark, dtype=float)
        if b.size != r.size:
            raise AppError(
                "VALIDATION_FAILED",
                status_code=400,
                message="benchmark must match returns length",
            )
        bvar = float(b.var(ddof=1))
        if bvar > 0:
            beta = float(np.cov(r, b, ddof=1)[0, 1] / bvar)
            # Annualised Jensen's alpha
            alpha = float(
                (r.mean() - rf_per) - beta * (b.mean() - rf_per)
            ) * ppy

    return success(
        RiskResult(
            n=int(r.size),
            ann_return=ann_return,
            ann_volatility=ann_vol,
            sharpe=sharpe,
            sortino=sortino,
            max_drawdown=_max_drawdown(r),
            var=var,
            cvar=cvar,
            skew=skew,
            kurtosis=kurt,
            beta=beta,
            alpha=alpha,
        ).model_dump()
    )
