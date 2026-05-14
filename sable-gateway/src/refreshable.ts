// Version-stamp-driven hot reload for boot-loaded config tables.
//
// Pattern: each cached value (service_routes, hmac_key_versions, etc.)
// has a corresponding "version" key in Redis. Admin writes bump that
// key. Each gateway instance polls the version on a timer; when its
// known version differs, it reloads the table from Postgres.
//
// This is cheap (one GET per poll per cached value) and naturally
// thunders-on-write: every instance reloads roughly together right
// after an admin write, then quiesces.

import type { RedisClient } from 'sable-shared';

export class Refreshable<T> {
  private value: T;
  private version: string | null = null;
  private readonly versionKey: string;
  private readonly loader: () => Promise<T>;
  private readonly onUpdate: ((value: T) => void) | undefined;

  constructor(
    initial: T,
    versionKey: string,
    loader: () => Promise<T>,
    onUpdate?: (value: T) => void,
  ) {
    this.value = initial;
    this.versionKey = versionKey;
    this.loader = loader;
    this.onUpdate = onUpdate;
  }

  current(): T {
    return this.value;
  }

  /**
   * Reads the version key; reloads + swaps in the new value only if the
   * stamp has changed since the last check.
   */
  async refreshIfStale(redis: RedisClient): Promise<boolean> {
    const stamp = await redis.get(this.versionKey);
    if (stamp === this.version) return false;
    this.value = await this.loader();
    this.version = stamp;
    this.onUpdate?.(this.value);
    return true;
  }
}

/**
 * Loop-facing handle — narrow interface so heterogeneous Refreshable<T>s
 * (HMAC keys, route map, CORS list) can share one array without the
 * generic parameter leaking and forcing variance gymnastics.
 */
export interface RefreshableHandle {
  refreshIfStale(redis: RedisClient): Promise<boolean>;
}

export interface RefreshLoopConfig {
  redis: RedisClient;
  intervalMs: number;
  entries: ReadonlyArray<RefreshableHandle>;
  onError?: (err: unknown, versionKey: string) => void;
}

/**
 * Starts a periodic poll. Returns the timer handle so the caller can
 * stop it on shutdown.
 */
export function startRefreshLoop(config: RefreshLoopConfig): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    for (const entry of config.entries) {
      try {
        await entry.refreshIfStale(config.redis);
      } catch (err) {
        config.onError?.(err, '');
      }
    }
  };
  // Fire once immediately so the first poll doesn't wait for the
  // interval — useful if a deploy lines up with an admin write.
  void tick();
  return setInterval(() => void tick(), config.intervalMs);
}
