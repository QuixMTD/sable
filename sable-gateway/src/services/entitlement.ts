// Entitlement service — keeps users.active_modules and
// organisations.active_modules in sync with the active subscription set.
//
// Source of truth: gateway.subscriptions.status (driven by Stripe).
// The enforce_active_modules_actor trigger blocks direct writes by
// non-gateway actors — only this service (acting as 'gateway' via RLS
// context) can update the denormalised arrays.

import {
  TTL,
  cacheKeys,
  withRequestContext,
  type ModuleCode,
  type RedisClient,
  type Sql,
} from 'sable-shared';

import * as orgsDb from '../db/organisations.js';
import * as usersDb from '../db/users.js';

const ACTIVE_STATUSES = new Set(['active', 'trialling']);

/**
 * Recompute a user's active_modules from their subscription rows and any
 * org-level subscriptions they inherit. Writes the result back to
 * users.active_modules and invalidates the modules:user:{id} cache so
 * the authenticate middleware picks up the new array on the next request.
 */
export async function recompute(sql: Sql, redis: RedisClient, userId: string): Promise<ModuleCode[]> {
  const user = await usersDb.findById(sql, userId);
  if (user === null) return [];

  const modules = await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    const userSubs = await tx<{ module: ModuleCode }[]>`
      SELECT DISTINCT module FROM gateway.subscriptions
      WHERE user_id = ${userId} AND status = ANY(${Array.from(ACTIVE_STATUSES)})
    `;
    const orgSubs = user.org_id !== null
      ? await tx<{ module: ModuleCode }[]>`
          SELECT DISTINCT module FROM gateway.subscriptions
          WHERE org_id = ${user.org_id} AND status = ANY(${Array.from(ACTIVE_STATUSES)})
        `
      : [];
    const all = Array.from(new Set([...userSubs.map((r) => r.module), ...orgSubs.map((r) => r.module)])).sort();
    await usersDb.setActiveModules(tx, userId, all);
    return all;
  });

  await redis.set(cacheKeys.modulesUser(userId), JSON.stringify(modules), 'EX', TTL.MODULES_USER);
  return modules;
}

/**
 * Org-wide recompute. Writes to organisations.active_modules and walks
 * every member to refresh their per-user cache entry.
 */
export async function recomputeForOrg(sql: Sql, redis: RedisClient, orgId: string): Promise<ModuleCode[]> {
  const modules = await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    const subs = await tx<{ module: ModuleCode }[]>`
      SELECT DISTINCT module FROM gateway.subscriptions
      WHERE org_id = ${orgId} AND status = ANY(${Array.from(ACTIVE_STATUSES)})
    `;
    const list = Array.from(new Set(subs.map((r) => r.module))).sort();
    await orgsDb.setActiveModules(tx, orgId, list);
    return list;
  });

  // Invalidate the per-user cache for every member so the authenticate
  // middleware refreshes from the new org row on the next request.
  const members = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<{ id: string }[]>`SELECT id FROM gateway.users WHERE org_id = ${orgId}`,
  );
  if (members.length > 0) {
    await redis.del(...members.map((m) => cacheKeys.modulesUser(m.id)));
  }
  return modules;
}
