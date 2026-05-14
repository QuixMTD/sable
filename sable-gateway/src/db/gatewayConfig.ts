// gateway.gateway_config — runtime-tunable key/value store. Backed by
// the cache:config:cache Redis key. Admin-editable.

import type { Sql, TransactionSql } from 'sable-shared';

export interface GatewayConfigRow {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: Date;
}

export async function getAll(_sql: Sql): Promise<GatewayConfigRow[]> {
  throw new Error('TODO: implement db/gatewayConfig.getAll');
}

export async function set(_tx: TransactionSql, _key: string, _value: unknown, _updatedBy: string): Promise<void> {
  throw new Error('TODO: implement db/gatewayConfig.set');
}
