// /certification/* and /usage/* request schemas.

import { z } from 'sable-shared';

export const levelCodeSchema = z.enum(['foundation', 'professional', 'advanced']);
export type LevelCodeInput = z.infer<typeof levelCodeSchema>;

export const startAttemptSchema = z.object({
  level: levelCodeSchema,
});

export const submitAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  /** Keyed by question id, value is one of 'a' | 'b' | 'c' | 'd'. */
  answers: z.record(z.string().min(1).max(8)),
});

// ---------------------------------------------------------------------------
// /usage — module → gateway minute reports
// ---------------------------------------------------------------------------

export const moduleSchema = z.enum(['sc', 're', 'crypto', 'alt', 'tax', 'core']);

export const recordUsageSchema = z.object({
  userId: z.string().uuid(),
  module: moduleSchema,
  timestamp: z.string().datetime(),
});

export const recordUsageBatchSchema = z.object({
  items: z.array(z.object({
    userId: z.string().uuid(),
    module: moduleSchema,
    timestamp: z.string().datetime(),
  })).max(2_000),
});

// ---------------------------------------------------------------------------
// /admin/universities
// ---------------------------------------------------------------------------

export const addUniversitySchema = z.object({
  name: z.string().min(2).max(150),
  country: z.string().min(2).max(80),
  emailDomain: z.string().min(3).max(120),
});
