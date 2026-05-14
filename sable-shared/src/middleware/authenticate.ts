// Authenticates a request using the session cookie.
//
// Hot path: Redis cache keyed by SHA-256(token) hex digest. Cache miss
// falls back to a single DB query that joins sessions + users. On success
// we populate `req.session` and optionally pull a *fresher* active_modules
// array from the `modules:user:{id}` cache, which the entitlement service
// invalidates whenever a subscription changes (so module purchases take
// effect mid-session without forcing a re-login).
//
// Revocation: services/sessions.revoke deletes BOTH
// `cacheKeys.session(id)` and `cacheKeys.sessionByToken(hex)`.

import { cacheKeys, TTL } from '../cache/index.js';
import type { Sql } from '../config/database.js';
import { withRequestContext } from '../config/database.js';
import type { RedisClient } from '../config/redis.js';
import type { ActorType } from '../constants/actors.js';
import type { UserRole } from '../constants/roles.js';
import { sha256 } from '../crypto/index.js';
import { AppError } from '../errors/AppError.js';
import type { HttpRequest, HttpResponse, NextFunction, SessionData } from './types.js';

export interface AuthenticateConfig {
  sql: Sql;
  redis: RedisClient;
  cookieName: string;
}

export function authenticate(config: AuthenticateConfig) {
  return async (req: HttpRequest, _res: HttpResponse, next: NextFunction): Promise<void> => {
    try {
      const raw = req.cookies?.[config.cookieName];
      if (!raw) throw new AppError('AUTH_FAILED', { message: 'No session cookie' });

      const tokenHash = sha256(raw);
      const tokenHashHex = tokenHash.toString('hex');

      let session = await readCachedSession(config.redis, tokenHashHex);
      if (session === null) {
        session = await loadSessionFromDb(config, tokenHash, tokenHashHex);
      }
      if (session === null) throw new AppError('AUTH_FAILED', { message: 'Session not found' });
      if (session.expiresAt.getTime() < Date.now()) throw new AppError('SESSION_EXPIRED');

      // Mid-session module freshness — entitlement service invalidates
      // `modules:user:{id}` on subscription change, so module purchases
      // take effect without forcing a re-login.
      const freshModules = await readFreshModules(config.redis, session.userId);
      if (freshModules !== null) session = { ...session, activeModules: freshModules };

      req.session = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------

async function readCachedSession(redis: RedisClient, tokenHashHex: string): Promise<SessionData | null> {
  const raw = await redis.get(cacheKeys.sessionByToken(tokenHashHex));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SessionData & { expiresAt: string };
    return { ...parsed, expiresAt: new Date(parsed.expiresAt) };
  } catch {
    return null;
  }
}

async function readFreshModules(redis: RedisClient, userId: string): Promise<string[] | null> {
  const raw = await redis.get(cacheKeys.modulesUser(userId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

async function loadSessionFromDb(
  config: AuthenticateConfig,
  tokenHash: Buffer,
  tokenHashHex: string,
): Promise<SessionData | null> {
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
    isSuperAdmin: false, // admin auth path sets this — user auth doesn't
    activeModules: r.active_modules,
    expiresAt: r.expires_at,
  };

  // Write through to both caches for the session's remaining lifetime
  // (capped at 1h so revoke flows don't have to scan giant TTLs).
  const remainingSeconds = Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  const ttl = Math.min(remainingSeconds, TTL.MODULES_USER * 12);
  const payload = JSON.stringify(session);
  await Promise.all([
    config.redis.set(cacheKeys.session(session.sessionId), payload, 'EX', ttl),
    config.redis.set(cacheKeys.sessionByToken(tokenHashHex), payload, 'EX', ttl),
  ]);

  return session;
}
