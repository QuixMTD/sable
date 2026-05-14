// /auth router.
//
// Public:    /signup, /login, /password/reset/request,
//            /password/reset/confirm, /verify
// Authed:    /logout, /me, /sessions, /sessions/:id, /password/change,
//            /mfa/enroll, /mfa/verify, /mfa/disable
//
// Per-route rate limits stop credential-stuffing on /login and email
// enumeration on /password/reset/request. Authed endpoints share an
// authenticate + setRlsContext chain.

import { Router } from 'express';
import {
  authenticate,
  rateLimitByIp,
  setRlsContext,
  getDek,
} from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/auth.js';

export function buildAuthRouter(config: AppConfig): Router {
  const r = Router();

  // Tight per-IP limits on the unauthenticated entry points.
  const loginLimit = rateLimitByIp({ redis: config.redis, limit: 10, window: 'minute' });
  const signupLimit = rateLimitByIp({ redis: config.redis, limit: 5, window: 'minute' });
  const resetLimit = rateLimitByIp({ redis: config.redis, limit: 5, window: 'minute' });

  r.post('/signup', signupLimit, ctrl.signup(config));
  r.post('/login', loginLimit, ctrl.login(config));
  r.post('/password/reset/request', resetLimit, ctrl.requestPasswordReset(config));
  r.post('/password/reset/confirm', resetLimit, ctrl.confirmPasswordReset(config));
  r.post('/verify', resetLimit, ctrl.verifyEmail(config));

  // Authed sub-tree.
  const auth = authenticate({ sql: config.sql, redis: config.redis, cookieName: config.sessionCookieName });
  const rls = setRlsContext({ withDek: true, getDek });

  r.post('/logout', auth, rls, ctrl.logout(config));
  r.get('/me', auth, rls, ctrl.me(config));
  r.get('/sessions', auth, rls, ctrl.listSessions(config));
  r.delete('/sessions/:id', auth, rls, ctrl.revokeSession(config));
  r.post('/password/change', auth, rls, ctrl.changePassword(config));
  r.post('/mfa/enroll', auth, rls, ctrl.enrollMfa);
  r.post('/mfa/verify', auth, rls, ctrl.verifyMfa);
  r.post('/mfa/disable', auth, rls, ctrl.disableMfa);

  return r;
}
