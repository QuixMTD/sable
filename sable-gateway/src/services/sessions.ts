// Session lifecycle — issue, revoke, list, touch.
//
// Token shape: 32 random bytes base64url-encoded → the cookie value.
// We store sha256(token) on the row and as the cache key. The raw token
// never leaves the issuing response.

import { randomBytes } from 'node:crypto';
import {
  cacheKeys,
  sha256,
  withRequestContext,
  type RedisClient,
  type Sql,
} from 'sable-shared';

import * as sessionsDb from '../db/sessions.js';

export const SESSION_TTL_DAYS = 30;

export interface IssueInput {
  userId: string;
  ipAddress: string;
  platform?: 'macos' | 'windows' | 'web';
  deviceFingerprintHash?: Buffer;
}

export interface IssuedSession {
  id: string;
  /** Raw token — only ever returned here. Drops into the Set-Cookie header. */
  token: string;
  expiresAt: Date;
}

export async function issue(sql: Sql, input: IssueInput): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const row = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    sessionsDb.create(tx, {
      userId: input.userId,
      tokenHash,
      ipAddress: input.ipAddress,
      platform: input.platform ?? null,
      deviceFingerprintHash: input.deviceFingerprintHash ?? null,
      expiresAt,
    }),
  );

  return { id: row.id, token, expiresAt: row.expires_at };
}

export async function revoke(
  sql: Sql,
  redis: RedisClient,
  sessionId: string,
  rawTokenHashHex: string | null,
  reason: string,
): Promise<void> {
  await sessionsDb.revoke(sql, sessionId, reason);
  const keys = [cacheKeys.session(sessionId)];
  if (rawTokenHashHex !== null) keys.push(cacheKeys.sessionByToken(rawTokenHashHex));
  await redis.del(...keys);
}

export async function listForUser(sql: Sql, userId: string): Promise<sessionsDb.SessionRow[]> {
  return sessionsDb.listByUser(sql, userId);
}

/**
 * Extend a session's last_active_at — slides our "user is active" signal
 * without altering expires_at. Cheap; can be called per-request.
 */
export async function touch(sql: Sql, sessionId: string): Promise<void> {
  await sessionsDb.touch(sql, sessionId);
}
