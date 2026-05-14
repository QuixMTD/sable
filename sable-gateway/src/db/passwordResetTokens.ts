// gateway.password_reset_tokens — single-use, short-lived, hashed.
// Carries the originating IP so abuse patterns are auditable.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export interface PasswordResetTokenRow {
  id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Date;
  used_at: Date | null;
  ip_requested_from: string;
  created_at: Date;
}

export async function create(
  tx: TransactionSql,
  userId: string,
  tokenHash: Buffer,
  expiresAt: Date,
  ipRequestedFrom: string,
): Promise<PasswordResetTokenRow> {
  const rows = await tx<PasswordResetTokenRow[]>`
    INSERT INTO gateway.password_reset_tokens
      (user_id, token_hash, expires_at, ip_requested_from)
    VALUES
      (${userId}, ${tokenHash}, ${expiresAt}, ${ipRequestedFrom})
    RETURNING *
  `;
  return rows[0]!;
}

export async function findByHash(sql: Sql, tokenHash: Buffer): Promise<PasswordResetTokenRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<PasswordResetTokenRow[]>`
      SELECT * FROM gateway.password_reset_tokens
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function markUsed(tx: TransactionSql, id: string): Promise<void> {
  await tx`
    UPDATE gateway.password_reset_tokens
    SET used_at = now()
    WHERE id = ${id} AND used_at IS NULL
  `;
}
