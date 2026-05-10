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
  /** Cached gateway_config key/value store. */
  configCache: () => 'config:cache',
  /** Cached allowed CORS origins. */
  corsOrigins: () => 'cors:origins',

  /** Latest health status snapshot per downstream service. */
  health: (serviceName: string) => `health:${serviceName}`,
} as const;
