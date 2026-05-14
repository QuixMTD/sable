// All cache TTLs in seconds. Source of truth: gateway DB doc § "Redis Keys".
//
// Two TTLs are deliberately omitted as constants:
//   - JWT_BLACKLIST: TTL is the JWT's remaining lifetime, computed at write time
//   - SESSION:       TTL is the session's remaining lifetime, ditto
// Use the JWT/session expires_at − now() at the call site instead.

export const TTL = {
  /** Per-user / per-org / per-IP rate-limit windows */
  RATE_USER_MINUTE: 60,
  RATE_USER_HOUR: 3_600,
  RATE_USER_DAY: 86_400,
  RATE_ORG_MINUTE: 60,
  RATE_IP_MINUTE: 60,

  /** Cached active_modules array — short window so module changes propagate quickly */
  MODULES_USER: 300,
  /** API-key resolution cache — short so revokes propagate quickly. */
  API_KEY: 300,

  /** HMAC replay-attack window — must match used_nonces.expires_at */
  NONCE: 30,

  /** Mirror of blocked_entities — short so unblocks propagate quickly */
  BLOCK_CACHE: 60,
  /** Mirror of ip_whitelist */
  WHITELIST_CACHE: 300,

  /** Bot detection counters */
  BOT_REQUESTS_50MS: 60,
  BOT_PATTERN_REGULARITY: 300,
  BOT_MOUSE: 600,

  /** Long-lived config caches (1 hour) — invalidated explicitly on admin write */
  ROUTE_CACHE: 3_600,
  HMAC_VERSIONS: 3_600,
  FINGERPRINT_USER: 3_600,
  CONFIG_CACHE: 3_600,
  CORS_ORIGINS: 3_600,

  /** Per-service health snapshot — must be shorter than the gap between probes */
  HEALTH: 30,
  /** Per-key gateway_config read cache */
  GATEWAY_CONFIG: 300,
  /** Webhook idempotency — long enough to span Stripe's retry curve */
  WEBHOOK_DEDUP: 86_400,
} as const;

export type TtlKey = keyof typeof TTL;
