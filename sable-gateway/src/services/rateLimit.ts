// Fixed-window rate limiter over Redis. Uses incrWithTtl (the Lua
// INCR + EXPIRE-on-first-write script shared registered) so the window
// slides correctly under concurrent traffic.
//
// Default policy:
//   per user  → 600/min, 30000/hour, 200000/day
//   per org   → 6000/min
//   per ip    → 1200/min (anonymous endpoints)
//
// Override per route via gateway.rate_limit_policies.

import { AppError, type RedisClient } from 'sable-shared';

export interface RateLimitInput {
  scope: 'user' | 'org' | 'ip';
  key: string;
  window: 'minute' | 'hour' | 'day';
  limit: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
}

export async function consume(_redis: RedisClient, _input: RateLimitInput): Promise<RateLimitResult> {
  throw new AppError('INTERNAL_ERROR', { message: 'rateLimit.consume not implemented' });
}
