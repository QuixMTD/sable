// Hours ingest. Module services (sable-sc, sable-re, ...) publish one
// `certification.trigger` event per active minute of use; the gateway
// receives them via /usage and writes a row to
// gateway.certification_minutes. UNIQUE (user_id, module, minute_bucket)
// keeps retries idempotent.
//
// Inbound is HMAC-signed via `serviceAuth` middleware, so the source
// service identity is verified before the write.

import { AppError, withRequestContext, type Sql } from 'sable-shared';

import * as minutesDb from '../db/certificationMinutes.js';

export interface RecordUsageInput {
  userId: string;
  module: minutesDb.MinuteModule;
  /** ISO-8601 timestamp; we round down to the minute on insert. */
  timestamp: string;
  sourceService: string;
}

export async function recordOne(sql: Sql, input: RecordUsageInput): Promise<{ inserted: boolean }> {
  const ts = new Date(input.timestamp);
  if (Number.isNaN(ts.getTime())) {
    throw new AppError('VALIDATION_FAILED', { message: 'Invalid timestamp' });
  }
  // Floor to the minute so concurrent reports of the same minute
  // collapse to one row via the UNIQUE constraint.
  const minuteBucket = new Date(Math.floor(ts.getTime() / 60_000) * 60_000);

  const inserted = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    minutesDb.record(tx, {
      userId: input.userId,
      module: input.module,
      minuteBucket,
      sourceService: input.sourceService,
    }),
  );
  return { inserted };
}

export interface BatchRecord {
  userId: string;
  module: minutesDb.MinuteModule;
  timestamp: string;
}

export async function recordBatch(sql: Sql, sourceService: string, items: BatchRecord[]): Promise<{ inserted: number }> {
  let inserted = 0;
  // Single transaction so all rows commit or none — the UNIQUE
  // constraint takes care of replay safety.
  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    for (const item of items) {
      const ts = new Date(item.timestamp);
      if (Number.isNaN(ts.getTime())) continue;
      const minuteBucket = new Date(Math.floor(ts.getTime() / 60_000) * 60_000);
      const ok = await minutesDb.record(tx, {
        userId: item.userId,
        module: item.module,
        minuteBucket,
        sourceService,
      });
      if (ok) inserted += 1;
    }
  });
  return { inserted };
}
