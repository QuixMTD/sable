// JSON Web Token helpers — used for short-lived access tokens (chat / WS
// upgrades, signed download URLs, invite tokens). Long-lived sessions go
// through the cookie + DB path, not JWT.
//
// Secret loaded from env. HS256 — symmetric, since signer and verifier are
// the same process. Switch to RS256 only if you ever validate JWTs in a
// service that doesn't share the secret.
//
// `jsonwebtoken` is an optional peer dep of sable-shared.

import jwt from 'jsonwebtoken';

import { requireEnv, optionalEnv } from '../config/env.js';
import { AppError } from '../errors/AppError.js';

let cachedSecret: string | undefined;

function getSecret(): string {
  cachedSecret ??= requireEnv('JWT_SECRET');
  return cachedSecret;
}

/**
 * Issuer used when signing and to enforce when verifying. Sourced from
 * `JWT_ISSUER` env (each service sets its own, e.g. 'sable-gateway',
 * 'sable-core'). Falls back to undefined — no issuer claim and no check.
 */
function defaultIssuer(): string | undefined {
  return optionalEnv('JWT_ISSUER');
}

export interface JwtClaims {
  /** Subject — usually a user id or session id. */
  sub: string;
  /** Issuer — the signing service name. */
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
  /** Defaults to env JWT_ISSUER if set, otherwise no iss claim. */
  issuer?: string;
}

export function signJwt(claims: JwtClaims, options: SignOptions = {}): string {
  return jwt.sign(claims, getSecret(), {
    algorithm: 'HS256',
    expiresIn: options.expiresIn ?? '15m',
    issuer: options.issuer ?? defaultIssuer(),
    audience: options.audience,
  });
}

export function verifyJwt<T extends JwtClaims = JwtClaims>(
  token: string,
  options: { audience?: string; issuer?: string } = {},
): T {
  try {
    return jwt.verify(token, getSecret(), {
      algorithms: ['HS256'],
      issuer: options.issuer ?? defaultIssuer(),
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
