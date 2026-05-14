"""Canonical list of PII / secret field names — anything matching here
gets redacted before a log write. Source: every 🔐 or #️⃣ column in the
schema, plus standard auth/transport headers.

Matching is case-insensitive and ignores ``_`` / ``-`` so the same entry
covers ``password_hash`` / ``passwordHash`` / ``password-hash`` /
``PasswordHash``.

Mirrors TS ``sable-shared/src/logging/sensitiveFields.ts``.
"""

from __future__ import annotations

from typing import Final

SENSITIVE_FIELDS: Final[tuple[str, ...]] = (
    # Passwords
    "password",
    "password_hash",

    # Tokens (request and storage forms)
    "token",
    "access_token",
    "refresh_token",
    "session_token",
    "session_token_hash",
    "jwt",
    "bearer",
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api_key",
    "apikey",
    "key",
    "key_hash",

    # Crypto material
    "secret",
    "totp_secret",
    "totp",
    "dek",
    "nonce",
    "private_key",

    # Direct PII
    "email",
    "email_lookup",            # SHA-256(email) is still identifying
    "phone",
    "mobile",
    "date_of_birth",
    "dob",
    "birthday",

    # Addresses
    "address",
    "street_address",
    "registered_address",
    "delivery_address",
    "postcode",
    "zip_code",

    # Financial
    "paypal_email",
    "card_number",
    "cvv",
    "cvc",
    "iban",
    "account_number",
    "sort_code",
    "routing_number",
    "stripe_secret_key",

    # Third-party creds (user_integrations etc.)
    "credentials",
    "kms_key",

    # Identifying hashes
    "token_hash",
    "fingerprint_hash",
    "device_fingerprint_hash",
)


def normalise_field(name: str) -> str:
    """Lowercase + strip ``_`` and ``-`` for canonical matching."""
    return name.lower().replace("_", "").replace("-", "")


SENSITIVE_FIELD_SET: Final[frozenset[str]] = frozenset(normalise_field(f) for f in SENSITIVE_FIELDS)


def is_sensitive_field(name: str, extras: frozenset[str] | None = None) -> bool:
    """True if the (possibly mixed-case) field is sensitive.

    ``extras`` must already be normalised via ``normalise_field``.
    """
    norm = normalise_field(name)
    if norm in SENSITIVE_FIELD_SET:
        return True
    return extras is not None and norm in extras
