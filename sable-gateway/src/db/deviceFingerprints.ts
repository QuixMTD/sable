// gateway.device_fingerprints — trusted-device map per user. New
// fingerprints don't auto-trust — admin or user marks via /users/me
// once 2FA confirms. The is_trusted flag gates "skip step-up auth".

import { withRequestContext, type Sql } from 'sable-shared';

export type DevicePlatform = 'macos' | 'windows' | 'web';

export interface DeviceFingerprintRow {
  id: string;
  user_id: string;
  fingerprint_hash: Buffer;
  device_name: string | null;
  platform: DevicePlatform | null;
  first_seen_at: Date;
  last_seen_at: Date;
  is_trusted: boolean;
  trusted_at: Date | null;
  is_active: boolean;
}

export async function findByHash(sql: Sql, userId: string, hash: Buffer): Promise<DeviceFingerprintRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<DeviceFingerprintRow[]>`
      SELECT * FROM gateway.device_fingerprints
      WHERE user_id = ${userId} AND fingerprint_hash = ${hash}
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

/**
 * Upsert by (user_id, fingerprint_hash) — bumps last_seen_at on repeat,
 * inserts a new row on first sight. Returns the row.
 */
export async function record(
  sql: Sql,
  userId: string,
  hash: Buffer,
  platform: DevicePlatform | null,
  deviceName: string | null,
): Promise<DeviceFingerprintRow> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<DeviceFingerprintRow[]>`
      INSERT INTO gateway.device_fingerprints
        (user_id, fingerprint_hash, platform, device_name)
      VALUES (${userId}, ${hash}, ${platform}, ${deviceName})
      ON CONFLICT (user_id, fingerprint_hash) DO UPDATE
        SET last_seen_at = now()
      RETURNING *
    `,
  );
  return rows[0]!;
}
