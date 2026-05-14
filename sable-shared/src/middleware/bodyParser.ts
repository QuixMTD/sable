// JSON + urlencoded body parsing. 1MB cap on JSON bodies — large payloads
// should go via signed-URL upload to GCS, not through the gateway.
//
// We retain the raw body on req.rawBody (declared on SableRequest) for
// routes that need to verify byte-exact HMAC signatures: Stripe webhooks
// and internal service-auth.
//
// `express` is an optional peer dep of sable-shared — services that compose
// this middleware must have express installed.

import express, { type Request } from 'express';

export interface BodyParserConfig {
  /** Hard limit on body size. Defaults to '1mb'. */
  limit?: string;
}

export function jsonBodyParser(config: BodyParserConfig = {}) {
  return express.json({
    limit: config.limit ?? '1mb',
    verify: (req: Request, _res, buf) => {
      // Signature-verifying middleware (Stripe, service-auth) reads this
      // before any handler runs.
      req.rawBody = buf;
    },
  });
}

export function urlencodedBodyParser(config: BodyParserConfig = {}) {
  return express.urlencoded({
    extended: false,
    limit: config.limit ?? '1mb',
  });
}
