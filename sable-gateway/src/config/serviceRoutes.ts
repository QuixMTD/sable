// Loads downstream service URLs at boot. The proxy router uses this
// table to figure out which Cloud Run URL to forward `/api/{module}/...`
// requests to. Auth + module entitlement requirements are encoded per
// route, so the proxy doesn't need a hard-coded map.

import type { Sql } from 'sable-shared';

import { listActive, type ServiceRoute, type ServiceRouteRow } from '../db/serviceRoutes.js';

export async function loadServiceRoutes(sql: Sql): Promise<ReadonlyMap<string, ServiceRoute>> {
  const rows = await listActive(sql);
  const out = new Map<string, ServiceRoute>();
  for (const row of rows) {
    out.set(routeKey(row), {
      pathPrefix: row.path_prefix,
      method: row.method,
      targetService: row.target_service,
      targetUrl: row.target_url,
      requiredModule: row.required_module,
      authRequired: row.auth_required,
    });
  }
  return out;
}

/** Key in the in-process map. Method last so prefix scans are cheap. */
function routeKey(row: ServiceRouteRow): string {
  return `${row.path_prefix}::${row.method}`;
}
