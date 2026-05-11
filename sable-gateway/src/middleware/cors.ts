// Origin allowlist driven by gateway.cors_origins (with a short-TTL Redis
// cache). The list of allowed origins is loaded once at startup and
// invalidated when the admin updates the row — the cache key `cors:origins`
// is already defined in sable-shared's cacheKeys.
//
// Until the cache loader is wired, the middleware accepts a static list
// passed in from the app boot (sourced from env or the DB).

import cors from 'cors';
import type { CorsOptionsDelegate } from 'cors';

import { AppError } from 'sable-shared';

export interface CorsConfig {
  /** Allowed origins. Use ['*'] for development only. */
  allowedOrigins: string[];
  /** Send cookies / authorization headers. Defaults to true. */
  credentials?: boolean;
}

export function corsMiddleware(config: CorsConfig) {
  const allowed = new Set(config.allowedOrigins);
  const wildcard = allowed.has('*');

  const delegate: CorsOptionsDelegate = (req, callback) => {
    const origin = req.headers.origin;

    if (origin === undefined) {
      // Non-browser clients (curl, server-to-server) — no Origin header,
      // CORS doesn't apply. Allow but disable credentials.
      callback(null, { origin: false });
      return;
    }

    if (wildcard || allowed.has(origin)) {
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
