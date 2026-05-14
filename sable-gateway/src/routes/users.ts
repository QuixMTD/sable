// /users router — entirely authenticated. Per-user rate cap protects
// against authed-but-runaway clients (faulty SDK loops, etc.).

import { Router } from 'express';
import {
  authenticate,
  getDek,
  rateLimitByUser,
  setRlsContext,
} from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/users.js';

export function buildUsersRouter(config: AppConfig): Router {
  const r = Router();
  const auth = authenticate({ sql: config.sql, redis: config.redis, cookieName: config.sessionCookieName });
  const rls = setRlsContext({ withDek: true, getDek });
  const limit = rateLimitByUser({ redis: config.redis, limit: 600, window: 'minute' });

  r.use(auth, rls, limit);

  r.get('/me', ctrl.getMe(config));
  r.patch('/me', ctrl.updateMe(config));
  r.delete('/me', ctrl.deactivateMe(config));
  r.get('/me/api-keys', ctrl.listMyApiKeys(config));
  r.post('/me/api-keys', ctrl.issueMyApiKey(config));
  r.delete('/me/api-keys/:id', ctrl.revokeMyApiKey(config));

  return r;
}
