// Global type augmentation — teaches Express's `Request` type about the
// fields Sable middleware attaches (requestId, session, context, rawBody).
// Loaded as a side-effect import from the middleware barrel so every
// consumer of sable-shared picks it up automatically; no per-service
// `express.d.ts` needed.
//
// Requires the consumer to have `@types/express` installed (every Sable
// Node service does).

import type { SableRequest } from './types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Request extends SableRequest {}
  }
}

export {};
