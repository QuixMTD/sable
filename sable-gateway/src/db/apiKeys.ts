// gateway.api_keys — first-party API keys (developer access, CI bots).
// Stored hashed; the raw key value only ever lives in the issued response.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export interface ApiKeyRow {
  id: string;
  org_id: string | null;
  user_id: string;            // creator (always set)
  key_hash: Buffer;
  prefix: string;             // e.g. 'sable_live'
  name: string;
  scopes: string[];
  last_used_at: Date | null;
  expires_at: Date | null;
  is_active: boolean;
  revoked_at: Date | null;
  created_at: Date;
}

export interface CreateApiKeyInput {
  ownerUserId: string;
  ownerOrgId: string | null;
  keyHash: Buffer;
  prefix: string;
  name: string;
  scopes: string[];
  expiresAt: Date | null;
}

export async function create(tx: TransactionSql, input: CreateApiKeyInput): Promise<ApiKeyRow> {
  const rows = await tx<ApiKeyRow[]>`
    INSERT INTO gateway.api_keys
      (user_id, org_id, key_hash, prefix, name, scopes, expires_at)
    VALUES
      (${input.ownerUserId},
       ${input.ownerOrgId},
       ${input.keyHash},
       ${input.prefix},
       ${input.name},
       ${input.scopes},
       ${input.expiresAt})
    RETURNING *
  `;
  return rows[0]!;
}

export async function findByHash(sql: Sql, keyHash: Buffer): Promise<ApiKeyRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<ApiKeyRow[]>`
      SELECT * FROM gateway.api_keys
      WHERE key_hash = ${keyHash}
        AND is_active = true
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function listForOwner(sql: Sql, userId: string, orgId: string | null): Promise<ApiKeyRow[]> {
  return withRequestContext(sql, { actor: 'user', userId, orgId: orgId ?? undefined }, async (tx) =>
    tx<ApiKeyRow[]>`
      SELECT * FROM gateway.api_keys
      WHERE (user_id = ${userId} OR org_id = ${orgId})
        AND revoked_at IS NULL
      ORDER BY created_at DESC
    `,
  );
}

export async function revoke(sql: Sql, id: string, userId: string): Promise<void> {
  await withRequestContext(sql, { actor: 'user', userId }, async (tx) => {
    await tx`
      UPDATE gateway.api_keys
      SET revoked_at = now(), is_active = false
      WHERE id = ${id} AND revoked_at IS NULL
    `;
  });
}
