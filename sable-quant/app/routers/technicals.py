"""Technical analysis — pure deterministic maths on an OHLCV series.

Asset-class agnostic by design: the same RSI / MACD / Ichimoku is
correct on an equity, a crypto pair or a property index. The module
service (sable-sc / sable-crypto / …) sources the OHLCV (e.g. via
EODHD) and posts it here; this router only does the maths.

POST /technicals   one workhorse — request a set of indicators on one
                   OHLCV series, get back length-aligned series (leading
                   warm-up positions are null, never fabricated) plus the
                   structural studies (Fibonacci levels, support /
                   resistance) that are level lists rather than series.

Conventions:
  * Every series indicator returns an array the same length as `close`,
    JSON-null for warm-up / undefined positions (NaN/inf are not valid
    JSON, so they are serialised as null).
  * Wilder smoothing is used for RSI / ATR / ADX (the standard for
    these); EMA uses the 2/(n+1) recursion seeded with the SMA.
  * Unknown indicator name, or one needing a series the caller did not
    supply (ATR needs high/low; OBV needs volume), → 400, no silent skip.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
from sable_shared.errors import AppError
from sable_shared.http import success

router = APIRouter(prefix="/technicals", tags=["technicals"])

_MAX_POINTS = 200_000


class IndicatorSpec(BaseModel):
    name: str = Field(..., description="sma|ema|wma|rsi|macd|bbands|stoch|atr|adx|obv|ichimoku|fib|sr")
    params: dict[str, float] = Field(default_factory=dict)


class TechRequest(BaseModel):
    close: list[float] = Field(..., min_length=2)
    high: list[float] | None = None
    low: list[float] | None = None
    open: list[float] | None = None
    volume: list[float] | None = None
    indicators: list[IndicatorSpec] = Field(..., min_length=1)


# --------------------------------------------------------------------------- #
# serialisation: NaN / ±inf are not valid JSON → null
# --------------------------------------------------------------------------- #

def _ser(a: np.ndarray) -> list[float | None]:
    out: list[float | None] = []
    for v in np.asarray(a, dtype=float).tolist():
        out.append(None if (v != v or v in (float("inf"), float("-inf"))) else float(v))
    return out


def _nan(n: int) -> np.ndarray:
    return np.full(n, np.nan)


# --------------------------------------------------------------------------- #
# series primitives
# --------------------------------------------------------------------------- #

def _sma(x: np.ndarray, n: int) -> np.ndarray:
    out = _nan(x.size)
    if n <= 0 or n > x.size:
        return out
    c = np.cumsum(np.insert(x, 0, 0.0))
    out[n - 1:] = (c[n:] - c[:-n]) / n
    return out


def _ema(x: np.ndarray, n: int) -> np.ndarray:
    out = _nan(x.size)
    if n <= 0 or n > x.size:
        return out
    alpha = 2.0 / (n + 1.0)
    out[n - 1] = x[:n].mean()
    for i in range(n, x.size):
        out[i] = alpha * x[i] + (1.0 - alpha) * out[i - 1]
    return out


def _wma(x: np.ndarray, n: int) -> np.ndarray:
    out = _nan(x.size)
    if n <= 0 or n > x.size:
        return out
    w = np.arange(1, n + 1, dtype=float)
    wsum = w.sum()
    for i in range(n - 1, x.size):
        out[i] = np.dot(x[i - n + 1:i + 1], w) / wsum
    return out


def _wilder(x: np.ndarray, n: int) -> np.ndarray:
    """Wilder's RMA — the smoothing behind RSI/ATR/ADX."""
    out = _nan(x.size)
    if n <= 0 or n > x.size:
        return out
    out[n - 1] = x[:n].mean()
    for i in range(n, x.size):
        out[i] = (out[i - 1] * (n - 1) + x[i]) / n
    return out


def _rsi(close: np.ndarray, n: int) -> np.ndarray:
    d = np.diff(close, prepend=close[0])
    gain = np.where(d > 0, d, 0.0)
    loss = np.where(d < 0, -d, 0.0)
    ag, al = _wilder(gain, n), _wilder(loss, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = ag / al
    rsi = 100.0 - 100.0 / (1.0 + rs)
    rsi[al == 0.0] = 100.0  # all-gain window → RSI 100
    rsi[:n] = np.nan
    return rsi


def _true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    prev = np.roll(close, 1)
    prev[0] = close[0]
    return np.maximum.reduce([high - low, np.abs(high - prev), np.abs(low - prev)])


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int) -> np.ndarray:
    return _wilder(_true_range(high, low, close), n)


def _adx(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int) -> dict[str, np.ndarray]:
    up = high - np.roll(high, 1)
    dn = np.roll(low, 1) - low
    up[0] = dn[0] = 0.0
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    atr = _wilder(_true_range(high, low, close), n)
    with np.errstate(divide="ignore", invalid="ignore"):
        plus_di = 100.0 * _wilder(plus_dm, n) / atr
        minus_di = 100.0 * _wilder(minus_dm, n) / atr
        dx = 100.0 * np.abs(plus_di - minus_di) / (plus_di + minus_di)
    adx = _wilder(np.nan_to_num(dx), n)
    adx[: 2 * n] = np.nan
    return {"plus_di": plus_di, "minus_di": minus_di, "adx": adx}


# --------------------------------------------------------------------------- #
# dispatch
# --------------------------------------------------------------------------- #

def _need(arr: list[float] | None, name: str, ind: str) -> np.ndarray:
    if arr is None:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message=f"indicator '{ind}' requires the '{name}' series",
        )
    return np.asarray(arr, dtype=float)


def _compute(spec: IndicatorSpec, req: TechRequest) -> object:
    name = spec.name.lower()
    p = spec.params
    close = np.asarray(req.close, dtype=float)
    n = close.size

    def ip(key: str, default: int) -> int:
        return int(p.get(key, default))

    if name == "sma":
        return _ser(_sma(close, ip("period", 20)))
    if name == "ema":
        return _ser(_ema(close, ip("period", 20)))
    if name == "wma":
        return _ser(_wma(close, ip("period", 20)))
    if name == "rsi":
        return _ser(_rsi(close, ip("period", 14)))

    if name == "macd":
        fast, slow, sig = ip("fast", 12), ip("slow", 26), ip("signal", 9)
        macd = _ema(close, fast) - _ema(close, slow)
        valid = macd[~np.isnan(macd)]
        sig_line = _nan(n)
        if valid.size:
            s = _ema(valid, sig)
            sig_line[n - valid.size:] = s
        return {"macd": _ser(macd), "signal": _ser(sig_line), "hist": _ser(macd - sig_line)}

    if name == "bbands":
        period, k = ip("period", 20), float(p.get("k", 2.0))
        mid = _sma(close, period)
        std = _nan(n)
        for i in range(period - 1, n):
            std[i] = close[i - period + 1:i + 1].std(ddof=0)
        return {"upper": _ser(mid + k * std), "mid": _ser(mid), "lower": _ser(mid - k * std)}

    if name == "stoch":
        high = _need(req.high, "high", "stoch")
        low = _need(req.low, "low", "stoch")
        kp, dp = ip("k", 14), ip("d", 3)
        pk = _nan(n)
        for i in range(kp - 1, n):
            hh = high[i - kp + 1:i + 1].max()
            ll = low[i - kp + 1:i + 1].min()
            rng = hh - ll
            pk[i] = 100.0 * (close[i] - ll) / rng if rng else 0.0
        return {"k": _ser(pk), "d": _ser(_sma(pk, dp))}

    if name == "atr":
        high = _need(req.high, "high", "atr")
        low = _need(req.low, "low", "atr")
        return _ser(_atr(high, low, close, ip("period", 14)))

    if name == "adx":
        high = _need(req.high, "high", "adx")
        low = _need(req.low, "low", "adx")
        r = _adx(high, low, close, ip("period", 14))
        return {k: _ser(v) for k, v in r.items()}

    if name == "obv":
        vol = _need(req.volume, "volume", "obv")
        sign = np.sign(np.diff(close, prepend=close[0]))
        return _ser(np.cumsum(sign * vol))

    if name == "ichimoku":
        high = _need(req.high, "high", "ichimoku")
        low = _need(req.low, "low", "ichimoku")
        t, k, b = ip("tenkan", 9), ip("kijun", 26), ip("senkou_b", 52)

        def midline(win: int) -> np.ndarray:
            o = _nan(n)
            for i in range(win - 1, n):
                o[i] = (high[i - win + 1:i + 1].max() + low[i - win + 1:i + 1].min()) / 2.0
            return o

        conv, base = midline(t), midline(k)
        span_a = np.roll((conv + base) / 2.0, k)
        span_a[:k] = np.nan
        span_b = np.roll(midline(b), k)
        span_b[:k] = np.nan
        lag = np.roll(close, -k).astype(float)
        lag[n - k:] = np.nan
        return {
            "conversion": _ser(conv),
            "base": _ser(base),
            "span_a": _ser(span_a),
            "span_b": _ser(span_b),
            "lagging": _ser(lag),
        }

    if name == "fib":
        lookback = ip("lookback", n)
        seg = close[-lookback:] if 0 < lookback <= n else close
        lo, hi = float(seg.min()), float(seg.max())
        rng = hi - lo
        ratios = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618]
        # retracement measured down from the swing high
        return {
            "swing_high": hi,
            "swing_low": lo,
            "levels": {f"{r:.3f}": hi - r * rng for r in ratios},
        }

    if name == "sr":
        win = ip("window", 5)
        tol = float(p.get("tolerance", 0.01))
        high = req.high if req.high is not None else req.close
        low = req.low if req.low is not None else req.close
        hi = np.asarray(high, dtype=float)
        lo = np.asarray(low, dtype=float)
        res, sup = [], []
        for i in range(win, n - win):
            if hi[i] == hi[i - win:i + win + 1].max():
                res.append(float(hi[i]))
            if lo[i] == lo[i - win:i + win + 1].min():
                sup.append(float(lo[i]))

        def cluster(levels: list[float]) -> list[float]:
            if not levels:
                return []
            levels = sorted(levels)
            groups: list[list[float]] = [[levels[0]]]
            for v in levels[1:]:
                if abs(v - groups[-1][-1]) <= tol * groups[-1][-1]:
                    groups[-1].append(v)
                else:
                    groups.append([v])
            return [round(float(np.mean(g)), 6) for g in groups]

        return {"support": cluster(sup), "resistance": cluster(res)}

    raise AppError(
        "VALIDATION_FAILED",
        status_code=400,
        message=f"unknown indicator '{spec.name}'",
    )


@router.post("")
def technicals(req: TechRequest) -> dict[str, object]:
    n = len(req.close)
    for series_name, series in (
        ("high", req.high), ("low", req.low), ("open", req.open), ("volume", req.volume)
    ):
        if series is not None and len(series) != n:
            raise AppError(
                "VALIDATION_FAILED",
                status_code=400,
                message=f"'{series_name}' length must equal 'close' length",
            )
    if n * len(req.indicators) > _MAX_POINTS:
        raise AppError(
            "VALIDATION_FAILED",
            status_code=400,
            message="points × indicators exceeds the compute guard",
        )

    out: dict[str, object] = {}
    for spec in req.indicators:
        key = spec.name.lower()
        if spec.params:
            key += "_" + "_".join(f"{k}{int(v) if v == int(v) else v}" for k, v in sorted(spec.params.items()))
        out[key] = _compute(spec, req)

    return success({"length": n, "indicators": out})
