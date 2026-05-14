// gateway.certification_usage — Stage-2 Sable Institute usage-hours
// tracking. Currently inert (gateway forwards usage pings from the
// modules); kept here so the schema and TS row shapes stay in sync.

import type { Sql, TransactionSql } from 'sable-shared';

export interface CertificationUsageRow {
  id: string;
  user_id: string;
  module: string;
  hours_logged: string;     // numeric
  recorded_at: Date;
  created_at: Date;
}

export async function totalsByUser(_sql: Sql, _userId: string): Promise<Record<string, string>> {
  throw new Error('TODO: implement db/certificationUsage.totalsByUser');
}

export async function append(_tx: TransactionSql, _input: Partial<CertificationUsageRow>): Promise<void> {
  throw new Error('TODO: implement db/certificationUsage.append');
}
