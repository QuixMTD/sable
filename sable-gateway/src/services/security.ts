// Security operations — blocked_entities, ip_whitelist, security_events.
//
// Block / whitelist writes mirror to Redis so the blockGate middleware
// can short-circuit on every request without hitting Postgres. Redis
// TTLs match the row's expires_at (capped at 1h for blocks); hot-path
// removal is a single DEL.

import {
  TTL,
  cacheKeys,
  withRequestContext,
  type RedisClient,
  type Sql,
} from 'sable-shared';
import type { WhitelistEntityType } from 'sable-shared';

import * as blockedDb from '../db/blockedEntities.js';
import * as ipWhitelistDb from '../db/ipWhitelist.js';
import * as securityEventsDb from '../db/securityEvents.js';

export interface BlockInput {
  entityType: blockedDb.BlockEntityType;
  entityValue: string;
  reason: string;
  blockedBy: string | null;
  expiresAt?: Date | null;
}

export async function block(sql: Sql, redis: RedisClient, input: BlockInput): Promise<void> {
  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await blockedDb.create(tx, input);
  });

  const ttl = input.expiresAt !== undefined && input.expiresAt !== null
    ? Math.min(Math.floor((input.expiresAt.getTime() - Date.now()) / 1000), 3_600)
    : TTL.BLOCK_CACHE;
  if (ttl > 0) {
    await redis.set(cacheKeys.blockCache(input.entityType, input.entityValue), '1', 'EX', ttl);
  }
}

export async function unblock(
  sql: Sql,
  redis: RedisClient,
  entityType: blockedDb.BlockEntityType,
  entityValue: string,
): Promise<void> {
  const row = await blockedDb.findActive(sql, entityType, entityValue);
  if (row !== null) await blockedDb.deactivate(sql, row.id);
  await redis.del(cacheKeys.blockCache(entityType, entityValue));
}

/** Hot-path check — Redis only, no DB fallback. blockGate middleware uses this. */
export async function isBlocked(
  redis: RedisClient,
  entityType: blockedDb.BlockEntityType,
  entityValue: string,
): Promise<boolean> {
  return (await redis.exists(cacheKeys.blockCache(entityType, entityValue))) > 0;
}

export async function emitEvent(
  sql: Sql,
  eventType: string,
  details: { userId?: string; orgId?: string; ipAddress?: string } & Record<string, unknown>,
): Promise<void> {
  const { userId, orgId, ipAddress, ...rest } = details;
  await securityEventsDb.append(sql, {
    eventType,
    userId,
    orgId,
    ipAddress,
    details: rest,
  });
}

// ---------------------------------------------------------------------------
// IP whitelist — bypasses the block gate. blockGate reads
// `whitelist:cache:{type}:{value}` so these writers populate that key.
// ---------------------------------------------------------------------------

export interface WhitelistInput {
  entityType: WhitelistEntityType;
  /** Null for `global` scope, an admin / org id otherwise. */
  entityValue: string | null;
  /** CIDR — single-host is e.g. `1.2.3.4/32`. blockGate matches by IP equality, so single-host CIDRs are the practical use. */
  cidr: string;
  reason: string;
  addedBy: string | null;
}

export async function whitelist(sql: Sql, redis: RedisClient, input: WhitelistInput): Promise<void> {
  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await ipWhitelistDb.create(tx, {
      entity_type: input.entityType,
      entity_value: input.entityValue,
      cidr: input.cidr,
      reason: input.reason,
      added_by: input.addedBy,
      is_active: true,
    });
  });

  const cacheValue = input.entityType === 'global' ? singleHost(input.cidr) : (input.entityValue ?? '');
  if (cacheValue.length > 0) {
    await redis.set(
      cacheKeys.whitelistCache(input.entityType, cacheValue),
      '1',
      'EX',
      TTL.WHITELIST_CACHE,
    );
  }
}

export async function unwhitelist(
  sql: Sql,
  redis: RedisClient,
  entityType: WhitelistEntityType,
  entityValue: string,
): Promise<void> {
  const row = await ipWhitelistDb.findActive(sql, entityType, entityValue, '');
  if (row !== null) {
    await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
      await tx`UPDATE gateway.ip_whitelist SET is_active = false WHERE id = ${row.id}`;
    });
  }
  await redis.del(cacheKeys.whitelistCache(entityType, entityValue));
}

export async function isWhitelisted(
  redis: RedisClient,
  entityType: WhitelistEntityType,
  entityValue: string,
): Promise<boolean> {
  return (await redis.exists(cacheKeys.whitelistCache(entityType, entityValue))) > 0;
}

/** Extract the host from a `host/32`-style single-host CIDR. */
function singleHost(cidr: string): string {
  const idx = cidr.indexOf('/');
  return idx === -1 ? cidr : cidr.slice(0, idx);
}
