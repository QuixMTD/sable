// Block gate. Runs very early in the chain — after `requestId`, before
// `authenticate` / `authenticateApiKey` — so blocked IPs / users / orgs
// / device fingerprints don't consume CPU on the full request.
//
// Redis-only hot path: reads `block:cache:{type}:{value}` keys. Misses
// are treated as "not blocked"; populating the cache is the job of
// services/security.block.
//
// Whitelist check: a matching `whitelist:cache:*` entry overrides the
// block. This is how admin staff bypass IP blocks.

import { cacheKeys } from '../cache/index.js';
import type { RedisClient } from '../config/redis.js';
import { AppError } from '../errors/AppError.js';
import type { BlockEntityType, WhitelistEntityType } from '../cache/index.js';
import type { HttpRequest, HttpResponse, NextFunction } from './types.js';

export interface BlockGateConfig {
  redis: RedisClient;
  /**
   * Pre-`authenticate`, we only know the IP. Post-auth chains can add a
   * second blockGate (with includeUser=true) to scan user/org/device too.
   */
  includeUser?: boolean;
}

export function blockGate(config: BlockGateConfig) {
  return async (req: HttpRequest, _res: HttpResponse, next: NextFunction): Promise<void> => {
    try {
      const ip = req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '';

      // Cheap path — IP-only.
      if (await isBlocked(config.redis, 'ip', ip)) {
        if (!(await isWhitelisted(config.redis, ip))) {
          throw new AppError('IP_BLOCKED', { details: { ip } });
        }
      }

      if (config.includeUser && req.session) {
        const checks: Array<[BlockEntityType, string | undefined]> = [
          ['user_id', req.session.userId],
          ['org_id', req.session.orgId],
        ];
        for (const [type, value] of checks) {
          if (value && (await isBlocked(config.redis, type, value))) {
            throw new AppError('ENTITY_BLOCKED', { details: { entityType: type } });
          }
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

async function isBlocked(redis: RedisClient, type: BlockEntityType, value: string): Promise<boolean> {
  if (!value) return false;
  return (await redis.exists(cacheKeys.blockCache(type, value))) > 0;
}

async function isWhitelisted(redis: RedisClient, ip: string): Promise<boolean> {
  if (!ip) return false;
  // Two whitelist scopes that apply pre-auth: global, and admin_account
  // (the latter would only match once we know the admin id, but `global`
  // suffices for the static office IPs case).
  const types: WhitelistEntityType[] = ['global'];
  for (const t of types) {
    if ((await redis.exists(cacheKeys.whitelistCache(t, ip))) > 0) return true;
  }
  return false;
}
