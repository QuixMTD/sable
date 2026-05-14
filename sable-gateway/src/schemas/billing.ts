// /billing/* schemas.

import { z } from 'sable-shared';

export const moduleCodeSchema = z.enum(['sc', 're', 'crypto', 'alt', 'tax']);

export const createCheckoutSchema = z.object({
  module: moduleCodeSchema,
  seatCount: z.number().int().min(1).max(10_000),
  billingCycle: z.enum(['monthly', 'annual']),
  successUrl: z.string().url().max(1024),
  cancelUrl: z.string().url().max(1024),
});
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;

export const portalSchema = z.object({
  returnUrl: z.string().url().max(1024),
});

export const cancelSubscriptionSchema = z.object({
  subscriptionId: z.string().min(1).max(255),
});
