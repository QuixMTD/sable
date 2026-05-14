"""App-layer hashing — stdlib ``hashlib`` / ``hmac`` wrapped for ergonomics.

DB-layer hashing (token lookups, email_lookup) happens via the
``digest()`` SQL function inside the schema. App-layer hashing here is
for cases where the Python service must compute the same hash *before*
the query — e.g. computing ``email_lookup = sha256(lower(email))`` for a
lookup, or verifying an HMAC on an inbound service-auth request.

Outputs are ``bytes`` by default — matches BYTEA columns directly and
avoids hex round-trips when writing to the DB.

Mirrors TS ``sable-shared/src/crypto/hash.ts``.
"""

from __future__ import annotations

import hashlib
import hmac


# ---------------------------------------------------------------------------
# SHA-256
# ---------------------------------------------------------------------------

def sha256(value: str | bytes) -> bytes:
    """SHA-256 → bytes (32). Matches BYTEA columns directly."""
    data = value.encode() if isinstance(value, str) else value
    return hashlib.sha256(data).digest()


def sha256_hex(value: str | bytes) -> str:
    """SHA-256 → hex string. Use for logs / URL params; for DB writes use ``sha256()``."""
    data = value.encode() if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# HMAC-SHA-256 — service-to-service request signing, webhook verify
# ---------------------------------------------------------------------------

def hmac_sha256(key: str | bytes, message: str | bytes) -> bytes:
    key_bytes = key.encode() if isinstance(key, str) else key
    msg_bytes = message.encode() if isinstance(message, str) else message
    return hmac.new(key_bytes, msg_bytes, hashlib.sha256).digest()


def hmac_sha256_hex(key: str | bytes, message: str | bytes) -> str:
    return hmac_sha256(key, message).hex()


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

def constant_time_equal(a: bytes, b: bytes) -> bool:
    """Constant-time equality. Required for any hash/HMAC/token comparison
    an attacker could time. Length mismatch returns False (not throws)."""
    return hmac.compare_digest(a, b)


# ---------------------------------------------------------------------------
# Domain helpers
# ---------------------------------------------------------------------------

def email_lookup(email: str) -> bytes:
    """Compute the email lookup hash. MUST match the schema's expression —
    both sides do ``trim`` + ``lower`` + sha256 so a user pasting their
    email with trailing whitespace doesn't silently fail login.

    Schema-side equivalent: ``digest(lower(btrim($1)), 'sha256')``.
    Change one, change both.
    """
    return sha256(email.strip().lower())
