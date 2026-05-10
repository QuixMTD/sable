// Actor types — mirrors the `app.actor` RLS session variable values.
//
// The gateway sets `app.actor` per-request via `SET LOCAL` (see
// `withRequestContext` in config/database.ts). RLS policies key off this var
// to authorise inserts/updates that should only come from specific origins
// (e.g. `webhook` for Stripe-driven subscription writes, `system` for
// scheduled reconciliation, `gateway` for session writes).

export const ACTOR_TYPES = [
  'user',      // authenticated end-user request
  'gateway',   // gateway service-account writes (sessions, security_events, audit)
  'admin',     // admin console actions
  'webhook',   // Stripe / external webhook handlers
  'system',    // schedulers, cron jobs, background reconciliation
  'public',    // unauthenticated public endpoints (waitlist, enquiries)
] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export function isActorType(value: unknown): value is ActorType {
  return typeof value === 'string' && (ACTOR_TYPES as readonly string[]).includes(value);
}
