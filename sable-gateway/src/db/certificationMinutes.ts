// gateway.certification_minutes — append-only minute-bucketed usage log.
// Each module (sable-sc, sable-re, ...) publishes a Pub/Sub event per
// active minute of use; the gateway's /usage handler resolves to an
// INSERT here. UNIQUE (user_id, module, minute_bucket) keeps retries
// idempotent.

import { withRequestContext, type ModuleCode, type Sql, type TransactionSql } from 'sable-shared';

export type MinuteModule = ModuleCode | 'core';

export interface MinuteRow {
  id: string;
  user_id: string;
  module: MinuteModule;
  minute_bucket: Date;
  source_service: string;
  created_at: Date;
}

export interface RecordMinuteInput {
  userId: string;
  module: MinuteModule;
  minuteBucket: Date;
  sourceService: string;
}

export async function record(tx: TransactionSql, input: RecordMinuteInput): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.certification_minutes (user_id, module, minute_bucket, source_service)
    VALUES (${input.userId}, ${input.module}, ${input.minuteBucket}, ${input.sourceService})
    ON CONFLICT (user_id, module, minute_bucket) DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

export interface HoursTotals {
  total_hours: number;
  by_module: Record<string, number>;
}

export async function totalsForUser(sql: Sql, userId: string): Promise<HoursTotals> {
  // 1 minute_bucket row == 1 minute of activity, so hours = count / 60.
  const rows = await withRequestContext(sql, { actor: 'user', userId }, async (tx) =>
    tx<{ module: MinuteModule; minutes: string }[]>`
      SELECT module, COUNT(*)::text AS minutes
      FROM gateway.certification_minutes
      WHERE user_id = ${userId}
      GROUP BY module
    `,
  );
  const byModule: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const hours = Number(r.minutes) / 60;
    byModule[r.module] = hours;
    total += hours;
  }
  return { total_hours: total, by_module: byModule };
}
