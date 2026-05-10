import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/montecarlo", tags=["montecarlo"])


class MonteCarloRequest(BaseModel):
    prices: list[float] = Field(..., min_length=2, description="Historical close prices")
    horizon_days: int = Field(252, ge=1, le=10_000)
    simulations: int = Field(10_000, ge=100, le=200_000)
    seed: int | None = None


class MonteCarloResponse(BaseModel):
    mean: float
    std: float
    p5: float
    p50: float
    p95: float


@router.post("", response_model=MonteCarloResponse)
def run_montecarlo(req: MonteCarloRequest) -> MonteCarloResponse:
    rng = np.random.default_rng(req.seed)
    prices = np.asarray(req.prices, dtype=float)
    log_returns = np.diff(np.log(prices))
    mu = log_returns.mean()
    sigma = log_returns.std(ddof=1)

    shocks = rng.normal(mu, sigma, size=(req.simulations, req.horizon_days))
    terminal = prices[-1] * np.exp(shocks.sum(axis=1))

    return MonteCarloResponse(
        mean=float(terminal.mean()),
        std=float(terminal.std(ddof=1)),
        p5=float(np.percentile(terminal, 5)),
        p50=float(np.percentile(terminal, 50)),
        p95=float(np.percentile(terminal, 95)),
    )
