// /api/* router — module-aware forwarder. One catch-all wildcard route
// that hands every request to controllers/proxy.forward, which does the
// resolve + entitlement check + outbound HMAC + stream.
//
// Auth chain: API-key Bearer (optional) → cookie session → setRlsContext.
// `authenticateApiKey` with optional=true populates req.session if a
// Bearer is present and falls through otherwise so `authenticate` can
// handle the cookie path.

import { Router } from 'express';
import {
  authenticate,
  authenticateApiKey,
  getDek,
  rateLimitByUser,
  setRlsContext,
} from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/proxy.js';

export function buildProxyRouter(config: AppConfig): Router {
  const r = Router();
  const apiKey = authenticateApiKey({ sql: config.sql, redis: config.redis, optional: true });
  const auth = authenticate({ sql: config.sql, redis: config.redis, cookieName: config.sessionCookieName });
  const rls = setRlsContext({ withDek: true, getDek });
  const limit = rateLimitByUser({ redis: config.redis, limit: 1_200, window: 'minute' });

  r.use(apiKey, auth, rls, limit);
  r.all('/*', ctrl.forward(config));

  return r;
}
