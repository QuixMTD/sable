// Loads allowed CORS origins at boot. The environment is sourced from
// NODE_ENV (defaulting to 'development') and maps to the same value in
// gateway.cors_origins.environment.

import { loadNodeEnv, type Sql } from 'sable-shared';

import { listActive, type CorsEnvironment } from '../db/corsOrigins.js';

export async function loadCorsOrigins(sql: Sql): Promise<string[]> {
  const env = nodeEnvToCorsEnv(loadNodeEnv());
  const rows = await listActive(sql, env);
  return rows.map((r) => r.origin);
}

function nodeEnvToCorsEnv(nodeEnv: string): CorsEnvironment {
  switch (nodeEnv) {
    case 'production':
      return 'production';
    case 'staging':
      return 'staging';
    default:
      // development + test both map to 'development' CORS origins.
      return 'development';
  }
}
