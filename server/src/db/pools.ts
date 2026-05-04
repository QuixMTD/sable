/**
 * Postgres connection pool.
 *
 * One pool per process. Created lazily on first getPool() call so importing
 * this module does not fail at load time when DATABASE_URL is not yet set
 * (e.g. inside tests that bring up a fixture before importing app code).
 *
 * Connection details come from DATABASE_URL — use the libpq URL form so SSL
 * options (sslmode, sslrootcert, etc.) travel with the connection string:
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/dbname?sslmode=require
 *
 * Tuneable via env (defaults shown):
 *   PG_POOL_MAX                 = 10    max concurrent clients in pool
 *   PG_IDLE_TIMEOUT_MS          = 30000 close idle clients after this long
 *   PG_CONNECT_TIMEOUT_MS       = 5000  fail connect attempts after this long
 *   PG_STATEMENT_TIMEOUT_MS     = 30000 server-side cap on any single statement
 *
 * Combined with the RLS helpers in ./RLS, every request opens a transaction,
 * sets the per-tenant session vars, runs its work, and returns the client to
 * the pool with the session vars discarded.
 */

import { Pool, type PoolConfig } from 'pg';

let _pool: Pool | undefined;

/** Return the process-wide pg Pool, creating it on first call. */
export function getPool(): Pool {
  if (!_pool) {
    _pool = createPool();
  }
  return _pool;
}

function createPool(): Pool {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const config: PoolConfig = {
    connectionString,
    max: intFromEnv('PG_POOL_MAX', 10),
    idleTimeoutMillis: intFromEnv('PG_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMillis: intFromEnv('PG_CONNECT_TIMEOUT_MS', 5_000),
    statement_timeout: intFromEnv('PG_STATEMENT_TIMEOUT_MS', 30_000),
  };

  const pool = new Pool(config);

  // Idle clients can hit server-side errors (network blip, server restart)
  // outside of a query. Without this handler Node treats the unhandled error
  // as fatal and exits. The pool will reconnect on next checkout.
  pool.on('error', (err) => {
    console.error('[pg pool] idle client error:', err);
  });

  return pool;
}

/**
 * Drain the pool. Call from your process shutdown handler so in-flight
 * queries can finish cleanly before the process exits.
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}
