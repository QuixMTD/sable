// gzip / deflate response compression. The threshold of 1KB skips
// compression on tiny responses where the framing overhead exceeds the
// payload savings.
//
// `compression` is an optional peer dep of sable-shared.

import compression from 'compression';

export interface CompressionConfig {
  /** Minimum response size (bytes) before compressing. Defaults to 1024. */
  threshold?: number;
  /** gzip level 0-9. Defaults to 6. */
  level?: number;
}

export function compressionMiddleware(config: CompressionConfig = {}) {
  return compression({
    threshold: config.threshold ?? 1024,
    level: config.level ?? 6,
  });
}
