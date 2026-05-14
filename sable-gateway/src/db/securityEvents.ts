// gateway.security_events — auth failures, replay attacks, bot-detection
// hits, etc. Append-only and partitioned by created_at month.

import { withRequestContext, type Sql } from 'sable-shared';

export interface SecurityEventInput {
  eventType: string;
  userId?: string;
  orgId?: string;
  ipAddress?: string;
  details?: Record<string, unknown>;
}

export async function append(sql: Sql, input: SecurityEventInput): Promise<void> {
  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await tx`
      INSERT INTO gateway.security_events
        (event_type, user_id, org_id, ip_address, details)
      VALUES
        (${input.eventType},
         ${input.userId ?? null},
         ${input.orgId ?? null},
         ${input.ipAddress ?? null},
         ${JSON.stringify(input.details ?? {})}::jsonb)
    `;
  });
}
