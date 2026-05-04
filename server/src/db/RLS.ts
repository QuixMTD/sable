/**
 * Per-request RLS session variables for tenant isolation.
 *
 * The schema's RLS policies read three Postgres session variables:
 *   - app.current_user_id  (UUID of the authenticated user)
 *   - app.current_org_id   (UUID of the user's current organisation)
 *   - app.is_admin         ('true' | 'false' — platform-admin bypass)
 *
 * Set via set_config(name, value, is_local=true) so the values are scoped to
 * a single transaction. That guarantees they cannot leak to the next caller
 * of this pooled connection — when the transaction commits or rolls back,
 * the session reverts to having no values set, and any policy that reads
 * them returns NULL (which fails the equality checks → deny by default).
 *
 * Usage:
 *
 *   import { Pool } from 'pg';
 *   import { withRlsContext, rlsQuery, userContext } from '@/db/RLS';
 *
 *   const pool = new Pool({ ... });
 *
 *   // Multiple statements in one transaction:
 *   await withRlsContext(pool, userContext(userId, orgId), async (client) => {
 *     const { rows: portfolios } = await client.query('SELECT * FROM portfolios');
 *     await client.query('INSERT INTO theses (...) VALUES (...)', [...]);
 *     return portfolios;
 *   });
 *
 *   // Single statement:
 *   const result = await rlsQuery<{ id: string; name: string }>(
 *     pool,
 *     userContext(userId, orgId),
 *     'SELECT id, name FROM portfolios WHERE id = $1',
 *     [portfolioId],
 *   );
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface RlsContext {
  /** UUID of the authenticated user. Empty string treated as NULL by the DB. */
  userId: string;
  /** UUID of the user's current organisation. Empty string treated as NULL. */
  orgId: string;
  /** Bypass tenant policies. Use only for platform-admin operations. */
  isAdmin?: boolean;
}

/** Build an RLS context for an authenticated user. */
export function userContext(userId: string, orgId: string): RlsContext {
  return { userId, orgId, isAdmin: false };
}

/**
 * Build an RLS context that bypasses every tenant policy. The userId is still
 * recorded in audit_log entries, so pass the actual admin's UUID.
 */
export function adminContext(userId: string): RlsContext {
  return { userId, orgId: '', isAdmin: true };
}

/**
 * Acquire a pooled client, open a transaction, set the RLS session vars, run
 * `fn` against the client, then commit. Rolls back and re-throws on error.
 * Always returns the client to the pool.
 *
 * Do not nest calls — this helper opens its own BEGIN. If you need multiple
 * operations to share a transaction, do them inside one callback.
 */
export async function withRlsContext<T>(
  pool: Pool,
  ctx: RlsContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT
         set_config('app.current_user_id', $1, true),
         set_config('app.current_org_id',  $2, true),
         set_config('app.is_admin',        $3, true)`,
      [ctx.userId, ctx.orgId, ctx.isAdmin ? 'true' : 'false'],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Rollback can fail if the connection is already broken; fall through.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Convenience for single-statement queries with RLS context. Equivalent to
 * withRlsContext(pool, ctx, c => c.query(text, values)).
 */
export async function rlsQuery<R extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  ctx: RlsContext,
  text: string,
  values?: unknown[],
): Promise<QueryResult<R>> {
  return withRlsContext(pool, ctx, (client) => client.query<R>(text, values));
}
