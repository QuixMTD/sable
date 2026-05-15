"""Monte Carlo simulation.

POST /montecarlo            legacy single-asset GBM from a price series
                            (kept for back-compat).
POST /montecarlo/simulate   the full engine: GBM or Merton
                            jump-diffusion, correlated multi-asset,
                            constant-weight portfolio value path,
                            P(target) / P(ruin) (path-minimum barrier),
                            5/25/50/75/95 bands, VaR/CVaR.

Asset-class agnostic by design — equities feed it return series;
crypto feeds it the same with its own annualisation/parameters;
property feeds it regional-growth scenario distributions. The maths is
identical; the per-module *profile* lives in the calling module
service, not here.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/montecarlo", tags=["montecarlo"])

_MAX_CELLS = 2_000_000_000  # simulations * horizon guard
_MAX_SIM_OPS = 800_000_000  # simulations * horizon * assets runtime guard


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


# ---------------------------------------------------------------------------
# Full engine: GBM / Merton, correlated multi-asset, portfolio path
# ---------------------------------------------------------------------------

def _safe_cholesky(cov: np.ndarray) -> np.ndarray:
    """Lower-triangular factor of `cov`. Estimated covariances aren't
    always PD — fall back to an eigen clip (PSD repair) so a slightly
    non-PD sample matrix doesn't 500 the endpoint."""
    try:
        return np.linalg.cholesky(cov)
    except np.linalg.LinAlgError:
        vals, vecs = np.linalg.eigh(cov)
        vals = np.clip(vals, 1e-12, None)
        repaired = (vecs * vals) @ vecs.T
        return np.linalg.cholesky(repaired)


class MCSimRequest(BaseModel):
    # N assets × T history of periodic SIMPLE returns. N=1 allowed.
    returns: list[list[float]] = Field(..., min_length=1)
    model: str = Field("gbm", description="gbm | merton")
    weights: list[float] | None = Field(None, description="Portfolio weights (len N); default equal")
    horizon_days: int = Field(252, ge=1, le=10_000)
    simulations: int = Field(10_000, ge=100, le=500_000)
    seed: int | None = None
    start_value: float = Field(1.0, gt=0.0)
    target_return: float | None = Field(None, description="P(terminal/start − 1 ≥ this)")
    ruin_threshold: float | None = Field(
        None, gt=-1.0, lt=0.0, description="Ruin if the path value ever ≤ start·(1+this), e.g. -0.5"
    )
    # Merton jump params (per period). Ignored for model=gbm.
    jump_intensity: float = Field(0.0, ge=0.0, description="Expected jumps per period (λ)")
    jump_mean: float = Field(0.0, description="Mean of the log jump size")
    jump_std: float = Field(0.0, ge=0.0, description="Std of the log jump size")


class MCSimResult(BaseModel):
    model: str
    simulations: int
    horizon_days: int
    start_value: float
    terminal_mean: float
    terminal_std: float
    terminal_ci: dict[str, float]      # p5 / p25 / p50 / p75 / p95 of terminal value
    return_ci: dict[str, float]        # same percentiles on portfolio return
    prob_target: float | None
    prob_ruin: float | None
    var_95: float
    cvar_95: float


@router.post("/simulate")
def simulate(req: MCSimRequest) -> dict[str, object]:
    if req.model not in {"gbm", "merton"}:
        raise AppError("VALIDATION_FAILED", status_code=400, message="model must be gbm | merton")

    R = np.asarray(req.returns, dtype=float)          # (N, T)
    if R.ndim != 2:
        raise AppError("VALIDATION_FAILED", status_code=400, message="returns must be N × T")
    n_assets, t_hist = R.shape
    if t_hist < 2:
        raise AppError("VALIDATION_FAILED", status_code=400, message="each asset needs ≥2 return observations")
    if np.any(R <= -1.0):
        raise AppError("VALIDATION_FAILED", status_code=400, message="returns ≤ -100% are invalid")

    H, S = req.horizon_days, req.simulations
    if S * H * n_assets > _MAX_SIM_OPS:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="simulations × horizon × assets exceeds the compute guard",
        )

    if req.weights is None:
        w = np.full(n_assets, 1.0 / n_assets)
    else:
        w = np.asarray(req.weights, dtype=float)
        if w.size != n_assets:
            raise AppError("VALIDATION_FAILED", status_code=400, message="weights length must equal #assets")
        s = w.sum()
        if s <= 0:
            raise AppError("VALIDATION_FAILED", status_code=400, message="weights must sum to a positive number")
        w = w / s  # constant-weight portfolio

    # Estimate per-period log-return drift + covariance.
    lr = np.log1p(R)                                  # (N, T)
    mu = lr.mean(axis=1)                               # (N,)
    if n_assets == 1:
        L = np.array([[float(lr.std(ddof=1))]])
    else:
        L = _safe_cholesky(np.cov(lr))                 # (N, N)

    rng = np.random.default_rng(req.seed)
    V0 = req.start_value

    # Merton drift compensator so the jump component doesn't bias the mean.
    if req.model == "merton" and req.jump_intensity > 0.0:
        k = np.exp(req.jump_mean + 0.5 * req.jump_std ** 2) - 1.0
        comp = req.jump_intensity * k
    else:
        comp = 0.0

    prices = np.ones((S, n_assets))                    # relative prices, start = 1
    port_val = np.full(S, V0)
    running_min = port_val.copy()

    for _ in range(H):
        z = rng.standard_normal((S, n_assets))
        step_log = mu + z @ L.T                         # correlated diffusion
        if req.model == "merton" and req.jump_intensity > 0.0:
            counts = rng.poisson(req.jump_intensity, size=(S, n_assets)).astype(float)
            jump = rng.standard_normal((S, n_assets)) * (np.sqrt(counts) * req.jump_std)
            jump += counts * req.jump_mean
            step_log = step_log - comp + jump
        prices *= np.exp(step_log)
        port_val = V0 * (prices @ w)
        running_min = np.minimum(running_min, port_val)

    terminal = port_val
    port_ret = terminal / V0 - 1.0

    def pcts(a: np.ndarray) -> dict[str, float]:
        q = np.percentile(a, [5, 25, 50, 75, 95])
        return {"p5": float(q[0]), "p25": float(q[1]), "p50": float(q[2]), "p75": float(q[3]), "p95": float(q[4])}

    pr_p5 = np.percentile(port_ret, 5)
    tail = port_ret[port_ret <= pr_p5]

    prob_target = (
        float(np.mean(port_ret >= req.target_return)) if req.target_return is not None else None
    )
    prob_ruin = (
        float(np.mean(running_min <= V0 * (1.0 + req.ruin_threshold)))
        if req.ruin_threshold is not None
        else None
    )

    return success(
        MCSimResult(
            model=req.model,
            simulations=S,
            horizon_days=H,
            start_value=V0,
            terminal_mean=float(terminal.mean()),
            terminal_std=float(terminal.std(ddof=1)),
            terminal_ci=pcts(terminal),
            return_ci=pcts(port_ret),
            prob_target=prob_target,
            prob_ruin=prob_ruin,
            var_95=float(-pr_p5),
            cvar_95=float(-tail.mean()) if tail.size else float(-pr_p5),
        ).model_dump()
    )
