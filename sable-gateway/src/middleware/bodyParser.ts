// JSON + urlencoded body parsing. 1MB cap on JSON bodies — large payloads
// should go via signed-URL upload to GCS, not through the gateway.
//
// We retain the raw body on req.rawBody for routes that need to verify
// HMAC signatures (Stripe webhooks, internal service auth).

import express, { type Request } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export const jsonBodyParser = express.json({
  limit: '1mb',
  verify: (req: Request, _res, buf) => {
    // Stripe and our HMAC service-auth need the byte-exact request body to
    // verify signatures. Keep a reference so the middleware can read it.
    req.rawBody = buf;
  },
});

export const urlencodedBodyParser = express.urlencoded({
  extended: false,
  limit: '1mb',
});
