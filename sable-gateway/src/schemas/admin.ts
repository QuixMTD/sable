// /admin/* schemas — gated by admin auth in the controller.

import { z } from 'sable-shared';

export const rotateHmacKeySchema = z.object({
  newVersion: z.number().int().min(1).max(10_000),
  keyRef: z.string().min(1).max(255),
  deprecatePrevious: z.boolean(),
});

export const blockEntitySchema = z.object({
  entityType: z.enum(['ip', 'user_id', 'org_id', 'device_fingerprint']),
  entityValue: z.string().min(1).max(255),
  reason: z.string().min(1).max(500),
  expiresAt: z.string().datetime().optional(),
});

export const unblockEntitySchema = z.object({
  entityType: z.enum(['ip', 'user_id', 'org_id', 'device_fingerprint']),
  entityValue: z.string().min(1).max(255),
});

export const setConfigSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.unknown(),
});

export const forceRevokeSessionSchema = z.object({
  sessionId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});
