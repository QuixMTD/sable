// gateway.bot_scores — sticky suspicion score per user / IP. Updated by
// the bot-detection middleware; high scores trigger manual review or
// auto-block via blocked_entities.
//
// `entity_type` is 'user_id' or 'ip'. Each (type, value) pair has at
// most one row — bumps are UPSERTs that aggregate reasons and clamp the
// score to [0, 100].

import { withRequestContext, type Sql } from 'sable-shared';

export type BotSubjectType = 'user_id' | 'ip';

export interface BotScoreRow {
  id: string;
  entity_type: BotSubjectType;
  entity_value: string;
  score: number;
  reasons: string[];
  last_updated_at: Date;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  created_at: Date;
}

export async function getCurrent(sql: Sql, type: BotSubjectType, value: string): Promise<BotScoreRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<BotScoreRow[]>`
      SELECT * FROM gateway.bot_scores
      WHERE entity_type = ${type} AND entity_value = ${value}
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

/**
 * Idempotent bump — adds `delta` to the existing score (clamped 0-100),
 * appends `reason` to the reasons array if not already present. Returns
 * the new score.
 */
export async function bump(sql: Sql, type: BotSubjectType, value: string, delta: number, reason: string): Promise<number> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<{ score: number }[]>`
      INSERT INTO gateway.bot_scores (entity_type, entity_value, score, reasons, last_updated_at)
      VALUES (${type}, ${value}, GREATEST(0, LEAST(100, ${delta})), ARRAY[${reason}]::text[], now())
      ON CONFLICT (entity_type, entity_value) DO UPDATE
        SET score = GREATEST(0, LEAST(100, bot_scores.score + ${delta})),
            reasons = (
              CASE WHEN ${reason} = ANY(bot_scores.reasons)
                THEN bot_scores.reasons
                ELSE array_append(bot_scores.reasons, ${reason})
              END
            ),
            last_updated_at = now()
      RETURNING score
    `,
  );
  return rows[0]?.score ?? 0;
}
