// gateway.webhook_logs — every inbound webhook (Stripe, etc.) with the
// verification result and the dispatch outcome. Partitioned monthly.

import type { TransactionSql } from 'sable-shared';

export interface WebhookLogRow {
  id: string;
  source: string;                 // 'stripe', 'twilio', ...
  external_event_id: string;
  event_type: string;
  signature_ok: boolean;
  dispatched: boolean;
  error: string | null;
  payload_hash: Buffer | null;    // #️⃣
  created_at: Date;
}

export async function append(_tx: TransactionSql, _input: Partial<WebhookLogRow>): Promise<void> {
  throw new Error('TODO: implement db/webhookLogs.append');
}
