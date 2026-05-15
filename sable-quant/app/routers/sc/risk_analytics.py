"""Risk analytics — the granular toolkit beyond the /risk summary
bundle. Each endpoint is a focused instrument; the existing POST /risk
stays as the dashboard one-shot.

Sign convention (matches /risk): VaR / CVaR / drawdown are returned as
**positive loss fractions** (0.05 = a 5% loss), so bigger = worse.

Parametric pieces assume Gaussian returns — stated, not hidden. The
VaR decomposition uses Euler allocation so component VaRs sum to the
total (a property the tests assert).
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from scipy import stats
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/risk", tags=["risk-analytics"])


def _z(confidence: float) -> float:
    """Positive normal quantile for a confidence level (0.95 → 1.645)."""
    return float(-stats.norm.ppf(1.0 - confidence))


# ---------------------------------------------------------------------------
# VaR / CVaR — historical | parametric | monte_carlo
# ---------------------------------------------------------------------------

class VarRequest(BaseModel):
    returns: list[float] = Field(..., min_length=2, description="Periodic simple returns")
    method: str = Field("historical", description="historical | parametric | monte_carlo")
    confidence: float = Field(0.95, gt=0.5, lt=1.0)
    horizon_days: int = Field(1, ge=1, le=10_000)
    simulations: int = Field(50_000, ge=1_000, le=500_000)
    seed: int | None = None


class VarResult(BaseModel):
    method: str
    confidence: float
    horizon_days: int
    var: float
    cvar: float


@router.post("/var")
def value_at_risk(req: VarRequest) -> dict[str, object]:
    r = np.asarray(req.returns, dtype=float)
    h = req.horizon_days
    c = req.confidence

    if req.method == "historical":
        # √h scaling of the per-period historical quantile.
        q = np.percentile(r, (1.0 - c) * 100.0)
        tail = r[r <= q]
        var = float(-q * np.sqrt(h))
        cvar = float(-tail.mean() * np.sqrt(h)) if tail.size else var
    elif req.method == "parametric":
        mu, sigma = float(r.mean()), float(r.std(ddof=1))
        if sigma == 0.0:
            raise AppError("VALIDATION_FAILED", status_code=400, message="zero-variance series")
        z = _z(c)
        mu_h, sig_h = mu * h, sigma * np.sqrt(h)
        var = float(-(mu_h - z * sig_h))
        # Gaussian expected shortfall.
        es = -(mu_h - sig_h * stats.norm.pdf(stats.norm.ppf(1.0 - c)) / (1.0 - c))
        cvar = float(es)
    elif req.method == "monte_carlo":
        mu, sigma = float(r.mean()), float(r.std(ddof=1))
        if sigma == 0.0:
            raise AppError("VALIDATION_FAILED", status_code=400, message="zero-variance series")
        rng = np.random.default_rng(req.seed)
        sims = rng.normal(mu, sigma, size=(req.simulations, h)).sum(axis=1)
        q = np.percentile(sims, (1.0 - c) * 100.0)
        tail = sims[sims <= q]
        var = float(-q)
        cvar = float(-tail.mean()) if tail.size else var
    else:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="method must be historical | parametric | monte_carlo",
        )

    return success(
        VarResult(
            method=req.method, confidence=c, horizon_days=h,
            var=max(var, 0.0), cvar=max(cvar, 0.0),
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# VaR decomposition — marginal / component / incremental (parametric)
# ---------------------------------------------------------------------------

class NewPosition(BaseModel):
    weight: float = Field(..., description="Weight of the candidate position")
    # Covariances of the new asset with each existing asset, then its own
    # variance last — length N+1.
    cov_row: list[float]


class DecompRequest(BaseModel):
    weights: list[float]
    cov: list[list[float]]
    confidence: float = Field(0.95, gt=0.5, lt=1.0)
    new_position: NewPosition | None = None


class DecompResult(BaseModel):
    portfolio_var: float
    marginal_var: list[float]      # ∂VaR/∂wᵢ
    component_var: list[float]     # wᵢ · marginalᵢ — sums to portfolio_var
    incremental_var: float | None  # VaR(with new) − VaR(without)


def _parametric_var(w: np.ndarray, cov: np.ndarray, z: float) -> float:
    return float(z * np.sqrt(w @ cov @ w))


@router.post("/decomposition")
def var_decomposition(req: DecompRequest) -> dict[str, object]:
    w = np.asarray(req.weights, dtype=float)
    cov = np.asarray(req.cov, dtype=float)
    n = w.size
    if cov.shape != (n, n):
        raise AppError("VALIDATION_FAILED", status_code=400, message="cov must be NxN matching weights")

    z = _z(req.confidence)
    sigma_p = float(np.sqrt(w @ cov @ w))
    if sigma_p == 0.0:
        raise AppError("VALIDATION_FAILED", status_code=400, message="degenerate portfolio (zero variance)")

    var_p = z * sigma_p
    marginal = z * (cov @ w) / sigma_p         # ∂VaR/∂wᵢ
    component = w * marginal                    # Euler — Σ component = var_p

    incremental: float | None = None
    if req.new_position is not None:
        np_ = req.new_position
        cr = np.asarray(np_.cov_row, dtype=float)
        if cr.size != n + 1:
            raise AppError(
                "VALIDATION_FAILED",
                status_code=400,
                message="new_position.cov_row must be length N+1 (covs with existing, then own variance)",
            )
        # Build the augmented (N+1) covariance + renormalised weights.
        aug = np.zeros((n + 1, n + 1))
        aug[:n, :n] = cov
        aug[:n, n] = cr[:n]
        aug[n, :n] = cr[:n]
        aug[n, n] = cr[n]
        w_aug = np.append(w, np_.weight)
        s = w_aug.sum()
        if s != 0:
            w_aug = w_aug / s
        incremental = float(_parametric_var(w_aug, aug, z) - var_p)

    return success(
        DecompResult(
            portfolio_var=float(var_p),
            marginal_var=marginal.tolist(),
            component_var=component.tolist(),
            incremental_var=incremental,
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# Volatility — realised | EWMA | GARCH(1,1)
# ---------------------------------------------------------------------------

class VolRequest(BaseModel):
    returns: list[float] = Field(..., min_length=10)
    periods_per_year: int = Field(252, ge=1, le=365)
    ewma_lambda: float = Field(0.94, gt=0.5, lt=1.0, description="RiskMetrics decay")


class VolResult(BaseModel):
    realised: float            # annualised sample stdev
    ewma: float                # annualised latest EWMA stdev
    garch: float | None        # annualised GARCH(1,1) 1-step conditional vol
    garch_params: dict[str, float] | None
    garch_error: str | None    # populated iff GARCH was unavailable/failed


@router.post("/volatility")
def volatility(req: VolRequest) -> dict[str, object]:
    r = np.asarray(req.returns, dtype=float)
    ann = np.sqrt(req.periods_per_year)

    realised = float(r.std(ddof=1) * ann)

    # RiskMetrics EWMA: σ²_t = λσ²_{t-1} + (1-λ)r²_{t-1}; seed with sample var.
    lam = req.ewma_lambda
    var_t = float(r.var(ddof=1))
    for x in r:
        var_t = lam * var_t + (1.0 - lam) * x * x
    ewma = float(np.sqrt(var_t) * ann)

    # GARCH is one of three vol estimates — if it's unavailable (arch not
    # installed) or the fit fails (non-convergence on a pathological
    # series), realised + EWMA are still correct and useful, so we
    # degrade to a 200 with garch=null + garch_error rather than failing
    # the whole endpoint.
    garch: float | None = None
    garch_params: dict[str, float] | None = None
    garch_error: str | None = None
    try:
        from arch import arch_model  # lazy — heavy import

        # arch wants percent-scaled returns; scale in, scale vol out.
        am = arch_model(r * 100.0, mean="Constant", vol="GARCH", p=1, q=1, dist="normal")
        res = am.fit(disp="off")
        next_var_pct = float(res.forecast(horizon=1).variance.values[-1, 0])
        garch = float(np.sqrt(next_var_pct) / 100.0 * ann)
        garch_params = {
            "omega": float(res.params.get("omega", float("nan"))),
            "alpha": float(res.params.get("alpha[1]", float("nan"))),
            "beta": float(res.params.get("beta[1]", float("nan"))),
        }
    except ImportError:
        garch_error = "arch not installed"
    except Exception as e:  # noqa: BLE001 — optional analytic, must not 500/422 the endpoint
        garch_error = f"GARCH fit failed: {e}"

    return success(
        VolResult(
            realised=realised,
            ewma=ewma,
            garch=garch,
            garch_params=garch_params,
            garch_error=garch_error,
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# Drawdown — max / average / recovery time
# ---------------------------------------------------------------------------

class DrawdownRequest(BaseModel):
    returns: list[float] = Field(..., min_length=2)


class DrawdownResult(BaseModel):
    max_drawdown: float
    average_drawdown: float          # mean of the negative-DD observations
    current_drawdown: float
    max_recovery_periods: int        # longest peak→reclaim gap (0 = never breached / fully recovered fast)
    in_drawdown: bool


@router.post("/drawdown")
def drawdown(req: DrawdownRequest) -> dict[str, object]:
    r = np.asarray(req.returns, dtype=float)
    equity = np.cumprod(1.0 + r)
    peak = np.maximum.accumulate(equity)
    dd = equity / peak - 1.0

    neg = dd[dd < 0.0]
    # Longest stretch where the running peak was not reclaimed.
    longest = cur = 0
    for under in dd < 0.0:
        cur = cur + 1 if under else 0
        longest = max(longest, cur)

    return success(
        DrawdownResult(
            max_drawdown=float(-dd.min()),
            average_drawdown=float(-neg.mean()) if neg.size else 0.0,
            current_drawdown=float(-dd[-1]),
            max_recovery_periods=int(longest),
            in_drawdown=bool(dd[-1] < 0.0),
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# Tail risk — skew / kurtosis / Omega / tail ratio
# ---------------------------------------------------------------------------

class TailRequest(BaseModel):
    returns: list[float] = Field(..., min_length=3)
    omega_threshold: float = Field(0.0, description="Return threshold for the Omega ratio")


class TailResult(BaseModel):
    skewness: float
    excess_kurtosis: float
    omega_ratio: float          # Σ gains above θ / Σ losses below θ
    tail_ratio: float           # |95th pct| / |5th pct|
    gain_loss_ratio: float


@router.post("/tail")
def tail_risk(req: TailRequest) -> dict[str, object]:
    r = np.asarray(req.returns, dtype=float)
    mean, std = float(r.mean()), float(r.std(ddof=1))
    if std == 0.0:
        raise AppError("VALIDATION_FAILED", status_code=400, message="zero-variance series")

    z = (r - mean) / std
    th = req.omega_threshold
    gains = (r[r > th] - th).sum()
    losses = (th - r[r < th]).sum()
    omega = float(gains / losses) if losses > 0 else float("inf")

    p95, p5 = np.percentile(r, 95), np.percentile(r, 5)
    tail_ratio = float(abs(p95) / abs(p5)) if p5 != 0 else float("inf")

    pos = r[r > 0]
    negv = r[r < 0]
    gl = float(pos.mean() / -negv.mean()) if negv.size and pos.size else float("inf")

    return success(
        TailResult(
            skewness=float((z ** 3).mean()),
            excess_kurtosis=float((z ** 4).mean() - 3.0),
            omega_ratio=omega,
            tail_ratio=tail_ratio,
            gain_loss_ratio=gl,
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# Stress testing — custom shock scenarios
# ---------------------------------------------------------------------------

class Scenario(BaseModel):
    name: str
    # Per-asset return shocks (length N). Use this OR factor_shocks.
    asset_shocks: list[float] | None = None
    # Factor-level shocks (length K); requires factor_loadings on the request.
    factor_shocks: list[float] | None = None


class StressRequest(BaseModel):
    weights: list[float]
    scenarios: list[Scenario] = Field(..., min_length=1)
    # K x N — needed only for factor-level scenarios. exposures = B·w.
    factor_loadings: list[list[float]] | None = None
    portfolio_value: float = Field(1.0, gt=0, description="Scale P&L into currency if given")


class ScenarioResult(BaseModel):
    name: str
    portfolio_return: float
    pnl: float


@router.post("/stress")
def stress_test(req: StressRequest) -> dict[str, object]:
    w = np.asarray(req.weights, dtype=float)
    n = w.size
    B = np.asarray(req.factor_loadings, dtype=float) if req.factor_loadings is not None else None
    if B is not None and (B.ndim != 2 or B.shape[1] != n):
        raise AppError("VALIDATION_FAILED", status_code=400, message="factor_loadings must be K x N")

    out: list[ScenarioResult] = []
    for sc in req.scenarios:
        if sc.asset_shocks is not None:
            shock = np.asarray(sc.asset_shocks, dtype=float)
            if shock.size != n:
                raise AppError(
                    "VALIDATION_FAILED",
                    status_code=400,
                    message=f"scenario '{sc.name}': asset_shocks length must match weights",
                )
        elif sc.factor_shocks is not None:
            if B is None:
                raise AppError(
                    "VALIDATION_FAILED",
                    status_code=400,
                    message=f"scenario '{sc.name}': factor_shocks requires factor_loadings",
                )
            f = np.asarray(sc.factor_shocks, dtype=float)
            if f.size != B.shape[0]:
                raise AppError(
                    "VALIDATION_FAILED",
                    status_code=400,
                    message=f"scenario '{sc.name}': factor_shocks length must equal #factors",
                )
            shock = B.T @ f          # asset returns implied by the factor move
        else:
            raise AppError(
                "VALIDATION_FAILED",
                status_code=400,
                message=f"scenario '{sc.name}': provide asset_shocks or factor_shocks",
            )

        port_ret = float(w @ shock)
        out.append(
            ScenarioResult(
                name=sc.name,
                portfolio_return=port_ret,
                pnl=port_ret * req.portfolio_value,
            )
        )

    return success({"scenarios": [s.model_dump() for s in out]})


# ---------------------------------------------------------------------------
# Liquidity-adjusted VaR (exogenous-spread / Bangia)
# ---------------------------------------------------------------------------

class LiquidityVarRequest(BaseModel):
    # Base market VaR as a positive loss fraction (from /risk/var).
    base_var: float = Field(..., ge=0.0)
    weights: list[float]
    # Proportional bid-ask spread per position (e.g. 0.001 = 10bps).
    spreads: list[float]
    # Per-position spread volatility (Bangia term). Omit → 0.
    spread_vols: list[float] | None = None
    spread_vol_k: float = Field(3.0, ge=0.0, description="Std multiplier on spread vol")


class LiquidityVarResult(BaseModel):
    base_var: float
    liquidity_cost: float
    liquidity_adjusted_var: float


@router.post("/liquidity-var")
def liquidity_var(req: LiquidityVarRequest) -> dict[str, object]:
    w = np.asarray(req.weights, dtype=float)
    s = np.asarray(req.spreads, dtype=float)
    if s.size != w.size:
        raise AppError("VALIDATION_FAILED", status_code=400, message="spreads length must match weights")
    sv = (
        np.asarray(req.spread_vols, dtype=float)
        if req.spread_vols is not None
        else np.zeros(w.size)
    )
    if sv.size != w.size:
        raise AppError("VALIDATION_FAILED", status_code=400, message="spread_vols length must match weights")

    # Half-spread liquidation cost per position, position-weighted.
    per_pos = 0.5 * (s + req.spread_vol_k * sv)
    liq_cost = float(np.sum(np.abs(w) * per_pos))

    return success(
        LiquidityVarResult(
            base_var=req.base_var,
            liquidity_cost=liq_cost,
            liquidity_adjusted_var=req.base_var + liq_cost,
        ).model_dump()
    )
