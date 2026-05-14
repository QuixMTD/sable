// gateway.ip_whitelist — admin accounts / specific orgs that bypass IP
// blocks. Hot-path mirrored to Redis (whitelist:cache:{type}:{value});
// services/security owns the cache writes.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export type WhitelistEntityType = 'admin_account' | 'org' | 'global';

export interface IpWhitelistRow {
  id: string;
  entity_type: WhitelistEntityType;
  entity_value: string | null;
  cidr: string;
  reason: string;
  added_by: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface CreateWhitelistInput {
  entity_type: WhitelistEntityType;
  entity_value: string | null;
  cidr: string;
  reason: string;
  added_by: string | null;
  is_active: boolean;
}

export async function findActive(
  sql: Sql,
  entityType: WhitelistEntityType,
  entityValue: string | null,
  _ip: string,
): Promise<IpWhitelistRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<IpWhitelistRow[]>`
      SELECT * FROM gateway.ip_whitelist
      WHERE entity_type = ${entityType}
        AND entity_value IS NOT DISTINCT FROM ${entityValue}
        AND is_active = true
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function create(tx: TransactionSql, input: CreateWhitelistInput): Promise<IpWhitelistRow> {
  const rows = await tx<IpWhitelistRow[]>`
    INSERT INTO gateway.ip_whitelist
      (entity_type, entity_value, cidr, reason, added_by, is_active)
    VALUES
      (${input.entity_type},
       ${input.entity_value},
       ${input.cidr},
       ${input.reason},
       ${input.added_by},
       ${input.is_active})
    RETURNING *
  `;
  return rows[0]!;
}
