// /public router — unauthenticated marketing / onboarding endpoints.
// Aggressively rate-limited per IP. /referrals/redeem is the one
// exception that needs an authenticated session.

import { Router } from 'express';
import {
  authenticate,
  getDek,
  rateLimitByIp,
  setRlsContext,
} from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/onboarding.js';

export function buildOnboardingRouter(config: AppConfig): Router {
  const r = Router();
  const limit = rateLimitByIp({ redis: config.redis, limit: 20, window: 'minute' });
  r.use(limit);

  r.post('/waitlist', ctrl.joinWaitlist(config));
  r.post('/enquiries', ctrl.submitEnquiry(config));

  const auth = authenticate({ sql: config.sql, redis: config.redis, cookieName: config.sessionCookieName });
  const rls = setRlsContext({ withDek: true, getDek });
  r.post('/referrals/redeem', auth, rls, ctrl.redeemReferral(config));

  return r;
}
