"""Async Redis client factory shared by all Sable Python services.

Used for: rate limiting (per-user/org/IP counters), nonce dedup, session
cache, blocked-entity cache, bot-score counters, route cache. Per the
gateway DB doc: keys are namespaced — every key lives in
``sable_shared.cache.keys``.

``redis`` is an optional dependency of sable-shared — services that
import this module must include ``redis>=5`` in their own requirements.

Mirrors TS ``sable-shared/src/config/redis.ts``.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, cast

if TYPE_CHECKING:
    from redis.asyncio import Redis as RedisClient
else:
    try:
        from redis.asyncio import Redis as RedisClient
    except ImportError:  # pragma: no cover — optional dep
        RedisClient = None  # type: ignore[assignment, misc]


# Lua: atomic INCR + EXPIRE-on-first-write. Subsequent INCRs do NOT reset
# the TTL — fixed-window rate limit semantics.
_INCR_WITH_TTL_LUA = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
"""


@dataclass(frozen=True)
class RedisConfig:
    """Connection config for ``create_redis``.

    Use ``url`` OR explicit host/port, not both.
    """

    service_name: str
    url: str | None = None
    host: str = "127.0.0.1"
    port: int = 6379
    password: str | None = None
    db: int = 0
    tls: bool = False
    connect_timeout: float = 10.0


def create_redis(config: RedisConfig) -> "RedisClient":
    """Build an async Redis client and pre-register the IncrWithTtl script.

    The returned client decodes bytes to ``str`` by default — the Sable
    cache helpers (``set_json`` / ``get_json``) assume string mode.
    """
    if RedisClient is None:
        raise RuntimeError(
            "redis is not installed. Add 'redis>=5' to the service's dependencies "
            "if you need sable_shared.config.redis or sable_shared.cache.",
        )

    # Keep kwargs as Any so mypy strict accepts the **splat against
    # redis's heavily-overloaded constructor signature.
    common: dict[str, Any] = {
        "decode_responses": True,
        "client_name": config.service_name,
        "socket_connect_timeout": config.connect_timeout,
        "health_check_interval": 30,
    }
    if config.tls:
        common["ssl"] = True

    if config.url is not None:
        client = RedisClient.from_url(config.url, **common)
    else:
        client = RedisClient(
            host=config.host,
            port=config.port,
            password=config.password,
            db=config.db,
            **common,
        )

    # Attach the pre-registered script as ``client.sable_incr_with_ttl`` so
    # the cache helpers can call it without re-registering on every call.
    # ``register_script`` returns a callable that uses EVALSHA + falls back
    # to EVAL on NOSCRIPT.
    client.sable_incr_with_ttl = client.register_script(_INCR_WITH_TTL_LUA)  # type: ignore[attr-defined]

    return client


async def ping_redis(client: "RedisClient", timeout: float = 2.0) -> float:
    """Liveness check for ``/healthz``. Returns latency in ms or raises."""
    loop = asyncio.get_running_loop()
    start = loop.time()
    # `ping()` is typed as `Awaitable[bool] | bool` (the sync-cluster path);
    # in the asyncio client it's always awaitable — cast to keep mypy happy.
    async with asyncio.timeout(timeout):
        await cast(Awaitable[Any], client.ping())
    return (loop.time() - start) * 1000


async def close_redis(client: "RedisClient") -> None:
    """Graceful shutdown — call on SIGTERM."""
    await client.aclose()
