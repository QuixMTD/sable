// gateway.bot_scores — sticky bot suspicion score per user/IP. Updated
// by the bot-detection middleware; high scores trigger manual review or
// auto-block via blocked_entities.

import type { Sql, TransactionSql } from 'sable-shared';

export interface BotScoreRow {
  id: string;
  subject_type: 'user_id' | 'ip';
  subject_value: string;
  score: number;
  reasons: string[];
  updated_at: Date;
  created_at: Date;
}

export async function getCurrent(_sql: Sql, _type: 'user_id' | 'ip', _value: string): Promise<BotScoreRow | null> {
  throw new Error('TODO: implement db/botScores.getCurrent');
}

export async function bump(_tx: TransactionSql, _type: 'user_id' | 'ip', _value: string, _delta: number, _reason: string): Promise<void> {
  throw new Error('TODO: implement db/botScores.bump');
}
