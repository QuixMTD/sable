// Password hashing — Argon2id, not bcrypt or pgcrypto's crypt().
// The schema's `users.password_hash TEXT` stores the encoded Argon2 string.
//
// SHA-256 / HMAC-SHA-256 / constant-time compare / emailLookup live in
// the sibling `hash.ts` — different use cases, different algorithms.
//
// `argon2` is an optional peer dep of sable-shared.

import argon2 from 'argon2';

// Argon2id parameters tuned for ~50ms on a Cloud Run instance — bump
// timeCost if hardware speeds up. memoryCost in KiB.
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

export async function verifyPassword(hashed: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hashed, plaintext);
  } catch {
    // Malformed hash on the row — treat as a non-match rather than crashing
    // the auth flow. The malformed hash itself is the bug to fix.
    return false;
  }
}

/**
 * Argon2's verify() does not auto-rehash with newer parameters. Call this
 * after a successful login to decide whether to upgrade the stored hash.
 */
export function needsRehash(hashed: string): boolean {
  return argon2.needsRehash(hashed, ARGON2_OPTIONS);
}
