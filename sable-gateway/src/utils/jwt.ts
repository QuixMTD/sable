// JSON Web Token helpers — used for short-lived access tokens (chat / WS
// upgrades, signed download URLs, invite tokens). Long-lived sessions go
// through the cookie + DB path, not JWT.
//
// Secret loaded from env. HS256 — symmetric, since signer and verifier are
// the same process. Switch to RS256 only if you ever validate JWTs in a
// service that doesn't share the secret.

import jwt from 'jsonwebtoken';

import { AppError, requireEnv } from 'sable-shared';

let cachedSecret: string | undefined;

function getSecret(): string {
  cachedSecret ??= requireEnv('JWT_SECRET');
  return cachedSecret;
}

export interface JwtClaims {
  /** Subject — usually a user id or session id. */
  sub: string;
  /** Issuer — 'sable-gateway'. */
  iss?: string;
  /** Audience — which service is allowed to consume this token. */
  aud?: string;
  /** Extra arbitrary claims. */
  [key: string]: unknown;
}

export interface SignOptions {
  /**
   * Expiry, e.g. '15m', '1h', '7d', or a number of seconds. Same shape
   * jsonwebtoken's own SignOptions['expiresIn'] accepts.
   */
  expiresIn?: jwt.SignOptions['expiresIn'];
  audience?: string;
  issuer?: string;
}

export function signJwt(claims: JwtClaims, options: SignOptions = {}): string {
  return jwt.sign(claims, getSecret(), {
    algorithm: 'HS256',
    expiresIn: options.expiresIn ?? '15m',
    issuer: options.issuer ?? 'sable-gateway',
    audience: options.audience,
  });
}

export function verifyJwt<T extends JwtClaims = JwtClaims>(token: string, options: { audience?: string } = {}): T {
  try {
    return jwt.verify(token, getSecret(), {
      algorithms: ['HS256'],
      issuer: 'sable-gateway',
      audience: options.audience,
    }) as T;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError('TOKEN_EXPIRED', { cause: err });
    }
    throw new AppError('TOKEN_INVALID', { cause: err });
  }
}

/** Decode without verifying — for inspecting claims in logs only. Never trust the result. */
export function decodeJwt<T extends JwtClaims = JwtClaims>(token: string): T | null {
  const decoded = jwt.decode(token);
  return decoded as T | null;
}
