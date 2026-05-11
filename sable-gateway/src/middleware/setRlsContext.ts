// Builds req.context from req.session. The actual SET LOCAL of session
// variables happens inside `withRequestContext` (sable-shared) when a
// transaction opens — this middleware just makes the context available so
// handlers can pull `req.context` and pass it to the transaction wrapper.
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

import type { NextFunction, Request, Response } from 'express';
import { AppError, buildContext } from 'sable-shared';

import { getDek } from '../utils/encrypt.js';

export interface SetRlsContextOptions {
  /**
   * If true, the per-session DEK is attached so subsequent transactions can
   * touch encrypted columns. Default false — only set when the route is
   * known to need decryption (PII display, profile reads, etc.).
   */
  withDek?: boolean;
}

export function setRlsContext(options: SetRlsContextOptions = {}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session) {
      next(new AppError('AUTH_FAILED'));
      return;
    }
    const dek = options.withDek ? getDek() : undefined;
    req.context = buildContext(req.session, dek);
    next();
  };
}
