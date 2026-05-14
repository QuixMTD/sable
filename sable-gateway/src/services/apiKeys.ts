// API key management — issue / revoke / list.
//
// Raw key is `sable_live_<43-char-base64url>`; only sha256(raw) is
// stored. The plaintext is returned exactly once on issue and never
// recoverable from the row afterwards.

import { randomBytes } from 'node:crypto';
import { sha256, withRequestContext, type Sql } from 'sable-shared';

import * as apiKeysDb from '../db/apiKeys.js';

const PREFIX = 'sable_live';

export interface IssueInput {
  ownerUserId: string;
  ownerOrgId: string | null;
  name: string;
  scopes: string[];
  expiresAt: Date | null;
}

export interface IssuedKey {
  id: string;
  /** Plaintext — shown to the user once, never persisted. */
  key: string;
  prefix: string;
  createdAt: Date;
}

export async function issue(sql: Sql, input: IssueInput): Promise<IssuedKey> {
  const secret = randomBytes(32).toString('base64url');
  const raw = `${PREFIX}_${secret}`;
  const keyHash = sha256(raw);

  const row = await withRequestContext(
    sql,
    { actor: 'user', userId: input.ownerUserId, orgId: input.ownerOrgId ?? undefined },
    async (tx) =>
      apiKeysDb.create(tx, {
        ownerUserId: input.ownerUserId,
        ownerOrgId: input.ownerOrgId,
        keyHash,
        prefix: PREFIX,
        name: input.name,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
      }),
  );

  return { id: row.id, key: raw, prefix: PREFIX, createdAt: row.created_at };
}

export async function revoke(sql: Sql, id: string, byUserId: string): Promise<void> {
  await apiKeysDb.revoke(sql, id, byUserId);
}

export async function listForOwner(sql: Sql, userId: string, orgId: string | null): Promise<apiKeysDb.ApiKeyRow[]> {
  return apiKeysDb.listForOwner(sql, userId, orgId);
}
