// /verify router — fully public, no auth, no session, no cookies. This
// is the surface that powers verify.sableterminal.com.
//
//   GET /verify/:publicId        certificate + cryptographic proof
//   GET /verify/.well-known/key  active platform public key (for
//                                 third-party independent verification)
//
// Per-IP rate-limited so a verifier can't be used as an oracle to
// enumerate certificates.

import { Router } from 'express';
import { rateLimitByIp } from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/verify.js';

export function buildVerifyRouter(config: AppConfig): Router {
  const r = Router();
  r.use(rateLimitByIp({ redis: config.redis, limit: 120, window: 'minute' }));

  r.get('/.well-known/key', ctrl.publicKey(config));
  r.get('/:publicId', ctrl.verify(config));

  return r;
}
