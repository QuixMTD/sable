// Express error middleware — converts thrown errors into the standard
// response envelope. AppError instances flow through unchanged; everything
// else is wrapped in INTERNAL_ERROR after being logged with the full stack.
//
// AppError, failure() and the response envelope shape all come from
// sable-shared so every Sable service formats errors identically.

import type { NextFunction, Request, Response } from 'express';
import { AppError, failure, type Logger } from 'sable-shared';

import { formatError } from '../utils/formatError.js';

export function errorHandler(log: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
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
      _next(err);
      return;
    }

    res.status(appErr.statusCode).json(failure(appErr, req.requestId));
  };
}
