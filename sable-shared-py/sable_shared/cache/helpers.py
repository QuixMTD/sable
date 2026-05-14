"""Type-safe async Redis wrappers used across Sable Python services.

Philosophy (mirrors the TS side):
  - JSON in, JSON out for structured cache entries (``get_json`` / ``set_json``).
  - INCR / counter helpers stay strings — Redis handles them natively.
  - Errors raise. Callers decide whether to fail open (cache layer) or
    fail closed (rate limit, nonce dedup) — that policy belongs in the
    caller, not in the helper.
  - Every set carries an explicit TTL. Cache without TTL is a memory leak.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Awaitable, Callable, TypeVar

if TYPE_CHECKING:
    from redis.asyncio import Redis as RedisClient

T = TypeVar("T")


class CacheError(Exception):
    """Cache-layer failure (unparseable value, invalid TTL, etc.)."""

    def __init__(self, message: str, cause: BaseException | None = None) -> None:
        super().__init__(message)
        if cause is not None:
            self.__cause__ = cause


# ---------------------------------------------------------------------------
# JSON values
# ---------------------------------------------------------------------------

async def get_json(client: "RedisClient", key: str) -> Any | None:
    """GET, parsed as JSON. Returns ``None`` on miss. Raises ``CacheError``
    if the stored value is not valid JSON."""
    raw = await client.get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise CacheError(f"Cache value at {key} is not valid JSON", cause=e) from e


async def set_json(
    client: "RedisClient",
    key: str,
    value: Any,
    ttl_seconds: int,
) -> None:
    """SET key with EX TTL. TTL must be positive — no unbounded entries."""
    if ttl_seconds <= 0:
        raise CacheError(f"set_json called with non-positive TTL for {key}: {ttl_seconds}")
    await client.set(key, json.dumps(value), ex=ttl_seconds)


async def get_or_set(
    client: "RedisClient",
    key: str,
    ttl_seconds: int,
    loader: Callable[[], Awaitable[T | None]],
) -> T | None:
    """Cache-aside: try Redis, fall back to ``loader``, write through.

    A ``None`` return from ``loader`` means "no value found" — not cached.
    Negative caching is a separate decision; do it explicitly with
    ``set_json`` if needed.
    """
    cached = await get_json(client, key)
    if cached is not None:
        return cached  # type: ignore[no-any-return]

    fresh = await loader()
    if fresh is not None:
        await set_json(client, key, fresh, ttl_seconds)
    return fresh


# ---------------------------------------------------------------------------
# Existence + deletion
# ---------------------------------------------------------------------------

async def exists(client: "RedisClient", key: str) -> bool:
    return bool(await client.exists(key))


async def delete(client: "RedisClient", key: str) -> bool:
    """DEL — True if the key existed, False otherwise."""
    return bool(await client.delete(key))


async def delete_many(client: "RedisClient", keys: list[str]) -> int:
    """Bulk DEL — returns count actually deleted. No-op on empty input."""
    if not keys:
        return 0
    return int(await client.delete(*keys))


# ---------------------------------------------------------------------------
# Atomic counters
# ---------------------------------------------------------------------------

async def incr_with_ttl(client: "RedisClient", key: str, ttl_seconds: int) -> int:
    """Atomic INCR + EXPIRE-on-first-write. Subsequent INCRs do NOT reset
    the TTL — fixed-window rate-limit semantics.

    Uses the ``sable_incr_with_ttl`` script attached by ``create_redis()``.
    """
    if ttl_seconds <= 0:
        raise CacheError(f"incr_with_ttl called with non-positive TTL for {key}: {ttl_seconds}")
    script = getattr(client, "sable_incr_with_ttl", None)
    if script is None:
        raise CacheError(
            "incr_with_ttl requires a client built by sable_shared.config.redis.create_redis()",
        )
    return int(await script(keys=[key], args=[ttl_seconds]))


# ---------------------------------------------------------------------------
# Set-once (nonce dedup pattern)
# ---------------------------------------------------------------------------

async def set_once(
    client: "RedisClient",
    key: str,
    ttl_seconds: int,
    value: str = "1",
) -> bool:
    """SET key value EX ttl NX. Returns True if the key was set (first
    sighting), False if it already existed. A False return means replay
    attack at the nonce-dedup call site."""
    if ttl_seconds <= 0:
        raise CacheError(f"set_once called with non-positive TTL for {key}: {ttl_seconds}")
    result = await client.set(key, value, ex=ttl_seconds, nx=True)
    return result is True or result == "OK"
