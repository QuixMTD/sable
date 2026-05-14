// gateway.email_logs — outbound transactional email delivery records.
// Partitioned monthly by sent_at. Slim schema: no PII (no recipient email
// or hash stored — that's an audit-by-template + user_id table).

import { withRequestContext, type Sql } from 'sable-shared';

export type EmailStatus = 'sent' | 'delivered' | 'bounced' | 'failed';

export interface EmailLogInput {
  userId: string | null;
  template: string;
  providerId: string | null;
  status: EmailStatus;
}

export async function append(sql: Sql, input: EmailLogInput): Promise<void> {
  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await tx`
      INSERT INTO gateway.email_logs (user_id, template, provider_id, status)
      VALUES (${input.userId}, ${input.template}, ${input.providerId}, ${input.status})
    `;
  });
}
