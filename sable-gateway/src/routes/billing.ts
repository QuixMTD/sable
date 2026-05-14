// /billing router — all authed.

import { Router } from 'express';
import {
  authenticate,
  getDek,
  rateLimitByUser,
  setRlsContext,
} from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/billing.js';

export function buildBillingRouter(config: AppConfig): Router {
  const r = Router();
  const auth = authenticate({ sql: config.sql, redis: config.redis, cookieName: config.sessionCookieName });
  const rls = setRlsContext({ withDek: true, getDek });
  const limit = rateLimitByUser({ redis: config.redis, limit: 200, window: 'minute' });

  r.use(auth, rls, limit);

  r.post('/checkout', ctrl.createCheckoutSession);
  r.post('/portal', ctrl.createPortalSession);
  r.get('/subscriptions', ctrl.listSubscriptions(config));
  r.get('/invoices', ctrl.listInvoices(config));
  r.post('/subscriptions/cancel', ctrl.cancelSubscription(config));
  r.get('/modules', ctrl.listAvailableModules(config));

  return r;
}
