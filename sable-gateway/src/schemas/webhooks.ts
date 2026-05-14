// /webhooks/* — payloads are validated by the source-specific signature
// (Stripe-Signature, etc.); no per-event Zod schema here. The dispatcher
// in services/webhooks.ts narrows by event.type and handles each shape.
//
// This file is left as a placeholder so the schemas/ tree is symmetric
// with controllers/ and so future webhook sources (Twilio, intercom)
// can add their own schemas alongside.

export {};
