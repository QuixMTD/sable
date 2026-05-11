"""Exponential-backoff retry for outbound HTTP and other transient calls.

Use only for idempotent operations. Default policy: 3 attempts, 100ms
base delay with full jitter, doubling each retry, capped at 2 seconds.

The `should_retry` callable lets you scope the retry to specific errors
(network timeouts, 5xx responses, etc.) — the default retries on common
transient exceptions only, never on 4xx.
"""

from __future__ import annotations

import asyncio
import random
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")

# Module-level exception names so we don't import httpx / requests just to
# typecheck — the default `should_retry` looks them up by class name.
_TRANSIENT_EXCEPTION_NAMES = frozenset(
    {
        "TimeoutError",
        "ConnectionError",
        "ConnectError",
        "ReadTimeout",
        "WriteTimeout",
        "ConnectTimeout",
        "PoolTimeout",
        "RemoteProtocolError",
    }
)


def _default_should_retry(err: BaseException, _attempt: int) -> bool:
    if err.__class__.__name__ in _TRANSIENT_EXCEPTION_NAMES:
        return True
    status = getattr(err, "status_code", None) or getattr(err, "status", None)
    if isinstance(status, int) and 500 <= status < 600:
        return True
    return False


async def with_retry(
    fn: Callable[[], Awaitable[T]],
    *,
    attempts: int = 3,
    base_ms: int = 100,
    max_ms: int = 2_000,
    should_retry: Callable[[BaseException, int], bool] = _default_should_retry,
    on_retry: Callable[[BaseException, int, int], None] | None = None,
) -> T:
    last_err: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await fn()
        except BaseException as err:  # noqa: BLE001 — caller decides via should_retry
            last_err = err
            if attempt == attempts or not should_retry(err, attempt):
                raise
            delay_ms = random.randint(0, min(max_ms, base_ms * (2 ** (attempt - 1))))
            if on_retry is not None:
                on_retry(err, attempt, delay_ms)
            await asyncio.sleep(delay_ms / 1000)
    # Unreachable — either return or re-raise above.
    assert last_err is not None
    raise last_err
