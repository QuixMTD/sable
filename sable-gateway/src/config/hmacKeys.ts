// Loads active HMAC key versions at boot.
//
// `gateway.hmac_key_versions` stores a `key_ref` per version pointing at a
// Secret Manager secret. In Cloud Run, those secrets are injected as env
// vars (HMAC_KEY_V1, HMAC_KEY_V2, …) so the code path is uniform across
// prod / staging / dev (.env file in dev). We resolve `key_ref` →
// `process.env[key_ref]` to fetch the bytes.

import { AppError, requireEnv, type Sql } from 'sable-shared';

import { listActiveVersions } from '../db/hmacKeys.js';

const KEY_ENV_PREFIX = 'HMAC_KEY_V';

/**
 * Returns Map<version, key bytes>. Throws if no versions are active or
 * the matching env var is missing — gateway must not start with a
 * partial set, otherwise inbound traffic signed with a known version
 * would be rejected.
 */
export async function loadActiveHmacKeys(sql: Sql): Promise<ReadonlyMap<number, Buffer>> {
  const rows = await listActiveVersions(sql);
  if (rows.length === 0) {
    throw new AppError('INTERNAL_ERROR', {
      message: 'gateway.hmac_key_versions has no active rows — cannot boot',
    });
  }

  const out = new Map<number, Buffer>();
  for (const row of rows) {
    // Convention: row.key_ref names the Secret Manager secret AND the env
    // var Cloud Run injects (e.g. 'HMAC_KEY_V1' → process.env.HMAC_KEY_V1).
    // For local dev, set these directly in .env.
    const envName = row.key_ref.startsWith(KEY_ENV_PREFIX) ? row.key_ref : `${KEY_ENV_PREFIX}${row.version}`;
    const raw = requireEnv(envName);
    out.set(row.version, Buffer.from(raw, 'base64'));
  }
  return out;
}
