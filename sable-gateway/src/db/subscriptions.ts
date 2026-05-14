// gateway.subscriptions — one row per Stripe subscription. Each
// subscription pays for one module at a given seat count; an org with
// S&C + Property has two rows.

import type { ModuleCode, Sql, TransactionSql } from 'sable-shared';

export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled' | 'trialling';
export type BillingCycle = 'monthly' | 'annual';

export interface SubscriptionRow {
  id: string;
  org_id: string | null;
  user_id: string | null;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  module: ModuleCode;
  seat_count: number;
  price_per_seat_gbp: string;       // numeric — comes back as string
  billing_cycle: BillingCycle;
  status: SubscriptionStatus;
  trial_end_at: Date | null;
  current_period_start: Date;
  current_period_end: Date;
  created_at: Date;
  updated_at: Date;
}

export async function listByOrg(_sql: Sql, _orgId: string): Promise<SubscriptionRow[]> {
  throw new Error('TODO: implement db/subscriptions.listByOrg');
}

export async function listByUser(_sql: Sql, _userId: string): Promise<SubscriptionRow[]> {
  throw new Error('TODO: implement db/subscriptions.listByUser');
}

export async function upsertFromStripe(_tx: TransactionSql, _input: Partial<SubscriptionRow>): Promise<SubscriptionRow> {
  throw new Error('TODO: implement db/subscriptions.upsertFromStripe');
}

export async function setStatus(_sql: Sql, _stripeId: string, _status: SubscriptionStatus): Promise<void> {
  throw new Error('TODO: implement db/subscriptions.setStatus');
}
