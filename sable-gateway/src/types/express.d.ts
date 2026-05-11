// Augments Express's Request shape with the fields the Sable middleware chain
// attaches (requestId, session, context). The shape itself is defined in
// sable-shared's SableRequest — we only re-export it into the Express namespace.

import type { SableRequest } from 'sable-shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request extends SableRequest {}
  }
}

export {};
