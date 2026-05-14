// Bot detection — accumulates per-user / per-IP suspicion based on:
//   - inter-request gap < 50ms                       (bot:requests:{user}:50ms)
//   - very high request rate per minute              (handled via rate-limit counters)
//   - lack of mouse / keyboard interaction telemetry (bot:mouse:{user})
//
// Hot path is Redis (1-3 ops per recorded request). Score updates land
// in gateway.bot_scores asynchronously. Crossing AUTO_BLOCK_THRESHOLD
// writes to gateway.blocked_entities (via services/security.block) and
// emits a security_event of type 'bot_detected'.

import type { RequestHandler } from 'express';
import {
  cacheKeys,
  incrWithTtl,
  TTL,
  type RedisClient,
  type Sql,
} from 'sable-shared';

import * as botScoresDb from '../db/botScores.js';
import * as security from './security.js';

const FAST_REQUEST_THRESHOLD_MS = 50;
const FAST_REQUEST_BUMP = 5;
const NO_MOUSE_BUMP = 2;
const AUTO_BLOCK_THRESHOLD = 80;

export interface RequestSignal {
  /** null for unauthenticated requests — we still track per-IP. */
  userId: string | null;
  ip: string;
  /** Caller-supplied epoch ms; defaults to Date.now(). */
  ts?: number;
  /** Optional client telemetry — mouse events seen since the last request. */
  mouseEvents?: number;
}

/**
 * Record a single request signal. Cheap (1-3 Redis ops); writes to
 * bot_scores asynchronously and only blocks when the score crosses
 * AUTO_BLOCK_THRESHOLD.
 *
 * Subject is keyed on userId when present, otherwise IP — bots tend to
 * spray across many IPs but stay on one stolen credential, or vice versa.
 */
export async function record(sql: Sql, redis: RedisClient, signal: RequestSignal): Promise<void> {
  const ts = signal.ts ?? Date.now();
  const subjectType = signal.userId !== null ? 'user_id' : 'ip';
  const subjectValue = signal.userId ?? signal.ip;

  let totalBump = 0;
  const reasons: string[] = [];

  // 1. Inter-request gap. last-seen ts kept in Redis (TTL = 1 min). A
  //    diff under 50ms increments a counter; sustained fast gaps bump.
  const lastKey = `bot:last_ts:${subjectType}:${subjectValue}`;
  const lastRaw = await redis.get(lastKey);
  await redis.set(lastKey, String(ts), 'EX', 60);
  if (lastRaw !== null) {
    const gap = ts - Number.parseInt(lastRaw, 10);
    if (gap >= 0 && gap < FAST_REQUEST_THRESHOLD_MS && signal.userId !== null) {
      const count = await incrWithTtl(redis, cacheKeys.botRequests50ms(signal.userId), TTL.BOT_REQUESTS_50MS);
      if (count === 3 || count === 10) {
        totalBump += FAST_REQUEST_BUMP;
        reasons.push('sub_50ms_gaps');
      }
    }
  }

  // 2. Mouse / keyboard telemetry — only meaningful for authenticated
  //    users on the web client. If we've never observed mouse activity
  //    for a user, bump the score.
  if (signal.userId !== null) {
    const mouseKey = cacheKeys.botMouse(signal.userId);
    if ((signal.mouseEvents ?? 0) > 0) {
      await redis.set(mouseKey, String(ts), 'EX', TTL.BOT_MOUSE);
    } else {
      const lastMouse = await redis.get(mouseKey);
      if (lastMouse === null) {
        totalBump += NO_MOUSE_BUMP;
        reasons.push('no_mouse_telemetry');
      }
    }
  }

  if (totalBump === 0) return;

  // Fire-and-log the score bump so the request path stays fast.
  void (async () => {
    try {
      const newScore = await botScoresDb.bump(sql, subjectType, subjectValue, totalBump, reasons.join(','));
      if (newScore >= AUTO_BLOCK_THRESHOLD) {
        await security.block(sql, redis, {
          entityType: subjectType,
          entityValue: subjectValue,
          reason: `auto_blocked: bot_score ${newScore} (${reasons.join(', ')})`,
          blockedBy: null,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        await security.emitEvent(sql, 'bot_detected', {
          userId: signal.userId ?? undefined,
          ipAddress: signal.ip,
          score: newScore,
          reasons,
        });
      }
    } catch {
      // Bot-detection failures must never break the request path.
    }
  })();
}

export async function reviewScore(sql: Sql, type: botScoresDb.BotSubjectType, value: string): Promise<number> {
  const row = await botScoresDb.getCurrent(sql, type, value);
  return row?.score ?? 0;
}

// ---------------------------------------------------------------------------
// Middleware factory. Mount after `authenticate` so we know userId where
// present. Fire-and-forget — never blocks the request, never throws.
// ---------------------------------------------------------------------------

export interface BotSignalConfig {
  sql: Sql;
  redis: RedisClient;
}

export function botSignal(config: BotSignalConfig): RequestHandler {
  return (req, _res, next) => {
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()) || req.ip || '';
    const mouseHeader = req.header('x-mouse-events');
    const mouseEvents = mouseHeader !== undefined ? Number.parseInt(mouseHeader, 10) : undefined;
    void record(config.sql, config.redis, {
      userId: req.session?.userId ?? null,
      ip,
      mouseEvents: Number.isFinite(mouseEvents) ? mouseEvents : undefined,
    });
    next();
  };
}
