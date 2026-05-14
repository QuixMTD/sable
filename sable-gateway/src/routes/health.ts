// Liveness (/healthz) and readiness (/readyz) probes.
//
//   /healthz  → 200 OK if the process is alive (does no I/O).
//   /readyz   → 200 OK iff Postgres + Redis both respond inside the
//                timeout, else 503. Used by Cloud Run to gate traffic
//                onto a new revision and by load balancers.
//
// Both endpoints are exempt from the rest of the auth chain — they're
// public on purpose.

import { Router } from 'express';

import type { AppConfig } from '../app.js';
import { healthz, readyz } from '../controllers/health.js';

export function buildHealthRouter(config: AppConfig): Router {
  const r = Router();
  r.get('/healthz', healthz);
  r.get('/readyz', readyz(config));
  return r;
}
