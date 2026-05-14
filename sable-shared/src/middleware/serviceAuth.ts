// Service-to-service authentication via HMAC-SHA-256 signed requests.
//
// Verifier side. The caller includes:
//   X-Service-Name:    e.g. 'sable-core'
//   X-Service-Version: HMAC key version (integer)
//   X-Service-Nonce:   one-time random string (30s window)
//   X-Service-TS:      unix ms
//   X-Service-Token:   hex HMAC-SHA-256 over `{ts}.{nonce}.{method}.{path}.{bodySha256}`
//
// We verify the signature using the active key (looked up by version) and
// reject replays via `setOnce` on a Redis nonce key.
//
// The `actor` set on req.context defaults to 'gateway' — appropriate when
// the gateway is receiving signed inbound calls. Services that verify calls
// from a different signer pass the corresponding actor type.

import { cacheKeys, setOnce, TTL } from '../cache/index.js';
import type { RedisClient } from '../config/redis.js';
import type { ActorType } from '../constants/actors.js';
import { constantTimeEqual, hmacSha256, sha256 } from '../crypto/index.js';
import { AppError } from '../errors/AppError.js';
import type { HttpRequest, HttpResponse, NextFunction } from './types.js';

const NONCE_WINDOW_MS = 30_000;

export interface ServiceAuthConfig {
  redis: RedisClient;
  /** Active HMAC keys keyed by version. Loaded once at boot. */
  hmacKeys: ReadonlyMap<number, Buffer>;
  /** Current signing-version (highest). */
  currentVersion: number;
  /**
   * Actor to set on req.context after successful verification. Defaults to
   * `'gateway'` for the gateway-receives-service case.
   */
  actor?: ActorType;
}

export function serviceAuth(config: ServiceAuthConfig) {
  const actor: ActorType = config.actor ?? 'gateway';

  return async (req: HttpRequest, _res: HttpResponse, next: NextFunction): Promise<void> => {
    try {
      const headerVersion = req.header('x-service-version');
      const nonce = req.header('x-service-nonce');
      const tsHeader = req.header('x-service-ts');
      const token = req.header('x-service-token');
      const service = req.header('x-service-name');

      if (!headerVersion || !nonce || !tsHeader || !token || !service) {
        throw new AppError('INVALID_HMAC', { message: 'Missing service-auth headers' });
      }

      const ts = Number.parseInt(tsHeader, 10);
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > NONCE_WINDOW_MS) {
        throw new AppError('REPLAY_ATTACK', { message: 'Timestamp outside the 30s window' });
      }

      const version = Number.parseInt(headerVersion, 10);
      const key = config.hmacKeys.get(version);
      if (!key) throw new AppError('INVALID_HMAC', { message: `Unknown HMAC key version ${version}` });

      const bodyHash = sha256(req.rawBody ?? Buffer.alloc(0));
      const message = Buffer.from(
        `${ts}.${nonce}.${req.method}.${req.path}.${bodyHash.toString('hex')}`,
      );
      const expected = hmacSha256(key, message);

      let tokenBytes: Buffer;
      try {
        tokenBytes = Buffer.from(token, 'hex');
      } catch {
        throw new AppError('INVALID_HMAC', { message: 'Token not hex-encoded' });
      }

      if (!constantTimeEqual(tokenBytes, expected)) {
        throw new AppError('INVALID_HMAC');
      }

      // Replay protection — accept only the first sighting of this nonce.
      const fresh = await setOnce(config.redis, cacheKeys.nonce(nonce), TTL.NONCE);
      if (!fresh) throw new AppError('REPLAY_ATTACK');

      // Mark the request as service-originated so RLS uses the correct actor.
      req.session = undefined;
      req.context = { actor };

      next();
    } catch (err) {
      next(err);
    }
  };
}
