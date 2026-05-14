// Builds req.context from req.session. The actual SET LOCAL of session
// variables happens inside `withRequestContext` (see config/database.ts)
// when a transaction opens — this middleware just makes the context
// available so handlers can pull `req.context` and pass it to the
// transaction wrapper.
//
// The pattern at a handler:
//
//   import { withRequestContext } from 'sable-shared';
//   ...
//   const result = await withRequestContext(sql, req.context!, async (tx) => {
//     return tx`SELECT ...`;
//   });
//
// If the request reaches a protected handler without auth, this middleware
// should never have run — authenticate() rejects first.
//
// The DEK source is pluggable so sable-shared stays free of any specific
// secret-management dependency: the gateway passes a function that pulls
// from its in-process cache (loaded once from GCP Secret Manager); other
// services that need decryption pass their own getter.

import { AppError } from '../errors/AppError.js';
import { buildContext } from './types.js';
import type { HttpRequest, HttpResponse, NextFunction } from './types.js';

export interface SetRlsContextOptions {
  /**
   * If true, the per-session DEK is attached so subsequent transactions can
   * touch encrypted columns. Default false — only set when the route is
   * known to need decryption (PII display, profile reads, etc.).
   * Requires `getDek` to be provided.
   */
  withDek?: boolean;
  /**
   * Returns the per-session DEK string. Called only when `withDek` is true.
   * Each service supplies its own source (env, Secret Manager, KMS).
   */
  getDek?: () => string;
}

export function setRlsContext(options: SetRlsContextOptions = {}) {
  if (options.withDek && !options.getDek) {
    throw new Error('setRlsContext: withDek=true requires a getDek function');
  }
  return (req: HttpRequest, _res: HttpResponse, next: NextFunction): void => {
    if (!req.session) {
      next(new AppError('AUTH_FAILED'));
      return;
    }
    const dek = options.withDek ? options.getDek!() : undefined;
    req.context = buildContext(req.session, dek);
    next();
  };
}
