"""Error codes used across all Sable services. Each entry pairs the
semantic code with its default HTTP status and message. Callers raise
``AppError(code)`` and the AppError class fills in defaults from this
table.

Source of truth alongside the TypeScript ``sable-shared/src/errors/codes.ts``
— the two tables MUST stay in lock-step so a code thrown by one service
renders identically on the wire whether the caller is Node or Python.

Adding a new code: pick the right HTTP status from the buckets below.
Don't invent a status that doesn't fit — extend a bucket or split one.
"""

from __future__ import annotations

from typing import Final, Literal, TypedDict


class ErrorCodeEntry(TypedDict):
    status: int
    message: str


ERROR_CODES: Final[dict[str, ErrorCodeEntry]] = {
    # 400 — bad request / client-side validation failures
    "VALIDATION_FAILED":        {"status": 400, "message": "Validation failed"},
    "INVALID_UUID":             {"status": 400, "message": "Invalid UUID"},
    "INVALID_MODULE_CODE":      {"status": 400, "message": "Invalid module code"},
    "MISSING_FIELD":            {"status": 400, "message": "Required field missing"},
    "SANDBOX_FORBIDDEN_IMPORT": {"status": 400, "message": "Forbidden import in sandbox code"},

    # 401 — unauthenticated
    "AUTH_FAILED":              {"status": 401, "message": "Authentication failed"},
    "TOKEN_EXPIRED":            {"status": 401, "message": "Token expired"},
    "TOKEN_INVALID":            {"status": 401, "message": "Token invalid"},
    "SESSION_EXPIRED":          {"status": 401, "message": "Session expired"},
    "SESSION_REVOKED":          {"status": 401, "message": "Session revoked"},
    "INVALID_HMAC":             {"status": 401, "message": "Invalid HMAC signature"},
    "REPLAY_ATTACK":            {"status": 401, "message": "Nonce already used"},
    "API_KEY_INVALID":          {"status": 401, "message": "API key invalid"},

    # 403 — authenticated but not authorised
    "FORBIDDEN":                {"status": 403, "message": "Forbidden"},
    "MODULE_NOT_ACTIVE":        {"status": 403, "message": "Module not activated for this user"},
    "INSUFFICIENT_ROLE":        {"status": 403, "message": "Insufficient role"},
    "ADMIN_ONLY":               {"status": 403, "message": "Admin only"},
    "SUPER_ADMIN_ONLY":         {"status": 403, "message": "Super admin only"},
    "IP_BLOCKED":               {"status": 403, "message": "IP blocked"},
    "ENTITY_BLOCKED":           {"status": 403, "message": "Entity blocked"},
    "BOT_DETECTED":             {"status": 403, "message": "Bot detected"},
    "SUBSCRIPTION_PAST_DUE":    {"status": 403, "message": "Subscription past due"},
    "SUBSCRIPTION_CANCELLED":   {"status": 403, "message": "Subscription cancelled"},
    "TRIAL_ENDED":              {"status": 403, "message": "Trial ended"},

    # 404 — resource missing
    "NOT_FOUND":                {"status": 404, "message": "Resource not found"},

    # 409 — state conflict
    "ALREADY_EXISTS":           {"status": 409, "message": "Resource already exists"},
    "CONFLICT":                 {"status": 409, "message": "Conflict"},

    # 410 — once-valid resource is permanently gone
    "INVITE_EXPIRED":           {"status": 410, "message": "Invite expired"},

    # 422 — semantically wrong input that passed shape validation
    "INVALID_INVITE_TOKEN":     {"status": 422, "message": "Invalid invite token"},

    # 429 — rate limited
    "RATE_LIMIT_EXCEEDED":      {"status": 429, "message": "Rate limit exceeded"},

    # 500 — our fault
    "INTERNAL_ERROR":           {"status": 500, "message": "Internal error"},
    "DATABASE_ERROR":           {"status": 500, "message": "Database error"},
    "CACHE_ERROR":              {"status": 500, "message": "Cache error"},
    "KMS_FAILURE":              {"status": 500, "message": "KMS failure"},

    # 502 — downstream third-party fault
    "DOWNSTREAM_FAILURE":       {"status": 502, "message": "Downstream service failure"},
    "EODHD_FAILURE":            {"status": 502, "message": "Market data fetch failed"},
    "STRIPE_FAILURE":           {"status": 502, "message": "Stripe API failure"},

    # 504 — downstream timeout
    "SANDBOX_TIMEOUT":          {"status": 504, "message": "Sandbox execution timed out"},
}


# Literal union of every known code. Mypy catches typos at call sites.
ErrorCode = Literal[
    "VALIDATION_FAILED", "INVALID_UUID", "INVALID_MODULE_CODE", "MISSING_FIELD",
    "SANDBOX_FORBIDDEN_IMPORT",
    "AUTH_FAILED", "TOKEN_EXPIRED", "TOKEN_INVALID", "SESSION_EXPIRED",
    "SESSION_REVOKED", "INVALID_HMAC", "REPLAY_ATTACK", "API_KEY_INVALID",
    "FORBIDDEN", "MODULE_NOT_ACTIVE", "INSUFFICIENT_ROLE", "ADMIN_ONLY",
    "SUPER_ADMIN_ONLY", "IP_BLOCKED", "ENTITY_BLOCKED", "BOT_DETECTED",
    "SUBSCRIPTION_PAST_DUE", "SUBSCRIPTION_CANCELLED", "TRIAL_ENDED",
    "NOT_FOUND",
    "ALREADY_EXISTS", "CONFLICT",
    "INVITE_EXPIRED",
    "INVALID_INVITE_TOKEN",
    "RATE_LIMIT_EXCEEDED",
    "INTERNAL_ERROR", "DATABASE_ERROR", "CACHE_ERROR", "KMS_FAILURE",
    "DOWNSTREAM_FAILURE", "EODHD_FAILURE", "STRIPE_FAILURE",
    "SANDBOX_TIMEOUT",
]
