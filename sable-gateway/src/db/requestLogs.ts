// gateway.request_logs — sampled / on-demand request log. The hot path
// is the structured stdout logger (Cloud Logging); this table is for
// admin queries that need durable storage. Partitioned daily.

import type { TransactionSql } from 'sable-shared';

export interface RequestLogRow {
  id: string;
  request_id: string;
  user_id: string | null;
  org_id: string | null;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  ip_address: string | null;
  created_at: Date;
}

export async function append(_tx: TransactionSql, _input: Partial<RequestLogRow>): Promise<void> {
  throw new Error('TODO: implement db/requestLogs.append');
}
