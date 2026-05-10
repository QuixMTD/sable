// postgres.js connection factory shared by all Sable Node services.
//
// Each service:
//   1. Calls createDatabase() once at startup with its own role + search_path.
//   2. Wraps every request in withRequestContext() so RLS policies see the
//      authenticated user's identity via SET LOCAL session vars.
//
// Helpers (enc/dec/sha256/app_*) live in the `public` schema, so every
// service must include `public` in its searchPath.

import postgres, { type Sql } from 'postgres';

import type { ActorType } from '../constants/actors.js';
import type { UserRole } from '../constants/roles.js';

// ---------------------------------------------------------------------------
// Pool config
// ---------------------------------------------------------------------------

export interface DatabaseConfig {
  /** Logical service name. Surfaces in pg_stat_activity.application_name. */
  serviceName: string;
  /**
   * Postgres role this service connects as. Each service has its own role
   * with GRANTs only to its own schema (gateway_svc, core_svc, ...).
   */
  role: string;
  /** Password fetched from GCP Secret Manager at startup. */
  password: string;
  /**
   * Host. Either a TCP host (Cloud SQL private IP, localhost in dev) or a
   * Unix socket path (`/cloudsql/PROJECT:REGION:INSTANCE`). The factory
   * detects the socket form by the leading `/`.
   */
  host: string;
  port?: number;
  database: string;
  /**
   * The Postgres schema this service owns (`gateway`, `core`, `sc`, ...).
   * The factory builds search_path = [schema, 'public'] so RLS helpers
   * (enc/dec/sha256/app_*) in `public` resolve. Override `searchPath` for
   * the rare service that needs more than two schemas.
   */
  schema: string;
  /**
   * Explicit search_path override. Defaults to `[schema, 'public']`. Must
   * include `public` if you set it directly — RLS helpers live there.
   */
  searchPath?: string[];
  /**
   * Max pooled connections per process. Default 5 — Cloud Run scales
   * horizontally, so each instance only needs a handful. Total connections
   * to Postgres = max × instance_count; size against Cloud SQL's
   * `max_connections` (or your PgBouncer pool).
   */
  max?: number;
  /**
   * Disable prepared statements. Set `false` when fronting Postgres with
   * PgBouncer in transaction-pooling mode — pgbouncer can't keep prepared
   * statements across statement boundaries within a session, but our
   * `withRequestContext` wraps each unit of work in BEGIN/COMMIT, so we're
   * compatible. Defaults to `true` (prepared statements on, direct Cloud SQL).
   */
  prepare?: boolean;
  /** Seconds an idle connection lives before being closed. Default 20. */
  idleTimeoutSec?: number;
  /** Per-statement timeout in ms. Default 30_000. */
  statementTimeoutMs?: number;
  /**
   * Idle-in-transaction timeout in ms. Default 60_000. Long-held transactions
   * pin a connection and block VACUUM; this is a hard cap on bugs.
   */
  idleInTxTimeoutMs?: number;
  /** Override SSL behaviour. Defaults to 'require' for TCP, off for Unix sockets. */
  ssl?: 'require' | 'allow' | 'prefer' | 'verify-full' | boolean | object;
}

export function createDatabase(config: DatabaseConfig): Sql {
  const isUnixSocket = config.host.startsWith('/');
  const searchPath = config.searchPath ?? [config.schema, 'public'];

  return postgres({
    host: config.host,
    port: isUnixSocket ? undefined : (config.port ?? 5432),
    database: config.database,
    user: config.role,
    password: config.password,

    max: config.max ?? 5,
    idle_timeout: config.idleTimeoutSec ?? 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30, // recycle connections every 30 min — survives Cloud SQL restarts cleanly
    prepare: config.prepare ?? true,

    ssl: isUnixSocket ? false : (config.ssl ?? 'require'),

    // Server-side parameters applied on every connection. Postgres.js types
    // the strongly-typed GUCs (statement_timeout, idle_in_transaction_*) as
    // numbers; arbitrary GUCs (search_path) flow through the index signature
    // as string | number | boolean.
    connection: {
      application_name: config.serviceName,
      search_path: searchPath.join(', '),
      statement_timeout: config.statementTimeoutMs ?? 30_000,
      idle_in_transaction_session_timeout: config.idleInTxTimeoutMs ?? 60_000,
    },

    // Suppress NOTICE spam from CREATE OR REPLACE / IF NOT EXISTS in migrations.
    onnotice: () => {},
  });
}

// ---------------------------------------------------------------------------
// Per-request RLS context
// ---------------------------------------------------------------------------

export interface RequestContext {
  userId?: string;
  orgId?: string;
  role?: UserRole;
  actor: ActorType;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  /**
   * Per-session DEK for pgp_sym_encrypt/decrypt. Unwrapped from GCP KMS by
   * the gateway and only set on transactions that touch encrypted columns.
   */
  dek?: string;
}

/**
 * Run `fn` inside a transaction with the request's identity bound via
 * `SET LOCAL`. RLS policies key off these session vars; without them, every
 * policy denies. This is the only correct way to query as a specific user.
 *
 * Uses `set_config(name, value, true)` (rather than literal SET LOCAL) so
 * values flow through postgres.js's parameter binding — no string escaping,
 * no injection surface.
 */
export async function withRequestContext<T>(
  sql: Sql,
  ctx: RequestContext,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    const vars: Array<[string, string | undefined]> = [
      ['app.user_id', ctx.userId],
      ['app.org_id', ctx.orgId],
      ['app.role', ctx.role],
      ['app.actor', ctx.actor],
      ['app.is_admin', ctx.isAdmin?.toString()],
      ['app.is_super_admin', ctx.isSuperAdmin?.toString()],
      ['app.dek', ctx.dek],
    ];

    for (const [name, value] of vars) {
      if (value === undefined) continue;
      await tx`SELECT set_config(${name}, ${value}, true)`;
    }

    return fn(tx);
  }) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Liveness check for `/healthz`. Returns the latency in ms or throws.
 * Uses a separate short timeout so a stuck pool can't wedge the probe.
 */
export async function pingDatabase(sql: Sql, timeoutMs = 2000): Promise<number> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('db ping timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return Date.now() - start;
}

/** Graceful shutdown — call on SIGTERM. Cloud Run gives ~10s. */
export async function closeDatabase(sql: Sql, timeoutSec = 5): Promise<void> {
  await sql.end({ timeout: timeoutSec });
}
