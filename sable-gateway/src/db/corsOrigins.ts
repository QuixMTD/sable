// gateway.cors_origins — allowed Origin values for the CORS middleware.
// Loaded once at boot and (eventually) refreshed via the cors:origins
// Redis cache when admins add/remove entries.

import { withRequestContext, type Sql } from 'sable-shared';

export type CorsEnvironment = 'production' | 'staging' | 'development';

export interface CorsOriginRow {
  id: string;
  origin: string;
  environment: CorsEnvironment;
  allow_credentials: boolean;
  is_active: boolean;
  created_at: Date;
}

export async function listActive(sql: Sql, environment: CorsEnvironment): Promise<CorsOriginRow[]> {
  return withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<CorsOriginRow[]>`
      SELECT id, origin, environment, allow_credentials, is_active, created_at
      FROM gateway.cors_origins
      WHERE is_active = true AND environment = ${environment}
      ORDER BY created_at DESC
    `,
  );
}
