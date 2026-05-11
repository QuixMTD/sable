// gzip / deflate response compression. The threshold of 1KB skips
// compression on tiny responses where the framing overhead exceeds the
// payload savings.

import compression from 'compression';

export const compressionMiddleware = compression({
  threshold: 1024,
  level: 6,
});
