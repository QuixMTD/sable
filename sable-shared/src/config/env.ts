// Lightweight env-var validation. No external deps.
//
// Usage:
//   import { loadDatabaseEnv, loadRedisEnv, loadNodeEnv } from 'sable-shared/config';
//
//   const env = {
//     node: loadNodeEnv(),
//     db: loadDatabaseEnv(),
//     redis: loadRedisEnv(),
//   };
//
// Each loader throws EnvError eagerly at startup if anything is missing or
// malformed — fail fast, never start a misconfigured process.

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    throw new EnvError(`Missing required env var: ${name}`);
  }
  return v;
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function requireEnvNumber(name: string): number {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new EnvError(`Env var ${name} is not a number: ${JSON.stringify(raw)}`);
  }
  return n;
}

export function optionalEnvNumber(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new EnvError(`Env var ${name} is not a number: ${JSON.stringify(raw)}`);
  }
  return n;
}

export function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  if (/^(true|1|yes|on)$/i.test(raw)) return true;
  if (/^(false|0|no|off)$/i.test(raw)) return false;
  throw new EnvError(`Env var ${name} is not a boolean: ${JSON.stringify(raw)}`);
}

// ---------------------------------------------------------------------------
// NODE_ENV
// ---------------------------------------------------------------------------

export type NodeEnv = 'development' | 'test' | 'staging' | 'production';

export function loadNodeEnv(): NodeEnv {
  const raw = process.env.NODE_ENV ?? 'development';
  switch (raw) {
    case 'development':
    case 'test':
    case 'staging':
    case 'production':
      return raw;
    default:
      throw new EnvError(
        `NODE_ENV must be development|test|staging|production (got ${JSON.stringify(raw)})`,
      );
  }
}

// ---------------------------------------------------------------------------
// Database — DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD,
// or a single DATABASE_URL (postgres://user:pass@host:port/db) for local dev.
// ---------------------------------------------------------------------------

export interface DatabaseEnv {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
}

export function loadDatabaseEnv(): DatabaseEnv {
  const url = optionalEnv('DATABASE_URL');
  if (url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new EnvError(`DATABASE_URL is not a valid URL: ${JSON.stringify(url)}`);
    }
    if (!parsed.username || !parsed.pathname || parsed.pathname === '/') {
      throw new EnvError('DATABASE_URL must include user and database name');
    }
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined,
      database: parsed.pathname.replace(/^\//, ''),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }
  return {
    host: requireEnv('DB_HOST'),
    port: optionalEnv('DB_PORT') !== undefined ? requireEnvNumber('DB_PORT') : undefined,
    database: requireEnv('DB_NAME'),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
  };
}

// ---------------------------------------------------------------------------
// Redis — REDIS_URL (e.g. redis://:password@host:6379/0 or rediss://...).
// ---------------------------------------------------------------------------

export interface RedisEnv {
  url: string;
}

export function loadRedisEnv(): RedisEnv {
  const url = requireEnv('REDIS_URL');
  try {
    new URL(url);
  } catch {
    throw new EnvError(`REDIS_URL is not a valid URL: ${JSON.stringify(url)}`);
  }
  return { url };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface HttpEnv {
  port: number;
}

export function loadHttpEnv(): HttpEnv {
  // Cloud Run injects PORT=8080 by default.
  return { port: optionalEnvNumber('PORT', 8080) };
}
