// UUID shape validation. Accepts any UUID version (the schema uses Postgres's
// `uuid` type, which doesn't enforce a version, and external IDs we may
// receive from Stripe / Clerk / IBKR aren't always v4 either).
//
// Validate at trust boundaries (request bodies, URL params, webhook payloads),
// not in internal call chains.

import { AppError } from '../errors/AppError.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Type guard — narrows `unknown` to `string` when the value is UUID-shaped.
 * Rejects the all-zero NIL UUID; legitimate IDs are produced by
 * `gen_random_uuid()` and never collide with that pattern.
 */
export function isUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value) && value !== NIL_UUID;
}

/**
 * Assertion that throws `AppError('INVALID_UUID')` on a non-UUID value. After
 * this call returns, TypeScript narrows the value to `string`. The `field`
 * lands in `error.details.field`.
 */
export function assertUUID(value: unknown, field = 'value'): asserts value is string {
  if (!isUUID(value)) {
    throw new AppError('INVALID_UUID', {
      message: `${field} is not a valid UUID`,
      details: { field },
    });
  }
}
