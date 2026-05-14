// gateway.email_logs — outbound transactional email delivery records
// (verification, password reset, invoice receipt, etc.). Partitioned
// monthly.

import type { TransactionSql } from 'sable-shared';

export interface EmailLogRow {
  id: string;
  to_user_id: string | null;
  template: string;
  to_email_hash: Buffer;       // #️⃣ — don't store raw recipient on the log row
  provider: string;            // 'ses', 'sendgrid', ...
  provider_message_id: string | null;
  status: 'sent' | 'failed' | 'bounced';
  error: string | null;
  created_at: Date;
}

export async function append(_tx: TransactionSql, _input: Partial<EmailLogRow>): Promise<void> {
  throw new Error('TODO: implement db/emailLogs.append');
}
