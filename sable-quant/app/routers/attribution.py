"""Performance attribution.

Three endpoints cover the spec:

  /attribution/brinson       segment BHB: allocation / selection /
                             interaction (additive — they sum to the
                             total active return). Optional
                             Brinson-Fachler allocation variant.
  /attribution/active-share  holding-level 0.5·Σ|w_p−w_b|
  /attribution/tracking      benchmark-relative return, tracking error,
                             information ratio (from return series)

Brinson works on a *snapshot* of segment weights+returns; tracking
works on *time series*. Different inputs, kept as separate endpoints so
the caller isn't forced to supply both.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/attribution", tags=["performance-attribution"])


# ---------------------------------------------------------------------------
# Brinson-Hood-Beebower (and Brinson-Fachler variant)
# ---------------------------------------------------------------------------

class Segment(BaseModel):
    name: str
    w_p: float = Field(..., description="Portfolio weight in this segment")
    r_p: float = Field(..., description="Portfolio return within this segment")
    w_b: float = Field(..., description="Benchmark weight in this segment")
    r_b: float = Field(..., description="Benchmark return within this segment")


class BrinsonRequest(BaseModel):
    segments: list[Segment] = Field(..., min_length=1)
    method: str = Field("bhb", description="bhb | brinson_fachler")


class SegmentEffect(BaseModel):
    name: str
    allocation: float
    selection: float
    interaction: float
    total: float


class BrinsonResult(BaseModel):
    method: str
    portfolio_return: float
    benchmark_return: float
    total_active_return: float
    allocation_effect: float
    selection_effect: float
    interaction_effect: float
    by_segment: list[SegmentEffect]
    # Σ(effects) should equal total_active_return. BHB: always. BF: only
    # if both weight vectors sum to 1 (Σ(w_p−w_b)=0 kills the −R_b term).
    identity_residual: float
    weights_sum_to_one: bool


@router.post("/brinson")
def brinson(req: BrinsonRequest) -> dict[str, object]:
    if req.method not in {"bhb", "brinson_fachler"}:
        raise AppError("VALIDATION_FAILED", status_code=400, message="method must be bhb | brinson_fachler")

    wp = np.array([s.w_p for s in req.segments], dtype=float)
    rp = np.array([s.r_p for s in req.segments], dtype=float)
    wb = np.array([s.w_b for s in req.segments], dtype=float)
    rb = np.array([s.r_b for s in req.segments], dtype=float)

    R_p = float(wp @ rp)
    R_b = float(wb @ rb)

    if req.method == "brinson_fachler":
        allocation = (wp - wb) * (rb - R_b)
    else:  # bhb
        allocation = (wp - wb) * rb
    selection = wb * (rp - rb)
    interaction = (wp - wb) * (rp - rb)

    by_segment = [
        SegmentEffect(
            name=req.segments[i].name,
            allocation=float(allocation[i]),
            selection=float(selection[i]),
            interaction=float(interaction[i]),
            total=float(allocation[i] + selection[i] + interaction[i]),
        )
        for i in range(len(req.segments))
    ]

    alloc_t = float(allocation.sum())
    sel_t = float(selection.sum())
    inter_t = float(interaction.sum())
    total_active = R_p - R_b
    residual = (alloc_t + sel_t + inter_t) - total_active

    return success(
        BrinsonResult(
            method=req.method,
            portfolio_return=R_p,
            benchmark_return=R_b,
            total_active_return=total_active,
            allocation_effect=alloc_t,
            selection_effect=sel_t,
            interaction_effect=inter_t,
            by_segment=by_segment,
            identity_residual=residual,
            weights_sum_to_one=bool(
                abs(wp.sum() - 1.0) < 1e-9 and abs(wb.sum() - 1.0) < 1e-9
            ),
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# Active share
# ---------------------------------------------------------------------------

class ActiveShareRequest(BaseModel):
    # security id → weight. Securities may appear in one side only.
    portfolio: dict[str, float] = Field(..., min_length=1)
    benchmark: dict[str, float] = Field(..., min_length=1)


class ActiveShareResult(BaseModel):
    active_share: float       # 0 = benchmark clone, 1 = fully distinct
    overlap_weight: float     # Σ min(w_p, w_b)
    n_holdings_union: int


@router.post("/active-share")
def active_share(req: ActiveShareRequest) -> dict[str, object]:
    keys = set(req.portfolio) | set(req.benchmark)
    diff = 0.0
    overlap = 0.0
    for k in keys:
        wp = float(req.portfolio.get(k, 0.0))
        wb = float(req.benchmark.get(k, 0.0))
        diff += abs(wp - wb)
        overlap += min(wp, wb)
    return success(
        ActiveShareResult(
            active_share=0.5 * diff,
            overlap_weight=overlap,
            n_holdings_union=len(keys),
        ).model_dump()
    )


# ---------------------------------------------------------------------------
# Tracking error / information ratio / benchmark-relative return
# ---------------------------------------------------------------------------

class TrackingRequest(BaseModel):
    portfolio_returns: list[float] = Field(..., min_length=2)
    benchmark_returns: list[float] = Field(..., min_length=2)
    periods_per_year: int = Field(252, ge=1, le=365)


class TrackingResult(BaseModel):
    n: int
    tracking_error: float          # annualised σ(active)
    active_return_annualised: float
    information_ratio: float       # active_return / tracking_error
    cumulative_portfolio: float    # compounded total return
    cumulative_benchmark: float
    cumulative_active: float


@router.post("/tracking")
def tracking(req: TrackingRequest) -> dict[str, object]:
    p = np.asarray(req.portfolio_returns, dtype=float)
    b = np.asarray(req.benchmark_returns, dtype=float)
    if p.size != b.size:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="portfolio_returns and benchmark_returns must be the same length",
        )

    active = p - b
    ppy = req.periods_per_year
    te_period = float(active.std(ddof=1))
    te = te_period * np.sqrt(ppy)
    active_ann = float(active.mean()) * ppy
    ir = float(active.mean() / te_period * np.sqrt(ppy)) if te_period > 0 else float("inf")

    cum_p = float(np.prod(1.0 + p) - 1.0)
    cum_b = float(np.prod(1.0 + b) - 1.0)

    return success(
        TrackingResult(
            n=int(p.size),
            tracking_error=te,
            active_return_annualised=active_ann,
            information_ratio=ir,
            cumulative_portfolio=cum_p,
            cumulative_benchmark=cum_b,
            cumulative_active=cum_p - cum_b,
        ).model_dump()
    )
