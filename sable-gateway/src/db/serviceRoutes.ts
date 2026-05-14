// gateway.service_routes — routing table for /api/* proxy forwarding.
// Each row maps a path-prefix + method to a downstream Cloud Run URL,
// along with whether that route needs auth or a paid module.

import { withRequestContext, type Sql } from 'sable-shared';
import type { ModuleCode } from 'sable-shared';

export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'ANY';

export interface ServiceRouteRow {
  id: string;
  path_prefix: string;
  method: RouteMethod;
  target_service: string;
  target_url: string;
  required_module: ModuleCode | null;
  auth_required: boolean;
  is_active: boolean;
  created_at: Date;
}

/** Normalised in-process shape used by the proxy router. */
export interface ServiceRoute {
  pathPrefix: string;
  method: RouteMethod;
  targetService: string;
  targetUrl: string;
  requiredModule: ModuleCode | null;
  authRequired: boolean;
}

export async function listActive(sql: Sql): Promise<ServiceRouteRow[]> {
  return withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<ServiceRouteRow[]>`
      SELECT id, path_prefix, method, target_service, target_url,
             required_module, auth_required, is_active, created_at
      FROM gateway.service_routes
      WHERE is_active = true
      ORDER BY length(path_prefix) DESC, method
    `,
  );
}
