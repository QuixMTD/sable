// /webhooks/* controllers. Each handler reads req.rawBody (set by the
// jsonBodyParser verify hook), verifies the source-specific signature,
// dispatches to services/webhooks.ts, and responds 200 quickly so the
// provider doesn't retry.
//
// Planned endpoints:
//   POST  /webhooks/stripe      → stripe   (verifies Stripe-Signature)

import type { NextFunction, Request, Response } from 'express';
import { AppError } from 'sable-shared';

const todo = (_req: Request, _res: Response, next: NextFunction): void =>
  next(new AppError('INTERNAL_ERROR', { message: 'Not implemented' }));

export const stripe = todo;
