// Express app builder. Pure function of its dependencies — server.ts owns
// lifecycle (open/close DB, Redis, etc.); app.ts only wires middleware
// and mounts routes.
//
// Middleware chain (order matters):
//   1. requestId            — correlation ID for every request
//   2. httpLogger           — one log line per response
//   3. helmetMiddleware     — security headers
//   4. corsMiddleware       — origin allowlist (DB-driven)
//   5. compressionMiddleware
//   6. jsonBodyParser       — also stashes rawBody for HMAC-verifying routes
//   7. urlencodedBodyParser
//   8. cookieParser         — populates req.cookies for authenticate()
//   9. blockGate            — IP block check (Redis-only, very cheap)
//  10. rateLimitByIp        — coarse cap across every request
//  11. routes               — sub-routers add their own auth + per-user limits
//  12. errorHandler         — last, renders failure() envelopes

import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import {
  blockGate,
  compressionMiddleware,
  corsMiddleware,
  errorHandler,
  helmetMiddleware,
  httpLogger,
  jsonBodyParser,
  rateLimitByIp,
  requestId,
  urlencodedBodyParser,
  type Logger,
  type RedisClient,
  type Sql,
} from 'sable-shared';

import { buildRouter } from './routes/index.js';
import type { ServiceRoute } from './db/serviceRoutes.js';
import { botSignal } from './services/botDetection.js';

export interface AppConfig {
  sql: Sql;
  redis: RedisClient;
  log: Logger;
  /**
   * Accessors for boot-loaded tables. Implemented as getters because
   * server.ts hot-reloads each one via Refreshable<T> — admin writes
   * bump a Redis version stamp; a polling loop reloads from Postgres
   * across every gateway instance.
   */
  hmacKeys: () => ReadonlyMap<number, Buffer>;
  currentHmacVersion: () => number;
  corsOrigins: () => string[];
  serviceRoutes: () => ReadonlyMap<string, ServiceRoute>;
  /** Cookie name carrying the opaque session token. */
  sessionCookieName: string;
}

export function buildApp(config: AppConfig): Express {
  const app = express();

  // Trust the proxy in front of us (Cloud Run / load balancer) so
  // req.ip reflects the original client and req.protocol respects
  // X-Forwarded-Proto.
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(httpLogger(config.log));
  app.use(helmetMiddleware());
  app.use(corsMiddleware({ allowedOrigins: () => config.corsOrigins() }));
  app.use(compressionMiddleware());
  app.use(jsonBodyParser());
  app.use(urlencodedBodyParser());
  app.use(cookieParser());

  // Blocked-IP gate runs after we know the IP but before any DB work. It
  // only reads Redis (block:cache:*), so misses are negligible cost.
  app.use(blockGate({ redis: config.redis }));

  // Coarse global per-IP ceiling. Per-route limits (auth, public, proxy)
  // sit on top of this with tighter limits.
  app.use(rateLimitByIp({ redis: config.redis, limit: 2_400, window: 'minute' }));

  // Bot-signal sampler. Fire-and-forget — records inter-request gaps
  // and lack-of-mouse telemetry on every request; the authed routers
  // append the userId via req.session before their handlers run.
  app.use(botSignal({ sql: config.sql, redis: config.redis }));

  app.use(buildRouter(config));

  // Error handler — must be the last middleware so thrown errors from
  // any route or upstream middleware land here.
  app.use(errorHandler(config.log));

  return app;
}
