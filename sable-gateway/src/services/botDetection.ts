// Bot detection — accumulates per-user / per-IP suspicion based on:
//   - inter-request gap < 50ms                       (bot:requests:{user}:50ms)
//   - perfectly regular cadence over a 5-min window  (bot:pattern:{ip}:regularity)
//   - lack of mouse / keyboard interaction telemetry (bot:mouse:{user})
//   - VM / headless device fingerprint signatures
//
// Score crossing the threshold writes to gateway.blocked_entities and
// emits a security_event of type 'bot_detected'.

import { AppError, type RedisClient, type Sql } from 'sable-shared';

export interface RequestSignal {
  userId: string | null;
  ip: string;
  ts: number;
  mouseEvents?: number;
}

export async function record(_redis: RedisClient, _signal: RequestSignal): Promise<void> {
  throw new AppError('INTERNAL_ERROR', { message: 'botDetection.record not implemented' });
}

export async function reviewScore(_sql: Sql, _redis: RedisClient, _subject: 'user_id' | 'ip', _value: string): Promise<number> {
  throw new AppError('INTERNAL_ERROR', { message: 'botDetection.reviewScore not implemented' });
}
