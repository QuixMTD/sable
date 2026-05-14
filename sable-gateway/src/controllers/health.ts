// Health controller. The only real handlers in the gateway until the
// other features land — give the operator something to curl.

import type { Request, RequestHandler, Response } from 'express';
import { failure, pingDatabase, pingRedis, success } from 'sable-shared';

import type { AppConfig } from '../app.js';

const READY_TIMEOUT_MS = 2_000;

export function healthz(req: Request, res: Response): void {
  res.status(200).json(success({ status: 'ok' }, req.requestId));
}

export function readyz(config: AppConfig): RequestHandler {
  return async (req, res) => {
    const start = Date.now();
    try {
      const [dbMs, redisMs] = await Promise.all([
        pingDatabase(config.sql, READY_TIMEOUT_MS),
        pingRedis(config.redis, READY_TIMEOUT_MS),
      ]);
      res.status(200).json(
        success(
          {
            status: 'ready',
            db_ms: dbMs,
            redis_ms: redisMs,
            checked_in_ms: Date.now() - start,
          },
          req.requestId,
        ),
      );
    } catch (err) {
      // 503 — caller will retry. Don't leak the underlying error to the
      // probe body; it's already in the structured log via errorHandler.
      config.log.warn('readyz failed', { err, requestId: req.requestId });
      res.status(503).json(
        failure(
          'INTERNAL_ERROR',
          'Service not ready',
          { checked_in_ms: Date.now() - start },
          req.requestId,
        ),
      );
    }
  };
}
