// Express-shape error middleware — converts thrown errors into the standard
// response envelope. AppError instances flow through unchanged; everything
// else is normalised by `formatError` (Postgres SQLSTATE, Stripe shapes,
// generic Error) and logged with the full stack.
//
// Every Sable service plugs this in last so the wire format is identical
// across the gateway, sable-core, sable-sc, etc.

import { AppError } from '../errors/AppError.js';
import { formatError } from '../errors/formatError.js';
import { failure } from '../http/response.js';
import type { Logger } from '../logging/index.js';
import type { HttpRequest, HttpResponse, NextFunction } from './types.js';

export function errorHandler(log: Logger) {
  return (err: unknown, req: HttpRequest, res: HttpResponse, next: NextFunction): void => {
    const appErr = AppError.is(err) ? err : formatError(err);

    // Unknown errors → log full context. Operational AppErrors → log only at
    // their natural level (5xx server-side problem, 4xx client mistake).
    const meta = {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      code: appErr.code,
      statusCode: appErr.statusCode,
      // `cause` carries the original error for non-AppError throws — log it,
      // never expose it to the client (failure() strips it on the wire).
      cause: appErr.cause,
    };

    if (appErr.statusCode >= 500) log.error(appErr.message, meta);
    else log.warn(appErr.message, meta);

    if (res.headersSent) {
      // Express requires we delegate to the default handler once headers go.
      next(err);
      return;
    }

    res.status(appErr.statusCode).json(failure(appErr, req.requestId));
  };
}
