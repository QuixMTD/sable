// gateway.sessions — opaque cookie-backed sessions. The raw token lives
// only in the cookie; we store sha256(token). Partitioned by created_at.
//
// Cache invalidation is handled at the service layer (services/sessions),
// which knows both the session id and the original token hash and can
// remove both Redis keys on revoke.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export type Platform = 'macos' | 'windows' | 'web';

export interface SessionRow {
  id: string;
  user_id: string;
  session_token_hash: Buffer;
  device_fingerprint_hash: Buffer | null;
  ip_address: string;
  platform: Platform | null;
  created_at: Date;
  last_active_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: Buffer;
  ipAddress: string;
  platform: Platform | null;
  deviceFingerprintHash: Buffer | null;
  expiresAt: Date;
}

export async function create(tx: TransactionSql, input: CreateSessionInput): Promise<SessionRow> {
  const rows = await tx<SessionRow[]>`
    INSERT INTO gateway.sessions
      (user_id, session_token_hash, device_fingerprint_hash, ip_address, platform, expires_at)
    VALUES
      (${input.userId},
       ${input.tokenHash},
       ${input.deviceFingerprintHash},
       ${input.ipAddress},
       ${input.platform},
       ${input.expiresAt})
    RETURNING *
  `;
  return rows[0]!;
}

export async function findByTokenHash(sql: Sql, tokenHash: Buffer): Promise<SessionRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<SessionRow[]>`
      SELECT * FROM gateway.sessions
      WHERE session_token_hash = ${tokenHash} AND revoked_at IS NULL
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function findById(sql: Sql, id: string): Promise<SessionRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<SessionRow[]>`SELECT * FROM gateway.sessions WHERE id = ${id} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function listByUser(sql: Sql, userId: string): Promise<SessionRow[]> {
  return withRequestContext(sql, { actor: 'user', userId }, async (tx) =>
    tx<SessionRow[]>`
      SELECT * FROM gateway.sessions
      WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_active_at DESC
    `,
  );
}

export async function revoke(sql: Sql, id: string, reason: string): Promise<void> {
  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await tx`
      UPDATE gateway.sessions
      SET revoked_at = now(), revoke_reason = ${reason}
      WHERE id = ${id} AND revoked_at IS NULL
    `;
  });
}

export async function revokeAllForUser(tx: TransactionSql, userId: string, reason: string): Promise<void> {
  await tx`
    UPDATE gateway.sessions
    SET revoked_at = now(), revoke_reason = ${reason}
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
}

export async function touch(sql: Sql, id: string): Promise<void> {
  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await tx`UPDATE gateway.sessions SET last_active_at = now() WHERE id = ${id}`;
  });
}
