"""All Redis key patterns in one place. Source of truth: gateway DB doc §
"Redis Keys". Every key the platform reads or writes goes through a
builder here — no ad-hoc f-strings at call sites.

Mirrors TS ``sable-shared/src/cache/keys.ts``. Change one, change both.
"""

from __future__ import annotations

from typing import Literal

# ---------------------------------------------------------------------------
# Shared entity-type unions (mirror the DB CHECK constraints)
# ---------------------------------------------------------------------------

BlockEntityType = Literal["ip", "user_id", "org_id", "device_fingerprint"]
WhitelistEntityType = Literal["admin_account", "org", "global"]
RateWindow = Literal["minute", "hour", "day"]


# ---------------------------------------------------------------------------
# Key builders — module-level functions, all return ``str``.
# ---------------------------------------------------------------------------

def rate_user(user_id: str, window: RateWindow) -> str:
    """Per-user request count. Window keyed separately so we don't reset on
    hour boundaries."""
    return f"rate:user:{user_id}:{window}"


def rate_org(org_id: str) -> str:
    """Per-org aggregate request count (minute window only)."""
    return f"rate:org:{org_id}:minute"


def rate_ip(ip: str) -> str:
    """Per-IP request count (minute window only)."""
    return f"rate:ip:{ip}:minute"


def modules_user(user_id: str) -> str:
    """Cached active_modules array — invalidated on module change."""
    return f"modules:user:{user_id}"


def jwt_blacklist(jti: str) -> str:
    """Revoked JWTs — TTL = remaining JWT lifetime."""
    return f"blacklist:jwt:{jti}"


def nonce(nonce_value: str) -> str:
    """Used HMAC nonces — 30s window matching used_nonces table."""
    return f"nonce:{nonce_value}"


def block_cache(entity_type: BlockEntityType, value: str) -> str:
    """Mirror of active blocked_entities rows."""
    return f"block:cache:{entity_type}:{value}"


def whitelist_cache(entity_type: WhitelistEntityType, value: str) -> str:
    """Mirror of active ip_whitelist rows."""
    return f"whitelist:cache:{entity_type}:{value}"


def session(session_id: str) -> str:
    """Cached session state — TTL = remaining session lifetime."""
    return f"session:{session_id}"


def bot_requests_50ms(user_id: str) -> str:
    """Bot detection: request frequency counter (sub-50ms inter-request gaps)."""
    return f"bot:requests:{user_id}:50ms"


def bot_pattern_regularity(ip: str) -> str:
    """Bot detection: regularity (auto-driven request patterns)."""
    return f"bot:pattern:{ip}:regularity"


def bot_mouse(user_id: str) -> str:
    """Bot detection: interaction telemetry variance (mouse / keyboard)."""
    return f"bot:mouse:{user_id}"


def route_cache() -> str:
    """Cached service_routes table for routing."""
    return "route:cache"


def hmac_versions() -> str:
    """Cached active HMAC key versions."""
    return "hmac:versions"


def fingerprint_user(user_id: str) -> str:
    """Cached trusted device fingerprints for a user."""
    return f"fingerprint:user:{user_id}"


def config_cache() -> str:
    """Cached gateway_config key/value store."""
    return "config:cache"


def cors_origins() -> str:
    """Cached allowed CORS origins."""
    return "cors:origins"


def health(service_name: str) -> str:
    """Latest health status snapshot per downstream service."""
    return f"health:{service_name}"
