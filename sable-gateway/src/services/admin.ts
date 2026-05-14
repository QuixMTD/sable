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

// ---------------------------------------------------------------------------
// Read-only listings.
// ---------------------------------------------------------------------------

export interface HmacKeyListing {
  id: string;
  version: number;
  key_ref: string;
  is_active: boolean;
  activated_at: Date;
  deprecated_at: Date | null;
  expires_at: Date | null;
}

export async function listHmacKeys(sql: Sql): Promise<HmacKeyListing[]> {
  return withRequestContext(sql, { actor: 'admin', isAdmin: true }, async (tx) =>
    tx<HmacKeyListing[]>`
      SELECT id, version, key_ref, is_active, activated_at, deprecated_at, expires_at
      FROM gateway.hmac_key_versions
      ORDER BY version DESC
    `,
  );
}

export interface AuditEntry {
  id: string;
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: Date;
}

export async function listAuditLog(sql: Sql, limit = 200): Promise<AuditEntry[]> {
  return withRequestContext(sql, { actor: 'admin', isAdmin: true }, async (tx) =>
    tx<AuditEntry[]>`
      SELECT id, admin_user_id, action, target_type, target_id,
             before_state, after_state, ip_address, created_at
      FROM gateway.admin_audit_log
      ORDER BY created_at DESC
      LIMIT ${Math.min(limit, 1000)}
    `,
  );
}

export interface ServiceHealthListing {
  service_name: string;
  status: 'healthy' | 'degraded' | 'down';
  response_time_ms: number | null;
  error_message: string | null;
  checked_at: Date;
}

export async function listServiceHealth(sql: Sql): Promise<ServiceHealthListing[]> {
  return withRequestContext(sql, { actor: 'admin', isAdmin: true }, async (tx) =>
    tx<ServiceHealthListing[]>`
      SELECT DISTINCT ON (service_name)
        service_name, status, response_time_ms, error_message, checked_at
      FROM gateway.service_health_log
      WHERE checked_at > now() - interval '1 hour'
      ORDER BY service_name, checked_at DESC
    `,
  );
}

export interface ConfigEntry {
  key: string;
  value: string;
  description: string | null;
  updated_by: string | null;
  updated_at: Date;
}

export async function listConfig(sql: Sql): Promise<ConfigEntry[]> {
  return withRequestContext(sql, { actor: 'admin', isAdmin: true }, async (tx) =>
    tx<ConfigEntry[]>`
      SELECT key, value, description, updated_by, updated_at
      FROM gateway.gateway_config
      ORDER BY key
    `,
  );
}

export interface EnquiryListing {
  id: string;
  name: string;
  firm_name: string | null;
  enquiry_type: string;
  message: string | null;
  source: string | null;
  status: string;
  assigned_to: string | null;
  internal_notes: string | null;
  created_at: Date;
}

export async function listEnquiries(sql: Sql, status?: string): Promise<EnquiryListing[]> {
  return withRequestContext(sql, { actor: 'admin', isAdmin: true }, async (tx) => {
    if (status !== undefined) {
      return tx<EnquiryListing[]>`
        SELECT id, name, firm_name, enquiry_type, message, source, status,
               assigned_to, internal_notes, created_at
        FROM gateway.enquiries
        WHERE status = ${status}
        ORDER BY created_at DESC
        LIMIT 500
      `;
    }
    return tx<EnquiryListing[]>`
      SELECT id, name, firm_name, enquiry_type, message, source, status,
             assigned_to, internal_notes, created_at
      FROM gateway.enquiries
      ORDER BY created_at DESC
      LIMIT 500
    `;
  });
}

export interface UpdateEnquiryInput {
  adminId: string;
  id: string;
  status?: 'new' | 'contacted' | 'qualified' | 'demo_booked' | 'converted' | 'closed';
  assignedTo?: string | null;
  internalNotes?: string;
  ipAddress: string | null;
}

export async function updateEnquiry(sql: Sql, input: UpdateEnquiryInput): Promise<void> {
  await withRequestContext(sql, { actor: 'admin', userId: input.adminId, isAdmin: true }, async (tx) => {
    if (input.status !== undefined) {
      await tx`UPDATE gateway.enquiries SET status = ${input.status} WHERE id = ${input.id}`;
    }
    if (input.assignedTo !== undefined) {
      await tx`UPDATE gateway.enquiries SET assigned_to = ${input.assignedTo} WHERE id = ${input.id}`;
    }
    if (input.internalNotes !== undefined) {
      await tx`UPDATE gateway.enquiries SET internal_notes = ${input.internalNotes} WHERE id = ${input.id}`;
    }
  });
  await audit.record(sql, {
    adminId: input.adminId,
    action: 'update_enquiry',
    targetType: 'enquiry',
    targetId: input.id,
    before: null,
    after: {
      status: input.status ?? null,
      assignedTo: input.assignedTo ?? null,
      internalNotes: input.internalNotes ?? null,
    },
    ipAddress: input.ipAddress,
  });
}
