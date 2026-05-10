// ioredis client factory shared by all Sable Node services.
//
// Used for: rate limiting (per-user/org/IP counters), nonce dedup, session
// cache, blocked-entity cache, bot-score counters, route cache. Per the
// gateway DB doc: keys are namespaced (`rate:user:{id}:minute`,
// `nonce:{nonce}`, `session:{id}`, `block:cache:{type}:{value}`, etc.).

import Redis, { type Redis as RedisClient, type RedisOptions } from 'ioredis';

export type { RedisClient };

// Augment ioredis's command interface with our pre-registered scripts. After
// `createRedis()`, every Redis instance has these methods typed and ready —
// no per-call EVAL bytes on the wire (uses EVALSHA with the cached script).
declare module 'ioredis' {
  interface RedisCommander<Context> {
    /**
     * Atomic INCR + EXPIRE-on-first-write. Subsequent INCRs do NOT reset
     * the TTL. Used for fixed-window rate-limit counters.
     * Returns the new counter value.
     */
    sableIncrWithTtl(
      key: string,
      ttlSeconds: number,
    ): import('ioredis').Result<number, Context>;
  }
}

const INCR_WITH_TTL_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RedisConfig {
  /** Logical service name. Surfaces in CLIENT LIST. */
  serviceName: string;
  /**
   * Connection URL — `redis://[:password@]host:port[/db]` or `rediss://...`
   * for TLS. Use this OR explicit host/port, not both.
   */
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  /** Force TLS even on a plain `redis://` URL — Cloud Memorystore in-transit encryption. */
  tls?: boolean;
  /** Connect timeout in ms. Default 10_000. */
  connectTimeoutMs?: number;
  /**
   * How many times ioredis retries a failed command before throwing.
   * Default 3. Set to null to retry forever (don't — fail fast).
   */
  maxRetriesPerRequest?: number | null;
}

export function createRedis(config: RedisConfig): RedisClient {
  const baseOptions: RedisOptions = {
    connectionName: config.serviceName,
    connectTimeout: config.connectTimeoutMs ?? 10_000,
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
    enableReadyCheck: true,
    lazyConnect: false,
    // Retry connection with exponential backoff capped at 2s.
    retryStrategy: (times) => Math.min(times * 100, 2_000),
    ...(config.tls ? { tls: {} } : {}),
  };

  const redis = config.url
    ? new Redis(config.url, baseOptions)
    : new Redis({
        host: config.host ?? '127.0.0.1',
        port: config.port ?? 6379,
        password: config.password,
        db: config.db ?? 0,
        ...baseOptions,
      });

  // Pre-register Lua scripts. ioredis caches by SHA and uses EVALSHA —
  // script bytes only ship on first call (or after FLUSHALL/restart).
  redis.defineCommand('sableIncrWithTtl', { numberOfKeys: 1, lua: INCR_WITH_TTL_LUA });

  return redis;
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

/** Liveness check for `/healthz`. Returns latency in ms or throws. */
export async function pingRedis(redis: RedisClient, timeoutMs = 2000): Promise<number> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis ping timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return Date.now() - start;
}

/** Graceful shutdown — call on SIGTERM. */
export async function closeRedis(redis: RedisClient): Promise<void> {
  await redis.quit();
}
