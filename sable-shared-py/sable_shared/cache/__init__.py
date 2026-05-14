"""Redis cache helpers — keys, TTLs, and async I/O wrappers.

Requires the optional ``redis>=5`` dependency. Import ``cache_keys`` and
``TTL`` constants without installing redis (those modules are dep-free);
the I/O helpers in ``helpers`` need a client built by
``sable_shared.config.redis.create_redis``.
"""

from sable_shared.cache import keys as cache_keys
from sable_shared.cache import ttl as TTL  # noqa: N812 — matches TS naming
from sable_shared.cache.helpers import (
    CacheError,
    delete,
    delete_many,
    exists,
    get_json,
    get_or_set,
    incr_with_ttl,
    set_json,
    set_once,
)

__all__ = [
    "cache_keys",
    "TTL",
    "CacheError",
    "delete",
    "delete_many",
    "exists",
    "get_json",
    "get_or_set",
    "incr_with_ttl",
    "set_json",
    "set_once",
]
