// /usage router — internal, HMAC-signed service-to-service.
//
//   POST /usage              one minute report
//   POST /usage/batch        up to 2,000 minute reports in one call
//
// serviceAuth verifies the X-Service-* headers; only services holding
// an active HMAC key version (loaded from gateway.hmac_key_versions)
// can write. No user-cookie auth — this is the back-channel from
// module services to the certification ledger.

import { Router } from 'express';
import { serviceAuth } from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as ctrl from '../controllers/usage.js';

export function buildUsageRouter(config: AppConfig): Router {
  const r = Router();

  r.use(
    serviceAuth({
      redis: config.redis,
      hmacKeys: config.hmacKeys(),
      currentVersion: config.currentHmacVersion(),
      actor: 'gateway',
    }),
  );

  r.post('/', ctrl.recordOne(config));
  r.post('/batch', ctrl.recordBatch(config));

  return r;
}
