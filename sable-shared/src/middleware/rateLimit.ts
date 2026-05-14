// Fixed-window rate limiter. Uses the Lua INCR + EXPIRE-on-first-write
// primitive (`incrWithTtl`) so each check is one round-trip and the
// window doesn't slide.
//
// Three independent shape factories — pick the one that matches the
// request's natural identity:
//
//   rateLimitByIp   — for unauthenticated routes (login, signup, public)
//   rateLimitByUser — for authenticated routes (post-`authenticate`)
//   rateLimitByOrg  — for org-level fairness on multi-seat firms
//
// On exhaustion they throw RATE_LIMIT_EXCEEDED with the retry hint in
// details.retryAfterSeconds; the error handler renders 429.

import { cacheKeys, incrWithTtl, type RateWindow, TTL } from '../cache/index.js';
import type { RedisClient } from '../config/redis.js';
import { AppError } from '../errors/AppError.js';
import type { HttpRequest, HttpResponse, NextFunction } from './types.js';

const WINDOW_TTL: Record<RateWindow, number> = {
  minute: TTL.RATE_USER_MINUTE,
  hour: TTL.RATE_USER_HOUR,
  day: TTL.RATE_USER_DAY,
};

export interface RateLimitOptions {
  redis: RedisClient;
  limit: number;
  window: RateWindow;
}

// ---------------------------------------------------------------------------

export function rateLimitByIp(options: RateLimitOptions) {
  return async (req: HttpRequest, _res: HttpResponse, next: NextFunction): Promise<void> => {
    try {
      const ip = req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (!ip) return next();      // fail-open when behind a misconfigured proxy
      await enforce(options, cacheKeys.rateIp(ip));
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function rateLimitByUser(options: RateLimitOptions) {
  return async (req: HttpRequest, _res: HttpResponse, next: NextFunction): Promise<void> => {
    try {
      const userId = req.session?.userId;
      if (!userId) return next();  // must run after authenticate; harmless on public routes
      await enforce(options, cacheKeys.rateUser(userId, options.window));
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function rateLimitByOrg(options: RateLimitOptions) {
  return async (req: HttpRequest, _res: HttpResponse, next: NextFunction): Promise<void> => {
    try {
      const orgId = req.session?.orgId;
      if (!orgId) return next();   // individual seats — no org bucket
      await enforce(options, cacheKeys.rateOrg(orgId));
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------

async function enforce(options: RateLimitOptions, key: string): Promise<void> {
  const ttl = WINDOW_TTL[options.window];
  const count = await incrWithTtl(options.redis, key, ttl);
  if (count > options.limit) {
    throw new AppError('RATE_LIMIT_EXCEEDED', {
      details: { limit: options.limit, window: options.window, retryAfterSeconds: ttl },
    });
  }
}
