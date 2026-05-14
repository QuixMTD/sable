// gateway.birthday_gifts — partitioned by year. Triggered by scheduled
// cron when a user's DOB matches today's date.

import type { Sql, TransactionSql } from 'sable-shared';

export interface BirthdayGiftRow {
  id: string;
  user_id: string;
  gift_kind: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at: Date | null;
  created_at: Date;
}

export async function findForUserAndYear(_sql: Sql, _userId: string, _year: number): Promise<BirthdayGiftRow | null> {
  throw new Error('TODO: implement db/birthdayGifts.findForUserAndYear');
}

export async function create(_tx: TransactionSql, _userId: string, _kind: string): Promise<BirthdayGiftRow> {
  throw new Error('TODO: implement db/birthdayGifts.create');
}
