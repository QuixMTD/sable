// /admin router. Admins log in through the standard user flow (their
// `users` row carries account_type='admin'); the `requireAdmin` guard
// rejects anyone who isn't, and the super-admin-only routes layer a
// second guard with superAdminOnly=true.

import { Router } from 'express';
import {
  authenticate,
  getDek,
  rateLimitByUser,
  requireAdmin,
  setRlsContext,
} from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/admin.js';

export function buildAdminRouter(config: AppConfig): Router {
  const r = Router();
  const auth = authenticate({ sql: config.sql, redis: config.redis, cookieName: config.sessionCookieName });
  const rls = setRlsContext({ withDek: true, getDek });
  const adminOnly = requireAdmin();
  const superOnly = requireAdmin({ superAdminOnly: true });
  const limit = rateLimitByUser({ redis: config.redis, limit: 600, window: 'minute' });

  r.use(auth, rls, adminOnly, limit);

  r.post('/hmac-keys/rotate', superOnly, ctrl.rotateHmacKey(config));
  r.get('/hmac-keys', ctrl.listHmacKeys(config));
  r.get('/sessions', ctrl.listActiveSessions(config));
  r.delete('/sessions/:id', ctrl.forceRevokeSession(config));
  r.post('/blocks', ctrl.blockEntity(config));
  r.delete('/blocks/:id', ctrl.unblockEntity(config));
  r.get('/blocks', ctrl.listBlocks(config));
  r.get('/security-events', ctrl.listSecurityEvents(config));
  r.get('/audit', ctrl.listAuditLog(config));
  r.get('/health/services', ctrl.listServiceHealth(config));
  r.get('/config', ctrl.getConfig(config));
  r.patch('/config', superOnly, ctrl.setConfig(config));
  r.get('/enquiries', ctrl.listEnquiries(config));
  r.patch('/enquiries/:id', ctrl.updateEnquiry(config));

  return r;
}
