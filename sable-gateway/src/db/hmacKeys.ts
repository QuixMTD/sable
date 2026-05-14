// gateway.hmac_key_versions — active versions used to verify inbound
// service-auth signatures. The row stores a *reference* (key_ref) to the
// secret in GCP Secret Manager; the actual key bytes are loaded from
// env vars (Cloud Run injects them) — see config/hmacKeys.ts.

import { withRequestContext, type Sql } from 'sable-shared';

export interface HmacKeyVersionRow {
  id: string;
  version: number;
  key_ref: string;
  is_active: boolean;
  activated_at: Date;
  deprecated_at: Date | null;
  expires_at: Date | null;
}

/** All currently-usable HMAC versions (active, not deprecated, not expired). */
export async function listActiveVersions(sql: Sql): Promise<HmacKeyVersionRow[]> {
  return withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<HmacKeyVersionRow[]>`
      SELECT id, version, key_ref, is_active, activated_at, deprecated_at, expires_at
      FROM gateway.hmac_key_versions
      WHERE is_active = true
        AND (deprecated_at IS NULL OR deprecated_at > now())
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY version DESC
    `,
  );
}
