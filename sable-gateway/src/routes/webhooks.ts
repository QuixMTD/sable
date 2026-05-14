// /webhooks router. No auth middleware — verification is per-route via
// the source-specific signature header (Stripe-Signature, etc.) read
// from req.rawBody. IP-rate-limited to slow down anyone hammering a
// signature oracle.

import { Router } from 'express';
import { rateLimitByIp } from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/webhooks.js';

export function buildWebhooksRouter(config: AppConfig): Router {
  const r = Router();
  const limit = rateLimitByIp({ redis: config.redis, limit: 120, window: 'minute' });
  r.use(limit);
  r.post('/stripe', ctrl.stripe);
  return r;
}
