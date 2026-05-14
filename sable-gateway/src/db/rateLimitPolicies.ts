// gateway.rate_limit_policies — per-route / per-tier rate limit
// definitions. Loaded on boot or via cache:route:cache key.

import type { Sql } from 'sable-shared';

export interface RateLimitPolicyRow {
  id: string;
  scope: 'user' | 'org' | 'ip';
  window: 'minute' | 'hour' | 'day';
  limit: number;
  applies_to_role: string | null;
  is_active: boolean;
  created_at: Date;
}

export async function listActive(_sql: Sql): Promise<RateLimitPolicyRow[]> {
  throw new Error('TODO: implement db/rateLimitPolicies.listActive');
}
