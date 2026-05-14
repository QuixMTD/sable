// Per-request correlation ID. Honours an incoming `x-request-id` header if
// a client provides one (useful for trace propagation across services),
// otherwise generates a fresh UUID.

import { randomUUID } from 'node:crypto';

import type { HttpRequest, HttpResponse, NextFunction } from './types.js';

export function requestId(req: HttpRequest, res: HttpResponse, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
