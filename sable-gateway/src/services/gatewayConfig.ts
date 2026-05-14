// Cache-aside reader for the gateway.gateway_config key/value store.
//
// Hot path: Redis GET on `config:gw:{key}` (TTL.GATEWAY_CONFIG = 5 min).
// On miss, fall through to Postgres and write through. Admin writes
// (services/admin.setGatewayConfig) DEL both the per-key entry and the
// `config:cache` handle so the next read repopulates.

import {
  TTL,
  cacheKeys,
  withRequestContext,
  type RedisClient,
  type Sql,
} from 'sable-shared';

export async function getConfig(sql: Sql, redis: RedisClient, key: string): Promise<string | null> {
  const cached = await redis.get(cacheKeys.gatewayConfigKey(key));
  if (cached !== null) return cached;

  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<{ value: string }[]>`
      SELECT value FROM gateway.gateway_config WHERE key = ${key} LIMIT 1
    `,
  );
  const value = rows[0]?.value ?? null;
  if (value !== null) {
    await redis.set(cacheKeys.gatewayConfigKey(key), value, 'EX', TTL.GATEWAY_CONFIG);
  }
  return value;
}

/**
 * Convenience overlay for callers that want a typed flag. Defaults to
 * `false` on missing / non-boolean values.
 */
export async function getFlag(sql: Sql, redis: RedisClient, key: string): Promise<boolean> {
  const v = await getConfig(sql, redis, key);
  if (v === null) return false;
  const norm = v.trim().toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on';
}
