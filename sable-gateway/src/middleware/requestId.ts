// Per-request correlation ID. Honours an incoming `x-request-id` header if
// a client provides one (useful for trace propagation across services),
// otherwise generates a fresh UUID.

import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
