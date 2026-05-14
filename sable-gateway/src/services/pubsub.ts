// Cross-service async events via GCP Pub/Sub. Per the architecture doc:
//   price.updated          (sable-sc / sable-crypto → all subscribers)
//   holdings.imported      (sable-sc / sable-re / sable-crypto / sable-alt)
//   portfolio.updated      (any module)
//   tax.recalculate        (sable-core → sable-tax / QuixMTD)
//   report.generate        (sable-core → consumers)
//   certification.trigger  (gateway → sable-institute, Stage 2)
//   entitlement.changed    (gateway after Stripe webhook → all subscribers)
//
// Stubbed until the @google-cloud/pubsub dep lands. The publish surface
// is a thin wrapper around topic.publishMessage with structured payloads.

import { AppError } from 'sable-shared';

export type EventTopic =
  | 'price.updated'
  | 'holdings.imported'
  | 'portfolio.updated'
  | 'tax.recalculate'
  | 'report.generate'
  | 'certification.trigger'
  | 'entitlement.changed';

export interface PublishOptions {
  /** Best-effort ordering key — same key publishes in order, different keys may interleave. */
  orderingKey?: string;
  /** Idempotency key — if the publisher retries, the same payload+key is a no-op. */
  idempotencyKey?: string;
}

export async function publish<T extends Record<string, unknown>>(_topic: EventTopic, _payload: T, _options: PublishOptions = {}): Promise<{ messageId: string }> {
  throw new AppError('INTERNAL_ERROR', { message: 'pubsub.publish not implemented' });
}
