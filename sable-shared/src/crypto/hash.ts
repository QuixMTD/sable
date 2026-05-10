// App-layer hashing — Node's `crypto` module wrapped for ergonomics.
//
// DB-layer hashing (token lookups, email_lookup) happens via the `digest()`
// SQL function inside the schema. App-layer hashing here is for cases where
// the Node service must compute the same hash *before* the query — e.g. the
// gateway computes `email_lookup = sha256(lower(email))` to look up a user at
// login, hashes a session token before INSERT, or verifies a webhook
// signature.
//
// Outputs are Buffers by default — matches the schema's BYTEA columns and
// avoids hex/base64 round-trips when writing to the DB.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

/** SHA-256 → Buffer (32 bytes). Matches BYTEA columns directly. */
export function sha256(input: string | Buffer | Uint8Array): Buffer {
  return createHash('sha256').update(input).digest();
}

/** SHA-256 → hex string. Use for logs / URL params; for DB writes use `sha256()`. */
export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// HMAC-SHA-256 — service-to-service request signing, Stripe webhook verify
// ---------------------------------------------------------------------------

export function hmacSha256(key: string | Buffer, input: string | Buffer): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

export function hmacSha256Hex(key: string | Buffer, input: string | Buffer): string {
  return createHmac('sha256', key).update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Constant-time equality check for hashes / HMACs / tokens. Required for any
 * comparison that an attacker might be able to time. Length mismatch returns
 * false (not throw) — the caller usually wants a boolean either way.
 */
export function constantTimeEqual(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // timingSafeEqual requires same length (we already checked) and matching
  // ArrayBufferView types. Buffer.from with no copy when input is Buffer.
  const aBuf = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bBuf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/**
 * Compute the email lookup hash. MUST match the schema's expression — both
 * sides do `trim` + `lower` + sha256 so a user pasting their email with
 * trailing whitespace doesn't silently fail login.
 *
 * Schema-side equivalent: `digest(lower(btrim($1)), 'sha256')`.
 * Change one, change both.
 */
export function emailLookup(email: string): Buffer {
  return sha256(email.trim().toLowerCase());
}
