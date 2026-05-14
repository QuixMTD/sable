// All Redis key patterns in one place. Source of truth: gateway DB doc §
// "Redis Keys". Every key the platform reads or writes goes through a
// builder here — no ad-hoc template strings at call sites.
//
// Why functions, not constants: builders catch missing args at compile time
// and prevent typos that silently target the wrong key.

// ---------------------------------------------------------------------------
// Shared entity-type unions (mirror the DB CHECK constraints)
// ---------------------------------------------------------------------------

export type BlockEntityType = 'ip' | 'user_id' | 'org_id' | 'device_fingerprint';
export type WhitelistEntityType = 'admin_account' | 'org' | 'global';
export type RateWindow = 'minute' | 'hour' | 'day';

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

export const cacheKeys = {
  /** Per-user request count. Window keyed separately so we don't reset on hour boundaries. */
  rateUser: (userId: string, window: RateWindow) => `rate:user:${userId}:${window}`,
  /** Per-org aggregate request count (minute window only per the doc). */
  rateOrg: (orgId: string) => `rate:org:${orgId}:minute`,
  /** Per-IP request count (minute window only per the doc). */
  rateIp: (ip: string) => `rate:ip:${ip}:minute`,

  /** Cached active_modules array — invalidated on module change. */
  modulesUser: (userId: string) => `modules:user:${userId}`,

  /** Revoked JWTs — TTL = remaining JWT lifetime. */
  jwtBlacklist: (jti: string) => `blacklist:jwt:${jti}`,

  /** Used HMAC nonces — 30s window matching used_nonces table. */
  nonce: (nonce: string) => `nonce:${nonce}`,

  /** Mirror of active blocked_entities rows. */
  blockCache: (type: BlockEntityType, value: string) => `block:cache:${type}:${value}`,
  /** Mirror of active ip_whitelist rows. */
  whitelistCache: (type: WhitelistEntityType, value: string) => `whitelist:cache:${type}:${value}`,

  /** Cached session state — TTL = remaining session lifetime. */
  session: (sessionId: string) => `session:${sessionId}`,

  /**
   * Hot-path cache: token-hash hex → full session JSON. Lets `authenticate`
   * skip the DB lookup on every request. TTL = remaining session lifetime.
   * Revoke writes invalidate both this and `session(id)` (the service holds
   * the mapping so it can invalidate without the raw token).
   */
  sessionByToken: (tokenHashHex: string) => `session:bytok:${tokenHashHex}`,

  /**
   * API key resolution cache — hash(hex) → owner + scopes. Lets API-key auth
   * skip the DB lookup on warm paths. TTL ≈ 5 min so revokes propagate.
   */
  apiKeyByHash: (keyHashHex: string) => `apikey:bytok:${keyHashHex}`,

  /** Admin session — same pattern, separate cookie namespace. */
  adminSession: (sessionId: string) => `admin-session:${sessionId}`,
  adminSessionByToken: (tokenHashHex: string) => `admin-session:bytok:${tokenHashHex}`,

  /** Bot detection: request frequency counter (sub-50ms inter-request gaps). */
  botRequests50ms: (userId: string) => `bot:requests:${userId}:50ms`,
  /** Bot detection: regularity (auto-driven request patterns). */
  botPatternRegularity: (ip: string) => `bot:pattern:${ip}:regularity`,
  /** Bot detection: interaction telemetry variance (mouse / keyboard). */
  botMouse: (userId: string) => `bot:mouse:${userId}`,

  /** Cached service_routes table for routing. */
  routeCache: () => 'route:cache',
  /** Cached active HMAC key versions. */
  hmacVersions: () => 'hmac:versions',
  /** Cached trusted device fingerprints for a user. */
  fingerprintUser: (userId: string) => `fingerprint:user:${userId}`,
  /** Single key/value cache for `gateway_config` reads. */
  gatewayConfigKey: (key: string) => `config:gw:${key}`,
  /** Cache-bust handle for the whole gateway_config map. */
  configCache: () => 'config:cache',
  /** Cached allowed CORS origins. */
  corsOrigins: () => 'cors:origins',

  // ---------------------------------------------------------------------------
  // Version-stamp keys — `Refreshable<T>` polls these; on diff, the gateway
  // reloads the in-memory map from Postgres. Admin write paths bump the
  // stamp with `Date.now().toString()` to trigger reload across instances.
  // ---------------------------------------------------------------------------
  serviceRoutesVersion: () => 'route:cache:version',
  hmacVersionsVersion: () => 'hmac:versions:version',
  corsOriginsVersion: () => 'cors:origins:version',

  // ---------------------------------------------------------------------------
  // Inbound webhook idempotency — set-once on the external event id so
  // Stripe retries can't double-dispatch the same event.
  // ---------------------------------------------------------------------------
  webhookDedup: (source: string, externalEventId: string) => `webhook:dedup:${source}:${externalEventId}`,

  /** Latest health status snapshot per downstream service. */
  health: (serviceName: string) => `health:${serviceName}`,
} as const;
