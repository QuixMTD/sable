// gateway.blocked_entities — IP / user / org / device fingerprints
// flagged by bot detection or admin action. Mirrored to Redis
// (block:cache:{type}:{value}) for hot lookup; the DB is the source of
// truth for cache rebuilds and for admin views.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export type BlockEntityType = 'ip' | 'user_id' | 'org_id' | 'device_fingerprint';

export interface BlockedEntityRow {
  id: string;
  entity_type: BlockEntityType;
  entity_value: string;
  reason: string;
  blocked_by: string | null;
  expires_at: Date | null;
  is_active: boolean;
  created_at: Date;
}

export interface CreateBlockInput {
  entityType: BlockEntityType;
  entityValue: string;
  reason: string;
  blockedBy: string | null;
  expiresAt?: Date | null;
}

export async function findActive(
  sql: Sql,
  entityType: BlockEntityType,
  entityValue: string,
): Promise<BlockedEntityRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<BlockedEntityRow[]>`
      SELECT * FROM gateway.blocked_entities
      WHERE entity_type = ${entityType}
        AND entity_value = ${entityValue}
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function create(tx: TransactionSql, input: CreateBlockInput): Promise<BlockedEntityRow> {
  const rows = await tx<BlockedEntityRow[]>`
    INSERT INTO gateway.blocked_entities
      (entity_type, entity_value, reason, blocked_by, expires_at)
    VALUES
      (${input.entityType},
       ${input.entityValue},
       ${input.reason},
       ${input.blockedBy},
       ${input.expiresAt ?? null})
    RETURNING *
  `;
  return rows[0]!;
}

export async function deactivate(sql: Sql, id: string): Promise<void> {
  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await tx`UPDATE gateway.blocked_entities SET is_active = false WHERE id = ${id}`;
  });
}
