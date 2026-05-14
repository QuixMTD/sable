// Billing service. Reads are local to gateway.subscriptions /
// gateway.invoices (mirrored from Stripe by services/webhooks).
// Mutations that change Stripe-side state (checkout, portal, cancel)
// are stubbed until the `stripe` npm package lands.
//
// Pricing rule baked in: never discount the £999 base rate outside the
// founding-customer programme. Annual = 2 months free; price computed
// server-side from the seat count + cycle (not client-side).

import { AppError, withRequestContext, type ModuleCode, type Sql } from 'sable-shared';

import * as usersDb from '../db/users.js';

export const BASE_PRICE_GBP_MONTHLY = 999;

export interface CheckoutInput {
  userId: string;
  orgId: string | null;
  module: ModuleCode;
  seatCount: number;
  billingCycle: 'monthly' | 'annual';
  successUrl: string;
  cancelUrl: string;
}

export interface SubscriptionView {
  id: string;
  module: ModuleCode;
  status: string;
  seatCount: number;
  pricePerSeatGbp: string;
  billingCycle: 'monthly' | 'annual';
  currentPeriodEnd: Date;
  trialEndAt: Date | null;
}

export interface InvoiceView {
  id: string;
  stripeInvoiceId: string;
  amountGbp: string;
  status: string;
  invoicedAt: Date;
}

// ---------------------------------------------------------------------------

export async function listSubscriptions(sql: Sql, userId: string): Promise<SubscriptionView[]> {
  const user = await usersDb.findById(sql, userId);
  if (user === null) throw new AppError('NOT_FOUND');

  type Row = {
    id: string;
    module: ModuleCode;
    status: string;
    seat_count: number;
    price_per_seat_gbp: string;
    billing_cycle: 'monthly' | 'annual';
    current_period_end: Date;
    trial_end_at: Date | null;
  };

  const rows = await withRequestContext(sql, { actor: 'user', userId, orgId: user.org_id ?? undefined }, async (tx) =>
    tx<Row[]>`
      SELECT id, module, status, seat_count, price_per_seat_gbp,
             billing_cycle, current_period_end, trial_end_at
      FROM gateway.subscriptions
      WHERE (user_id = ${userId} OR org_id = ${user.org_id})
      ORDER BY created_at DESC
    `,
  );
  return rows.map((r) => ({
    id: r.id,
    module: r.module,
    status: r.status,
    seatCount: r.seat_count,
    pricePerSeatGbp: r.price_per_seat_gbp,
    billingCycle: r.billing_cycle,
    currentPeriodEnd: r.current_period_end,
    trialEndAt: r.trial_end_at,
  }));
}

export async function listInvoices(sql: Sql, userId: string): Promise<InvoiceView[]> {
  const user = await usersDb.findById(sql, userId);
  if (user === null) throw new AppError('NOT_FOUND');

  type Row = {
    id: string;
    stripe_invoice_id: string;
    amount_gbp: string;
    status: string;
    invoiced_at: Date;
  };
  const rows = await withRequestContext(sql, { actor: 'user', userId, orgId: user.org_id ?? undefined }, async (tx) =>
    tx<Row[]>`
      SELECT id, stripe_invoice_id, amount_gbp, status, invoiced_at
      FROM gateway.invoices
      WHERE (user_id = ${userId} OR org_id = ${user.org_id})
      ORDER BY invoiced_at DESC
      LIMIT 200
    `,
  );
  return rows.map((r) => ({
    id: r.id,
    stripeInvoiceId: r.stripe_invoice_id,
    amountGbp: r.amount_gbp,
    status: r.status,
    invoicedAt: r.invoiced_at,
  }));
}

/** Compute the per-seat price for the requested cycle. Annual = 10 months. */
export function pricePerSeatGbp(cycle: 'monthly' | 'annual'): number {
  return cycle === 'annual' ? BASE_PRICE_GBP_MONTHLY * 10 : BASE_PRICE_GBP_MONTHLY;
}

// ---------------------------------------------------------------------------
// Stripe-touching paths — stubs until config/stripe.ts is wired.
// ---------------------------------------------------------------------------

export async function createCheckoutSession(_sql: Sql, _input: CheckoutInput): Promise<{ url: string }> {
  throw new AppError('INTERNAL_ERROR', {
    message: 'billing.createCheckoutSession needs the `stripe` package — install it and complete config/stripe.ts',
  });
}

export async function createPortalSession(_sql: Sql, _userId: string, _returnUrl: string): Promise<{ url: string }> {
  throw new AppError('INTERNAL_ERROR', {
    message: 'billing.createPortalSession needs the `stripe` package — install it and complete config/stripe.ts',
  });
}

/**
 * Mark a subscription as `cancel_at_period_end` in our mirror and tell
 * Stripe to do the same. The Stripe call is stubbed; the DB-side flip
 * goes through entitlement recompute via the webhook handler when the
 * cancel actually fires.
 */
export async function cancelSubscription(sql: Sql, userId: string, subscriptionId: string): Promise<void> {
  await withRequestContext(sql, { actor: 'user', userId }, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      UPDATE gateway.subscriptions
      SET status = 'cancelled', updated_at = now()
      WHERE id = ${subscriptionId} AND (user_id = ${userId})
      RETURNING id
    `;
    if (rows.length === 0) throw new AppError('NOT_FOUND', { message: 'No subscription matched for this user' });
  });
  // TODO: also call stripe.subscriptions.update(stripeId, { cancel_at_period_end: true })
  //       once config/stripe is wired. The webhook for the eventual cancellation
  //       drives the entitlement recompute.
}
