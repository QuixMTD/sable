// /certification router — all authed (candidates check eligibility,
// start attempts, submit answers, list their history + certificates).

import { Router } from 'express';
import {
  authenticate,
  getDek,
  rateLimitByUser,
  setRlsContext,
} from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/certification.js';

export function buildCertificationRouter(config: AppConfig): Router {
  const r = Router();
  const auth = authenticate({ sql: config.sql, redis: config.redis, cookieName: config.sessionCookieName });
  const rls = setRlsContext({ withDek: true, getDek });
  const limit = rateLimitByUser({ redis: config.redis, limit: 600, window: 'minute' });
  // Tight per-user cap on attempt starts — the underlying flow does a
  // signed ledger append on every pass; we don't want a runaway client
  // hammering it.
  const attemptStartLimit = rateLimitByUser({ redis: config.redis, limit: 10, window: 'hour' });

  r.use(auth, rls, limit);

  r.get('/me', ctrl.me(config));
  r.get('/me/certificates', ctrl.listMyCertificates(config));
  r.get('/attempts', ctrl.listAttempts(config));
  r.post('/attempts', attemptStartLimit, ctrl.startAttempt(config));
  r.post('/attempts/:id/submit', ctrl.submitAttempt(config));

  return r;
}
