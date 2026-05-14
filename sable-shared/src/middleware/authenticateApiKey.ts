// Authenticates a request via `Authorization: Bearer sable_live_<token>`.
// Hashes the token, looks it up in gateway.api_keys (cached for 5 min),
// populates `req.session` with actor='api' and the owner's id/org.
//
// Scopes are surfaced on req.session via the `activeModules` field — the
// shape's tightest pre-existing array slot — so downstream `moduleGuard`
// and route-level scope checks share one code path. Each api_key row's
// `scopes` array maps directly into modulesGuard semantics; we re-use
// rather than introducing a parallel array on SessionData.

import { cacheKeys, TTL } from '../cache/index.js';
import type { Sql } from '../config/database.js';
import { withRequestContext } from '../config/database.js';
import type { RedisClient } from '../config/redis.js';
import type { UserRole } from '../constants/roles.js';
import { sha256 } from '../crypto/index.js';
import { AppError } from '../errors/AppError.js';
import type { HttpRequest, HttpResponse, NextFunction, SessionData } from './types.js';

const BEARER_PREFIX = 'Bearer ';
const KEY_PREFIX = 'sable_live_';

export interface AuthenticateApiKeyConfig {
  sql: Sql;
  redis: RedisClient;
  /**
   * If true, treat the absence of an Authorization header as "fall through" —
   * `req.session` stays undefined and the next middleware (e.g.
   * `authenticate`) gets a chance. Default false: missing header → 401.
   */
  optional?: boolean;
}

export function authenticateApiKey(config: AuthenticateApiKeyConfig) {
  return async (req: HttpRequest, _res: HttpResponse, next: NextFunction): Promise<void> => {
    try {
      const header = req.header('authorization');
      if (!header || !header.startsWith(BEARER_PREFIX)) {
        if (config.optional) {
          next();
          return;
        }
        throw new AppError('AUTH_FAILED', { message: 'Missing Bearer token' });
      }

      const token = header.slice(BEARER_PREFIX.length).trim();
      if (!token.startsWith(KEY_PREFIX)) {
        // Bearer is present but it isn't an API key — let the next auth
        // middleware (e.g. JWT for WS upgrade) handle it.
        if (config.optional) {
          next();
          return;
        }
        throw new AppError('AUTH_FAILED', { message: 'Bearer is not an API key' });
      }

      const keyHash = sha256(token);
      const keyHashHex = keyHash.toString('hex');

      let session = await readCached(config.redis, keyHashHex);
      if (session === null) {
        session = await loadFromDb(config, keyHash, keyHashHex);
      }
      if (session === null) throw new AppError('API_KEY_INVALID');

      req.session = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function readCached(redis: RedisClient, keyHashHex: string): Promise<SessionData | null> {
  const raw = await redis.get(cacheKeys.apiKeyByHash(keyHashHex));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SessionData & { expiresAt: string };
    return { ...parsed, expiresAt: new Date(parsed.expiresAt) };
  } catch {
    return null;
  }
}

async function loadFromDb(
  config: AuthenticateApiKeyConfig,
  keyHash: Buffer,
  keyHashHex: string,
): Promise<SessionData | null> {
  type Row = {
    id: string;
    user_id: string | null;
    org_id: string | null;
    scopes: string[];
    revoked_at: Date | null;
    role: UserRole | null;
  };

  // Join api_keys.user_id → users to inherit role for RLS, falling back
  // to 'viewer' if the key is org-only (no associated user).
  const rows = await withRequestContext(
    config.sql,
    { actor: 'gateway' },
    async (tx) =>
      tx<Row[]>`
        SELECT k.id, k.user_id, k.org_id, k.scopes, k.revoked_at, u.role
        FROM gateway.api_keys k
        LEFT JOIN gateway.users u ON u.id = k.user_id
        WHERE k.key_hash = ${keyHash}
        LIMIT 1
      `,
  );

  if (rows.length === 0) return null;
  const r = rows[0]!;
  if (r.revoked_at !== null) return null;

  const session: SessionData = {
    sessionId: r.id,                       // api key id, not a session id
    userId: r.user_id ?? '',                // empty when org-only
    orgId: r.org_id ?? undefined,
    role: r.role ?? 'viewer',
    actor: 'api',
    isAdmin: false,
    isSuperAdmin: false,
    activeModules: r.scopes,                // reuse the slot — see header
    // API keys don't carry a session expiry; we fake one 5 min out so the
    // SessionData shape's required field is satisfied and the cache TTL
    // aligns with the API_KEY constant.
    expiresAt: new Date(Date.now() + TTL.API_KEY * 1000),
  };

  await config.redis.set(
    cacheKeys.apiKeyByHash(keyHashHex),
    JSON.stringify(session),
    'EX',
    TTL.API_KEY,
  );

  return session;
}
