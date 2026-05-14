// /orgs router — all authed. Owner/admin gate happens inside controllers
// (the role check needs orgId from the path).

import { Router } from 'express';
import {
  authenticate,
  getDek,
  rateLimitByUser,
  setRlsContext,
} from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/orgs.js';

export function buildOrgsRouter(config: AppConfig): Router {
  const r = Router();
  const auth = authenticate({ sql: config.sql, redis: config.redis, cookieName: config.sessionCookieName });
  const rls = setRlsContext({ withDek: true, getDek });
  const limit = rateLimitByUser({ redis: config.redis, limit: 600, window: 'minute' });

  r.use(auth, rls, limit);

  r.post('/', ctrl.createOrg(config));
  r.get('/:id', ctrl.getOrg);
  r.patch('/:id', ctrl.updateOrg);
  r.get('/:id/members', ctrl.listMembers(config));
  r.post('/:id/invites', ctrl.inviteMember(config));
  r.get('/:id/invites', ctrl.listInvites(config));
  r.delete('/:id/invites/:inviteId', ctrl.revokeInvite(config));
  r.post('/invites/accept', ctrl.acceptInvite(config));
  r.delete('/:id/members/:userId', ctrl.removeMember(config));
  r.patch('/:id/members/:userId/role', ctrl.updateMemberRole(config));

  return r;
}
