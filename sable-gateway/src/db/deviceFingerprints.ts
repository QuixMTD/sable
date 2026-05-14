// gateway.device_fingerprints — trusted-device map per user. New
// fingerprints trigger an email-confirm step the next time the user
// logs in from one.

import type { Sql, TransactionSql } from 'sable-shared';

export interface DeviceFingerprintRow {
  id: string;
  user_id: string;
  fingerprint_hash: Buffer;   // #️⃣
  label: string | null;
  last_seen_at: Date;
  created_at: Date;
}

export async function findByHash(_sql: Sql, _userId: string, _hash: Buffer): Promise<DeviceFingerprintRow | null> {
  throw new Error('TODO: implement db/deviceFingerprints.findByHash');
}

export async function record(_tx: TransactionSql, _userId: string, _hash: Buffer, _label: string | null): Promise<DeviceFingerprintRow> {
  throw new Error('TODO: implement db/deviceFingerprints.record');
}
