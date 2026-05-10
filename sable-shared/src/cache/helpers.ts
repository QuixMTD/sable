// Type-safe Redis wrappers used across all Sable services.
//
// Philosophy
//   - JSON in, JSON out for structured cache entries (`getJson`/`setJson`).
//   - INCR / counter helpers stay strings — Redis handles them natively.
//   - Errors throw. Callers decide whether to fail open (cache layer) or
//     fail closed (rate limit, nonce dedup) — that policy belongs in the
//     caller, not in the helper.
//   - Every set carries an explicit TTL. Cache without TTL is a memory leak.

import type { RedisClient } from '../config/redis.js';

export class CacheError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CacheError';
  }
}

// ---------------------------------------------------------------------------
// JSON values
// ---------------------------------------------------------------------------

/** GET, parsed as JSON. Returns undefined on miss. Throws if value is unparseable. */
export async function getJson<T>(redis: RedisClient, key: string): Promise<T | undefined> {
  const raw = await redis.get(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new CacheError(`Cache value at ${key} is not valid JSON`, cause);
  }
}

/** SET key with EX TTL. TTL is required — no unbounded cache entries. */
export async function setJson(
  redis: RedisClient,
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds <= 0) {
    throw new CacheError(`setJson called with non-positive TTL for ${key}: ${ttlSeconds}`);
  }
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

/**
 * Cache-aside: try Redis, fall back to loader, write through.
 * Loader's `null` return means "no value found" — not cached (negative-caching
 * is a separate decision; do it explicitly with setJson if needed).
 */
export async function getOrSet<T>(
  redis: RedisClient,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T | null>,
): Promise<T | null> {
  const cached = await getJson<T>(redis, key);
  if (cached !== undefined) return cached;

  const fresh = await loader();
  if (fresh !== null) {
    await setJson(redis, key, fresh, ttlSeconds);
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Existence + deletion
// ---------------------------------------------------------------------------

export async function exists(redis: RedisClient, key: string): Promise<boolean> {
  return (await redis.exists(key)) > 0;
}

/** DEL — true if the key existed, false otherwise. */
export async function del(redis: RedisClient, key: string): Promise<boolean> {
  return (await redis.del(key)) > 0;
}

/** Bulk DEL — returns count actually deleted. No-ops on empty input. */
export async function delMany(redis: RedisClient, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  return redis.del(...keys);
}

// ---------------------------------------------------------------------------
// Atomic counters
// ---------------------------------------------------------------------------

/**
 * Atomic INCR with TTL set on the first write — INCR + EXPIRE-on-first-write
 * in one server-side Lua call. Subsequent INCRs do NOT reset the TTL, so the
 * rate-limit window slides correctly.
 *
 * Backed by `redis.sableIncrWithTtl` registered in `createRedis()` — uses
 * EVALSHA after the first call, no script bytes on the wire.
 *
 *   incrWithTtl(redis, cacheKeys.rateUser(id, 'minute'), TTL.RATE_USER_MINUTE);
 */
export async function incrWithTtl(
  redis: RedisClient,
  key: string,
  ttlSeconds: number,
): Promise<number> {
  if (ttlSeconds <= 0) {
    throw new CacheError(`incrWithTtl called with non-positive TTL for ${key}: ${ttlSeconds}`);
  }
  return redis.sableIncrWithTtl(key, ttlSeconds);
}

// ---------------------------------------------------------------------------
// Set-once (nonce dedup pattern)
// ---------------------------------------------------------------------------

/**
 * SET key value EX ttl NX. Returns true if the key was set (first sighting),
 * false if it already existed. Used for HMAC nonce dedup: a `false` return
 * means replay attack.
 */
export async function setOnce(
  redis: RedisClient,
  key: string,
  ttlSeconds: number,
  value = '1',
): Promise<boolean> {
  if (ttlSeconds <= 0) {
    throw new CacheError(`setOnce called with non-positive TTL for ${key}: ${ttlSeconds}`);
  }
  const result = await redis.set(key, value, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}
