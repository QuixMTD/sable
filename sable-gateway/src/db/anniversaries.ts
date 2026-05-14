// gateway.anniversaries — partitioned by year. Records yearly customer
// milestones (subscription anniversary, founding-customer 1-year, etc.).

import type { Sql, TransactionSql } from 'sable-shared';

export interface AnniversaryRow {
  id: string;
  org_id: string | null;
  user_id: string | null;
  kind: string;             // 'subscription_year_1', 'founding_customer_anniversary', ...
  year: number;
  acknowledged_at: Date | null;
  created_at: Date;
}

export async function listPending(_sql: Sql): Promise<AnniversaryRow[]> {
  throw new Error('TODO: implement db/anniversaries.listPending');
}

export async function create(_tx: TransactionSql, _input: Partial<AnniversaryRow>): Promise<AnniversaryRow> {
  throw new Error('TODO: implement db/anniversaries.create');
}
