// Authenticates a request using the session cookie. Validates the session
// row in gateway.sessions (via the hashed token), populates req.session
// with the decoded SessionData shape, and lets the downstream
// setRlsContext middleware build the RequestContext.
//
// Hashing of the raw cookie value goes through sable-shared's `sha256`
// (BYTEA output, matches the gateway schema's `session_token_hash` column).

import type { NextFunction, Request, Response } from 'express';
import {
  AppError,
  cacheKeys,
  type RedisClient,
  TTL,
  type Sql,
  type SessionData,
  type UserRole,
  type ActorType,
  sha256,
  withRequestContext,
} from 'sable-shared';

export interface AuthenticateConfig {
  sql: Sql;
  redis: RedisClient;
  cookieName: string;
}

export function authenticate(config: AuthenticateConfig) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = req.cookies?.[config.cookieName] as string | undefined;
      if (!raw) throw new AppError('AUTH_FAILED', { message: 'No session cookie' });

      const tokenHash = sha256(raw);
      const session = await loadSession(config, tokenHash);
      if (!session) throw new AppError('AUTH_FAILED', { message: 'Session not found' });
      if (session.expiresAt.getTime() < Date.now()) throw new AppError('SESSION_EXPIRED');

      req.session = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function loadSession(
  config: AuthenticateConfig,
  tokenHash: Buffer,
): Promise<SessionData | null> {
  // Cache the unmarshalled session for the remainder of its lifetime — the
  // shared `cacheKeys.session(id)` pattern is keyed by session id, so we look
  // up the row first, then optionally cache after. (A token-hash → session-id
  // index lookup is the hot path here; cache it once the gateway grows.)

  type Row = {
    id: string;
    user_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    role: UserRole;
    org_id: string | null;
    account_type: 'user' | 'admin' | 'individual';
    active_modules: string[];
  };

  const rows = await withRequestContext(
    config.sql,
    { actor: 'gateway' },
    async (tx) =>
      tx<Row[]>`
        SELECT
          s.id, s.user_id, s.expires_at, s.revoked_at,
          u.role, u.org_id, u.account_type, u.active_modules
        FROM gateway.sessions s
        JOIN gateway.users u ON u.id = s.user_id
        WHERE s.session_token_hash = ${tokenHash}
        LIMIT 1
      `,
  );

  if (rows.length === 0) return null;
  const r = rows[0]!;
  if (r.revoked_at !== null) return null;

  const actor: ActorType = r.account_type === 'admin' ? 'admin' : 'user';

  const session: SessionData = {
    sessionId: r.id,
    userId: r.user_id,
    orgId: r.org_id ?? undefined,
    role: r.role,
    actor,
    isAdmin: actor === 'admin',
    isSuperAdmin: false, // super-admin flag would come from admin_accounts; tighten when admin auth lands
    activeModules: r.active_modules,
    expiresAt: r.expires_at,
  };

  // Cache the session record for its remaining lifetime so subsequent
  // requests within the same tab don't hit the DB.
  const remainingSeconds = Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  await config.redis.set(
    cacheKeys.session(session.sessionId),
    JSON.stringify(session),
    'EX',
    Math.min(remainingSeconds, TTL.MODULES_USER * 12), // cap at 1h sanity
  );

  return session;
}
