// HTTP request logger. Logs one line per response at info (or warn for 4xx,
// error for 5xx) with the method, path, status, duration, and requestId.
//
// The structured logger itself comes from sable-shared (`createLogger`) — we
// build it once at boot and pass it to this factory.

import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'sable-shared';

export function httpLogger(log: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const meta = {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: duration,
        userId: req.session?.userId,
        orgId: req.session?.orgId,
      };

      const message = `${req.method} ${req.path} ${res.statusCode} ${duration}ms`;
      if (res.statusCode >= 500) log.error(message, meta);
      else if (res.statusCode >= 400) log.warn(message, meta);
      else log.info(message, meta);
    });

    next();
  };
}
