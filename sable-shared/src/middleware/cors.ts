// Origin allowlist driven by a static list (typically loaded once at boot
// from the gateway.cors_origins table). The cache key `cors:origins` is
// defined in sable-shared's cacheKeys for the loader.
//
// `cors` is an optional peer dep of sable-shared.

import cors from 'cors';
import type { CorsOptionsDelegate } from 'cors';

import { AppError } from '../errors/AppError.js';

export interface CorsConfig {
  /**
   * Allowed origins. Either a static array or a getter — pass a getter
   * when the list can change without a process restart (e.g. when the
   * gateway hot-reloads `gateway.cors_origins` from Redis).
   *
   * Use `['*']` for development only.
   */
  allowedOrigins: string[] | (() => string[]);
  /** Send cookies / authorization headers. Defaults to true. */
  credentials?: boolean;
}

export function corsMiddleware(config: CorsConfig) {
  const getAllowed = typeof config.allowedOrigins === 'function'
    ? config.allowedOrigins
    : () => config.allowedOrigins as string[];

  const delegate: CorsOptionsDelegate = (req, callback) => {
    const origin = req.headers.origin;

    if (origin === undefined) {
      // Non-browser clients (curl, server-to-server) — no Origin header,
      // CORS doesn't apply. Allow but disable credentials.
      callback(null, { origin: false });
      return;
    }

    const allowed = new Set(getAllowed());
    if (allowed.has('*') || allowed.has(origin)) {
      callback(null, {
        origin: true,
        credentials: config.credentials ?? true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Service-Token'],
        exposedHeaders: ['X-Request-Id'],
        maxAge: 86_400,
      });
      return;
    }

    callback(new AppError('FORBIDDEN', { message: `Origin ${origin} not allowed`, details: { origin } }));
  };

  return cors(delegate);
}
