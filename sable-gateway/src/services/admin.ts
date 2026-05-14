// Admin operations — gateway-internal management actions reachable only
// through /admin and gated on admin_accounts.admin_role. Every mutation
// writes to admin_audit_log via services/audit.ts.

import { cacheKeys, withRequestContext, type RedisClient, type Sql } from 'sable-shared';

import * as sessionsDb from '../db/sessions.js';
import * as audit from './audit.js';
import * as sessions from './sessions.js';

export interface RotateHmacKeyInput {
  adminId: string;
  newVersion: number;
  keyRef: string;             // Secret Manager reference (also env var name)
  deprecatePrevious: boolean;
  ipAddress: string | null;
}

export async function rotateHmacKey(sql: Sql, redis: RedisClient, input: RotateHmacKeyInput): Promise<void> {
  await withRequestContext(sql, { actor: 'admin', userId: input.adminId, isAdmin: true }, async (tx) => {
    await tx`
      INSERT INTO gateway.hmac_key_versions (version, key_ref, is_active)
      VALUES (${input.newVersion}, ${input.keyRef}, true)
    `;
    if (input.deprecatePrevious) {
      await tx`
        UPDATE gateway.hmac_key_versions
        SET deprecated_at = now()
        WHERE version < ${input.newVersion} AND deprecated_at IS NULL
      `;
    }
  });

  // Bump the version stamp so every gateway instance's refresh loop
  // picks up the new key on its next 10s poll.
  await redis.set(cacheKeys.hmacVersionsVersion(), Date.now().toString());

  await audit.record(sql, {
    adminId: input.adminId,
    action: 'rotate_hmac_key',
    targetType: 'hmac_key_version',
    targetId: String(input.newVersion),
    before: null,
    after: { version: input.newVersion, keyRef: input.keyRef, deprecatePrevious: input.deprecatePrevious },
    ipAddress: input.ipAddress,
  });
}

export async function listActiveSessions(sql: Sql, userId?: string): Promise<sessionsDb.SessionRow[]> {
  return withRequestContext(sql, { actor: 'admin', isAdmin: true }, async (tx) => {
    if (userId !== undefined) {
      return tx<sessionsDb.SessionRow[]>`
        SELECT * FROM gateway.sessions
        WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_active_at DESC
      `;
    }
    return tx<sessionsDb.SessionRow[]>`
      SELECT * FROM gateway.sessions
      WHERE revoked_at IS NULL AND expires_at > now()
      ORDER BY last_active_at DESC
      LIMIT 1000
    `;
  });
}

export async function forceRevokeSession(
  sql: Sql,
  redis: RedisClient,
  adminId: string,
  sessionId: string,
  reason: string,
  ipAddress: string | null,
): Promise<void> {
  // We don't have the raw token here, so only `session(id)` is
  // explicitly invalidated. `sessionByToken(hex)` falls off via TTL
  // (capped at 1h) — acceptable for admin-driven revokes.
  await sessions.revoke(sql, redis, sessionId, null, reason);
  await audit.record(sql, {
    adminId,
    action: 'revoke_session',
    targetType: 'session',
    targetId: sessionId,
    before: { revoked: false },
    after: { revoked: true, reason },
    ipAddress,
  });
}

export interface SetConfigInput {
  adminId: string;
  key: string;
  value: string;
  description?: string;
  ipAddress: string | null;
}

export async function setGatewayConfig(sql: Sql, redis: RedisClient, input: SetConfigInput): Promise<void> {
  await withRequestContext(sql, { actor: 'admin', userId: input.adminId, isAdmin: true }, async (tx) => {
    await tx`
      INSERT INTO gateway.gateway_config (key, value, description, updated_by)
      VALUES (${input.key}, ${input.value}, ${input.description ?? null}, ${input.adminId})
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            description = COALESCE(EXCLUDED.description, gateway_config.description),
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
    `;
  });
  // Bust both the all-config handle and the per-key cache.
  await Promise.all([
    redis.del(cacheKeys.configCache()),
    redis.del(cacheKeys.gatewayConfigKey(input.key)),
  ]);
  await audit.record(sql, {
    adminId: input.adminId,
    action: 'set_gateway_config',
    targetType: 'gateway_config',
    targetId: input.key,
    before: null,
    after: { key: input.key, value: input.value },
    ipAddress: input.ipAddress,
  });
}

export interface SecurityEventListing {
  id: string;
  event_type: string;
  user_id: string | null;
  org_id: string | null;
  ip_address: string | null;
  details: Record<string, unknown>;
  created_at: Date;
}

export async function listSecurityEvents(sql: Sql, limit = 200): Promise<SecurityEventListing[]> {
  return withRequestContext(sql, { actor: 'admin', isAdmin: true }, async (tx) =>
    tx<SecurityEventListing[]>`
      SELECT id, event_type, user_id, org_id, ip_address, details, created_at
      FROM gateway.security_events
      ORDER BY created_at DESC
      LIMIT ${Math.min(limit, 1000)}
    `,
  );
}

export interface BlockListing {
  id: string;
  entity_type: string;
  entity_value: string;
  reason: string;
  blocked_by: string | null;
  expires_at: Date | null;
  is_active: boolean;
  created_at: Date;
}

export async function listBlocks(sql: Sql): Promise<BlockListing[]> {
  return withRequestContext(sql, { actor: 'admin', isAdmin: true }, async (tx) =>
    tx<BlockListing[]>`
      SELECT id, entity_type, entity_value, reason, blocked_by, expires_at, is_active, created_at
      FROM gateway.blocked_entities
      WHERE is_active = true AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 1000
    `,
  );
}
