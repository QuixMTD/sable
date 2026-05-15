"""Backtesting.

quant is pure compute — it does NOT run strategy code (that's
sable-sandbox). The caller supplies the *decisions* (a weight schedule,
or per-fold weights an upstream model already fit) and a returns
matrix; this engine simulates the realised P&L net of transaction
cost + slippage, then scores it.

Three endpoints:

  /backtest/run           simulate a weight schedule on a returns
                          matrix with weight drift + turnover costs
  /backtest/walk-forward  evaluate per-fold OOS weights, stitch the
                          out-of-sample series, report IS-vs-OOS
                          degradation (the overfit tell)
  /backtest/metrics       the strategy-metrics suite from a return
                          series (+ optional trade records). Reused
                          internally by the two above.

Conventions (stated, not hidden):
  * one-way turnover at a rebalance = Σ|w_target − w_drifted|
  * cost charged that period = turnover · (cost_bps + slippage_bps)/1e4
  * between rebalances weights drift with returns:
        wᵢ' = wᵢ(1+rᵢ) / (1 + w·r)
  * Sortino downside dev uses the negative-return subset, ddof=1 —
    consistent with /risk so platform metrics agree
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/backtest", tags=["backtest"])


# ---------------------------------------------------------------------------
# Shared metric helpers
# ---------------------------------------------------------------------------

def _equity(r: np.ndarray) -> np.ndarray:
    return np.cumprod(1.0 + r)


def _max_drawdown(r: np.ndarray) -> float:
    eq = _equity(r)
    peak = np.maximum.accumulate(eq)
    return float(-(eq / peak - 1.0).min())


def _max_consecutive_losses(flags_loss: np.ndarray) -> int:
    longest = cur = 0
    for is_loss in flags_loss:
        cur = cur + 1 if is_loss else 0
        longest = max(longest, cur)
    return int(longest)


class Trade(BaseModel):
    pnl: float
    entry_index: int
    exit_index: int


def _strategy_metrics(
    returns: np.ndarray,
    ppy: int,
    risk_free: float,
    trades: list[Trade] | None,
) -> dict[str, object]:
    n = int(returns.size)
    mean = float(returns.mean())
    std = float(returns.std(ddof=1)) if n > 1 else 0.0
    rf_per = risk_free / ppy
    excess = returns - rf_per

    sharpe = float(excess.mean() / std * np.sqrt(ppy)) if std > 0 else None

    downside = returns[returns < 0.0]
    dd_dev = float(downside.std(ddof=1)) if downside.size > 1 else 0.0
    sortino = float(excess.mean() / dd_dev * np.sqrt(ppy)) if dd_dev > 0 else None

    eq_final = float(_equity(returns)[-1]) if n else 1.0
    cagr = float(eq_final ** (ppy / n) - 1.0) if n > 0 and eq_final > 0 else None
    mdd = _max_drawdown(returns) if n else 0.0
    calmar = float(cagr / mdd) if (cagr is not None and mdd > 0) else None

    gains = returns[returns > 0.0].sum()
    losses = -returns[returns < 0.0].sum()
    omega = float(gains / losses) if losses > 0 else None

    if trades:
        pnls = np.array([t.pnl for t in trades], dtype=float)
        wins = pnls[pnls > 0.0]
        loss = pnls[pnls < 0.0]
        win_rate = float(wins.size / pnls.size) if pnls.size else 0.0
        profit_factor = float(wins.sum() / -loss.sum()) if loss.sum() < 0 else None
        max_consec_losses = _max_consecutive_losses(pnls < 0.0)
        durations = np.array([t.exit_index - t.entry_index for t in trades], dtype=float)
        avg_trade_duration = float(durations.mean()) if durations.size else 0.0
        n_trades = int(pnls.size)
    else:
        # Return-series fallbacks (period-level proxies).
        win_rate = float((returns > 0.0).sum() / n) if n else 0.0
        profit_factor = float(gains / losses) if losses > 0 else None
        max_consec_losses = _max_consecutive_losses(returns < 0.0)
        avg_trade_duration = None
        n_trades = None

    return {
        "n_periods": n,
        "total_return": float(eq_final - 1.0) if n else 0.0,
        "cagr": cagr,
        "ann_volatility": float(std * np.sqrt(ppy)) if std > 0 else 0.0,
        "sharpe": sharpe,
        "sortino": sortino,
        "calmar": calmar,
        "omega": omega,
        "max_drawdown": mdd,
        "win_rate": win_rate,
        "profit_factor": profit_factor,
        "max_consecutive_losses": max_consec_losses,
        "avg_trade_duration": avg_trade_duration,
        "n_trades": n_trades,
    }


# ---------------------------------------------------------------------------
# Core simulation
# ---------------------------------------------------------------------------

def _simulate(
    R: np.ndarray,                     # T x N asset returns
    weights_schedule: np.ndarray,      # T x N target weights (per period)
    rebalance_idx: set[int],
    cost_bps: float,
    slippage_bps: float,
) -> dict[str, np.ndarray]:
    T, N = R.shape
    cost_rate = (cost_bps + slippage_bps) / 1e4

    w = weights_schedule[0].copy()      # initial allocation
    gross = np.empty(T)
    net = np.empty(T)
    turn = np.zeros(T)

    for t in range(T):
        rt = R[t]
        g = float(w @ rt)
        gross[t] = g
        # Drift weights through the period.
        denom = 1.0 + g
        w_post = (w * (1.0 + rt) / denom) if denom != 0 else w.copy()

        if t in rebalance_idx and t + 1 < T:
            target = weights_schedule[t + 1]
            to = float(np.abs(target - w_post).sum())
            turn[t] = to
            net[t] = g - to * cost_rate
            w = target.copy()
        else:
            net[t] = g
            w = w_post

    return {"gross": gross, "net": net, "turnover": turn}


def _coerce_weights(weights: list[float] | list[list[float]], T: int, N: int) -> np.ndarray:
    arr = np.asarray(weights, dtype=float)
    if arr.ndim == 1:
        if arr.size != N:
            raise AppError("VALIDATION_FAILED", status_code=400, message="static weights length must equal #assets")
        return np.tile(arr, (T, 1))
    if arr.shape != (T, N):
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="weight schedule must be T x N matching the returns matrix",
        )
    return arr


# ---------------------------------------------------------------------------
# /backtest/run
# ---------------------------------------------------------------------------

class RunRequest(BaseModel):
    # T x N asset returns.
    returns: list[list[float]] = Field(..., min_length=2)
    # Static vector (length N, rebalanced) OR a T x N schedule.
    weights: list[float] | list[list[float]]
    # Period indices at which to rebalance back to target. Omit →
    # rebalance every period.
    rebalance_periods: list[int] | None = None
    cost_bps: float = Field(0.0, ge=0.0, description="Proportional transaction cost, bps of turnover")
    slippage_bps: float = Field(0.0, ge=0.0, description="Slippage, bps of turnover")
    periods_per_year: int = Field(252, ge=1, le=365)
    risk_free_rate: float = 0.0


class RunResult(BaseModel):
    metrics: dict[str, object]
    gross_total_return: float
    net_total_return: float
    total_cost: float          # cumulative cost drag (gross − net, return space)
    avg_turnover: float
    equity_curve: list[float]  # net, starting at 1.0


@router.post("/run")
def run(req: RunRequest) -> dict[str, object]:
    R = np.asarray(req.returns, dtype=float)
    if R.ndim != 2:
        raise AppError("VALIDATION_FAILED", status_code=400, message="returns must be a T x N matrix")
    T, N = R.shape
    W = _coerce_weights(req.weights, T, N)

    if req.rebalance_periods is None:
        reb = set(range(T))
    else:
        reb = {i for i in req.rebalance_periods if 0 <= i < T}

    sim = _simulate(R, W, reb, req.cost_bps, req.slippage_bps)
    net, gross, turn = sim["net"], sim["gross"], sim["turnover"]

    metrics = _strategy_metrics(net, req.periods_per_year, req.risk_free_rate, trades=None)
    gross_tot = float(_equity(gross)[-1] - 1.0)
    net_tot = float(_equity(net)[-1] - 1.0)

    return success(
        RunResult(
            metrics=metrics,
            gross_total_return=gross_tot,
            net_total_return=net_tot,
            total_cost=gross_tot - net_tot,
            avg_turnover=float(turn.mean()),
            equity_curve=_equity(net).tolist(),
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# /backtest/walk-forward
# ---------------------------------------------------------------------------

class Fold(BaseModel):
    train_start: int
    train_end: int             # exclusive
    test_start: int
    test_end: int              # exclusive
    # Weights the upstream model fit on this fold's train window, applied
    # (static, rebalanced each period) across the test window.
    weights: list[float]


class WalkForwardRequest(BaseModel):
    returns: list[list[float]] = Field(..., min_length=2)
    folds: list[Fold] = Field(..., min_length=1)
    cost_bps: float = Field(0.0, ge=0.0)
    slippage_bps: float = Field(0.0, ge=0.0)
    periods_per_year: int = Field(252, ge=1, le=365)
    risk_free_rate: float = 0.0


class FoldResult(BaseModel):
    fold: int
    is_sharpe: float | None    # in-sample Sharpe (same weights on train slice)
    oos_sharpe: float | None   # out-of-sample Sharpe
    oos_return: float


class WalkForwardResult(BaseModel):
    oos_metrics: dict[str, object]      # stitched out-of-sample series
    per_fold: list[FoldResult]
    is_oos_sharpe_ratio: float | None   # mean(OOS Sharpe) / mean(IS Sharpe); <1 ⇒ decay


@router.post("/walk-forward")
def walk_forward(req: WalkForwardRequest) -> dict[str, object]:
    R = np.asarray(req.returns, dtype=float)
    if R.ndim != 2:
        raise AppError("VALIDATION_FAILED", status_code=400, message="returns must be a T x N matrix")
    T, N = R.shape

    oos_chunks: list[np.ndarray] = []
    per_fold: list[FoldResult] = []
    is_sharpes: list[float] = []
    oos_sharpes: list[float] = []

    for k, f in enumerate(req.folds):
        for a, b, label in (
            (f.train_start, f.train_end, "train"),
            (f.test_start, f.test_end, "test"),
        ):
            if not (0 <= a < b <= T):
                raise AppError(
                    "VALIDATION_FAILED",
                    status_code=400,
                    message=f"fold {k} {label} window [{a},{b}) out of range for T={T}",
                )
        w = np.asarray(f.weights, dtype=float)
        if w.size != N:
            raise AppError(
                "VALIDATION_FAILED",
                status_code=400,
                message=f"fold {k} weights length must equal #assets ({N})",
            )

        def _series(lo: int, hi: int) -> np.ndarray:
            sub = R[lo:hi]
            wsched = np.tile(w, (sub.shape[0], 1))
            return _simulate(sub, wsched, set(range(sub.shape[0])), req.cost_bps, req.slippage_bps)["net"]

        is_net = _series(f.train_start, f.train_end)
        oos_net = _series(f.test_start, f.test_end)
        oos_chunks.append(oos_net)

        is_m = _strategy_metrics(is_net, req.periods_per_year, req.risk_free_rate, None)
        oos_m = _strategy_metrics(oos_net, req.periods_per_year, req.risk_free_rate, None)
        is_sh = is_m["sharpe"]
        oos_sh = oos_m["sharpe"]
        if isinstance(is_sh, (int, float)):
            is_sharpes.append(float(is_sh))
        if isinstance(oos_sh, (int, float)):
            oos_sharpes.append(float(oos_sh))

        per_fold.append(
            FoldResult(
                fold=k,
                is_sharpe=is_sh if isinstance(is_sh, (int, float)) else None,
                oos_sharpe=oos_sh if isinstance(oos_sh, (int, float)) else None,
                oos_return=float(_equity(oos_net)[-1] - 1.0),
            )
        )

    stitched = np.concatenate(oos_chunks) if oos_chunks else np.array([0.0])
    oos_metrics = _strategy_metrics(stitched, req.periods_per_year, req.risk_free_rate, None)

    is_oos_ratio: float | None = None
    if is_sharpes and oos_sharpes:
        is_mean = float(np.mean(is_sharpes))
        if is_mean != 0:
            is_oos_ratio = float(np.mean(oos_sharpes) / is_mean)

    return success(
        WalkForwardResult(
            oos_metrics=oos_metrics,
            per_fold=per_fold,
            is_oos_sharpe_ratio=is_oos_ratio,
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# /backtest/metrics
# ---------------------------------------------------------------------------

class MetricsRequest(BaseModel):
    returns: list[float] = Field(..., min_length=2, description="Strategy periodic returns")
    periods_per_year: int = Field(252, ge=1, le=365)
    risk_free_rate: float = 0.0
    # Optional trade records → proper win rate / profit factor /
    # consecutive losses / avg duration. Omit → period-level proxies.
    trades: list[Trade] | None = None


@router.post("/metrics")
def metrics(req: MetricsRequest) -> dict[str, object]:
    r = np.asarray(req.returns, dtype=float)
    return success(
        _strategy_metrics(r, req.periods_per_year, req.risk_free_rate, req.trades)
    )
