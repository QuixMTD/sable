// Stripe SDK init. Stub until the billing flow lands — install the
// `stripe` npm package and wire `new Stripe(...)` here when billing
// controllers go live (see services/billing.ts).

import { AppError, requireEnv } from 'sable-shared';

/**
 * Returns the cached Stripe client. Throws while the billing flow is
 * unimplemented to surface the placeholder loudly if a controller
 * accidentally calls it.
 */
export function getStripe(): never {
  // Read the secret eagerly so a missing key fails at first-call instead
  // of mid-handler.
  void requireEnv('STRIPE_SECRET_KEY');
  throw new AppError('INTERNAL_ERROR', {
    message: 'Stripe is not wired yet — install `stripe` and complete config/stripe.ts',
  });
}
