// Webhook event dispatcher — verifies the inbound signature, looks up
// the handler for the event type, runs it, mirrors the event to
// gateway.webhook_logs.
//
// Stripe events handled (initial set):
//   customer.subscription.created   → upsert subscription + recompute entitlement
//   customer.subscription.updated   → upsert + recompute
//   customer.subscription.deleted   → mark cancelled + recompute
//   invoice.paid                    → mark active + insert invoice row
//   invoice.payment_failed          → mark past_due + email user
//   customer.subscription.trial_will_end → email user

import { AppError, type RedisClient, type Sql } from 'sable-shared';

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Verify the Stripe-Signature header against the rawBody. Throws on
 * mismatch. Returns the parsed event.
 */
export function verifyStripeSignature(_rawBody: Buffer, _signatureHeader: string): StripeEventLike {
  throw new AppError('INTERNAL_ERROR', { message: 'webhooks.verifyStripeSignature not implemented' });
}

export async function dispatchStripe(_sql: Sql, _redis: RedisClient, _event: StripeEventLike): Promise<void> {
  throw new AppError('INTERNAL_ERROR', { message: 'webhooks.dispatchStripe not implemented' });
}
