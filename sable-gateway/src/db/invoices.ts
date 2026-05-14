// gateway.invoices — Stripe invoice mirror. Partitioned by created_at
// (monthly). Source of truth is Stripe; this is for the user's UI and
// for the audit trail.

import type { Sql, TransactionSql } from 'sable-shared';

export interface InvoiceRow {
  id: string;
  org_id: string | null;
  user_id: string | null;
  stripe_invoice_id: string;
  amount_gbp: string;       // numeric
  status: string;           // 'paid', 'open', 'void', etc. (mirrors Stripe)
  invoiced_at: Date;
  created_at: Date;
}

export async function listByOrg(_sql: Sql, _orgId: string): Promise<InvoiceRow[]> {
  throw new Error('TODO: implement db/invoices.listByOrg');
}

export async function upsertFromStripe(_tx: TransactionSql, _input: Partial<InvoiceRow>): Promise<InvoiceRow> {
  throw new Error('TODO: implement db/invoices.upsertFromStripe');
}
