"""All cache TTLs in seconds. Source of truth: gateway DB doc § "Redis
Keys".

Two TTLs are deliberately omitted as constants:
  - JWT_BLACKLIST: TTL is the JWT's remaining lifetime, computed at write time
  - SESSION:       TTL is the session's remaining lifetime, ditto

Use the JWT/session ``expires_at - now()`` at the call site instead.

Mirrors TS ``sable-shared/src/cache/ttl.ts``.
"""

from __future__ import annotations

from typing import Final

# Per-user / per-org / per-IP rate-limit windows
RATE_USER_MINUTE: Final[int] = 60
RATE_USER_HOUR: Final[int] = 3_600
RATE_USER_DAY: Final[int] = 86_400
RATE_ORG_MINUTE: Final[int] = 60
RATE_IP_MINUTE: Final[int] = 60

# Cached active_modules array — short window so module changes propagate quickly
MODULES_USER: Final[int] = 300

# HMAC replay-attack window — must match used_nonces.expires_at
NONCE: Final[int] = 30

# Mirror of blocked_entities — short so unblocks propagate quickly
BLOCK_CACHE: Final[int] = 60
# Mirror of ip_whitelist
WHITELIST_CACHE: Final[int] = 300

# Bot detection counters
BOT_REQUESTS_50MS: Final[int] = 60
BOT_PATTERN_REGULARITY: Final[int] = 300
BOT_MOUSE: Final[int] = 600

# Long-lived config caches (1 hour) — invalidated explicitly on admin write
ROUTE_CACHE: Final[int] = 3_600
HMAC_VERSIONS: Final[int] = 3_600
FINGERPRINT_USER: Final[int] = 3_600
CONFIG_CACHE: Final[int] = 3_600
CORS_ORIGINS: Final[int] = 3_600

# Per-service health snapshot — must be shorter than the gap between probes
HEALTH: Final[int] = 30
