// Gateway entry point.
//
// 1. Load env (Cloud Run injects from Secret Manager in prod; .env in dev).
// 2. Build the logger, DB pool, Redis client.
// 3. Load DB-backed boot config (active HMAC keys, allowed CORS origins,
//    downstream service routes) into Refreshable<T> wrappers so admin
//    writes propagate across instances without a restart.
// 4. Build the Express app with all shared middleware composed.
// 5. Listen + start the refresh poll loop.
// 6. Wait for SIGTERM, drain in-flight requests, close pools.

import {
  cacheKeys,
  closeDatabase,
  closeRedis,
  createDatabase,
  createLogger,
  createRedis,
  envFlag,
  loadDatabaseEnv,
  loadHttpEnv,
  loadRedisEnv,
  requireEnv,
} from 'sable-shared';

import { buildApp } from './app.js';
import { loadCorsOrigins } from './config/corsOrigins.js';
import { loadActiveHmacKeys } from './config/hmacKeys.js';
import { loadServiceRoutes } from './config/serviceRoutes.js';
import type { ServiceRoute } from './db/serviceRoutes.js';
import { Refreshable, startRefreshLoop } from './refreshable.js';

const SERVICE = 'sable-gateway';
const SESSION_COOKIE_NAME = 'sable_session';
const REFRESH_INTERVAL_MS = 10_000;

async function main(): Promise<void> {
  const log = createLogger(SERVICE);

  const dbEnv = loadDatabaseEnv();
  const sql = createDatabase({
    serviceName: SERVICE,
    role: requireEnv('DB_ROLE'),
    password: dbEnv.password,
    host: dbEnv.host,
    port: dbEnv.port,
    database: dbEnv.database,
    schema: 'gateway',
    prepare: !envFlag('DB_PGBOUNCER', false),
  });

  const redis = createRedis({ serviceName: SERVICE, url: loadRedisEnv().url });

  // Initial loads. Wrap each in a Refreshable so the polling loop can
  // swap the value in place when an admin bumps the version stamp.
  const [hmacInitial, corsInitial, routesInitial] = await Promise.all([
    loadActiveHmacKeys(sql),
    loadCorsOrigins(sql),
    loadServiceRoutes(sql),
  ]);

  let currentHmacVersion = Math.max(...hmacInitial.keys());

  const hmacKeysR = new Refreshable<ReadonlyMap<number, Buffer>>(
    hmacInitial,
    cacheKeys.hmacVersionsVersion(),
    async () => {
      const map = await loadActiveHmacKeys(sql);
      currentHmacVersion = Math.max(...map.keys());
      log.info('hmac keys reloaded', { versions: Array.from(map.keys()), current: currentHmacVersion });
      return map;
    },
  );

  const corsOriginsR = new Refreshable<string[]>(
    corsInitial,
    cacheKeys.corsOriginsVersion(),
    async () => {
      const list = await loadCorsOrigins(sql);
      log.info('cors origins reloaded', { count: list.length });
      return list;
    },
  );

  const serviceRoutesR = new Refreshable<ReadonlyMap<string, ServiceRoute>>(
    routesInitial,
    cacheKeys.serviceRoutesVersion(),
    async () => {
      const map = await loadServiceRoutes(sql);
      log.info('service routes reloaded', { count: map.size });
      return map;
    },
  );

  const app = buildApp({
    sql,
    redis,
    log,
    hmacKeys: () => hmacKeysR.current(),
    currentHmacVersion: () => currentHmacVersion,
    corsOrigins: () => corsOriginsR.current(),
    serviceRoutes: () => serviceRoutesR.current(),
    sessionCookieName: SESSION_COOKIE_NAME,
  });

  const refreshTimer = startRefreshLoop({
    redis,
    intervalMs: REFRESH_INTERVAL_MS,
    entries: [hmacKeysR, corsOriginsR, serviceRoutesR],
    onError: (err) => log.error('refresh-loop error', { err }),
  });

  const { port } = loadHttpEnv();
  const server = app.listen(port, () => {
    log.info(`${SERVICE} listening`, {
      port,
      corsOrigins: corsInitial.length,
      hmacKeys: hmacInitial.size,
      serviceRoutes: routesInitial.size,
    });
  });

  // Graceful shutdown: stop accepting new connections, drain in-flight,
  // close DB / Redis. Cloud Run sends SIGTERM ~10s before SIGKILL.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown requested', { signal });
    clearInterval(refreshTimer);
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      log.info('http server closed');
      await Promise.all([closeRedis(redis), closeDatabase(sql)]);
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error('shutdown error', { err });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('boot failed', err);
  process.exit(1);
});
