// gateway.service_health_log — periodic probe results for each
// downstream service. Partitioned weekly. Used by /admin to render the
// inter-service health dashboard.

import type { Sql, TransactionSql } from 'sable-shared';

export interface ServiceHealthLogRow {
  id: string;
  service_name: string;
  status: 'healthy' | 'degraded' | 'down';
  latency_ms: number | null;
  error: string | null;
  created_at: Date;
}

export async function append(_tx: TransactionSql, _input: Partial<ServiceHealthLogRow>): Promise<void> {
  throw new Error('TODO: implement db/serviceHealthLog.append');
}

export async function latestPerService(_sql: Sql): Promise<ServiceHealthLogRow[]> {
  throw new Error('TODO: implement db/serviceHealthLog.latestPerService');
}
