// DEK (Data Encryption Key) handling for the gateway. The actual
// encryption is performed inside Postgres via the `enc()` / `dec()`
// helper functions in gateway-schema.sql, which call `pgp_sym_encrypt` /
// `pgp_sym_decrypt` with the per-session DEK pulled from
// `current_setting('app.dek')`.
//
// This file handles the gateway side: load the DEK once at boot (from
// Secret Manager via env-injection), cache it for the process lifetime,
// and hand it to `withRequestContext` so the SET LOCAL fires inside the
// transaction.
//
// Production: GCP KMS unwraps an envelope-encrypted DEK at startup. For
// dev / staging, the DEK is set directly via env var.

import { requireEnv } from 'sable-shared';

let cachedDek: string | undefined;

/**
 * Returns the per-session DEK string. Cached after the first call.
 * Throws if APP_DEK is not configured (which is intentional — gateway
 * must not start without one).
 */
export function getDek(): string {
  cachedDek ??= requireEnv('APP_DEK');
  return cachedDek;
}

/**
 * Test-only escape hatch — clears the cache so a fresh getDek() re-reads
 * env. Do not call in production code paths.
 */
export function _resetDekForTests(): void {
  cachedDek = undefined;
}
