"""Shared Python library for Sable FastAPI services.

Subpackages:
    cache/          Redis helpers + key/TTL constants (needs optional `redis` dep)
    config/         env-var loading, Redis client factory
    constants/      actor types, user/admin roles, module codes
    crypto/         sha256, hmac-sha256, constant-time compare, email_lookup
    errors/         AppError, ERROR_CODES, format_error
    http/           success/failure response envelope
    log_safety/     PII redaction (``redact``, sensitive-field list)
    middleware/     ASGI middleware (service_auth, request_id, logger, error_handler)
    utils/          contextvars (user/org/role/request_id), retry helper
"""
