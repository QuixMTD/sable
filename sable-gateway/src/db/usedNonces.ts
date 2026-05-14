// gateway.used_nonces — durable backstop for the Redis nonce:* keys.
// The hot path is Redis; this table catches replay attempts that span
// a Redis restart (TTL is only 30s so this is mostly defence-in-depth).

import type { TransactionSql } from 'sable-shared';

export interface UsedNonceRow {
  nonce: string;
  service_name: string;
  seen_at: Date;
  expires_at: Date;
}

export async function insert(_tx: TransactionSql, _nonce: string, _service: string, _expiresAt: Date): Promise<void> {
  throw new Error('TODO: implement db/usedNonces.insert');
}
