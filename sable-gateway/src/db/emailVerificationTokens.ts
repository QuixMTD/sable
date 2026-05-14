// gateway.email_verification_tokens — short-lived hashes used to confirm
// a new user owns the email address they signed up with.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export interface EmailVerificationTokenRow {
  id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export async function create(
  tx: TransactionSql,
  userId: string,
  tokenHash: Buffer,
  expiresAt: Date,
): Promise<EmailVerificationTokenRow> {
  const rows = await tx<EmailVerificationTokenRow[]>`
    INSERT INTO gateway.email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt})
    RETURNING *
  `;
  return rows[0]!;
}

export async function findByHash(sql: Sql, tokenHash: Buffer): Promise<EmailVerificationTokenRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<EmailVerificationTokenRow[]>`
      SELECT * FROM gateway.email_verification_tokens
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function markUsed(tx: TransactionSql, id: string): Promise<void> {
  await tx`
    UPDATE gateway.email_verification_tokens
    SET used_at = now()
    WHERE id = ${id} AND used_at IS NULL
  `;
}
