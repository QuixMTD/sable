// gateway.welcome_packs — physical welcome pack dispatch tracking
// (founding customer programme).

import type { Sql, TransactionSql } from 'sable-shared';

export interface WelcomePackRow {
  id: string;
  user_id: string;
  delivery_address: Buffer;     // 🔐
  status: 'pending' | 'shipped' | 'delivered' | 'failed';
  tracking_ref: string | null;
  shipped_at: Date | null;
  created_at: Date;
}

export async function findByUser(_sql: Sql, _userId: string): Promise<WelcomePackRow | null> {
  throw new Error('TODO: implement db/welcomePacks.findByUser');
}

export async function markShipped(_tx: TransactionSql, _id: string, _trackingRef: string): Promise<void> {
  throw new Error('TODO: implement db/welcomePacks.markShipped');
}
