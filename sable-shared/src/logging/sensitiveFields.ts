// Canonical list of PII / secret field names — anything matching here gets
// redacted before a log write. Source: every 🔐 or #️⃣ column in the schema,
// plus standard auth/transport headers.
//
// Matching is case-insensitive and ignores `_` / `-` so the same entry covers
// `password_hash` / `passwordHash` / `password-hash` / `PasswordHash`.

export const SENSITIVE_FIELDS = [
  // Passwords
  'password',
  'password_hash',

  // Tokens (request and storage forms)
  'token',
  'access_token',
  'refresh_token',
  'session_token',
  'session_token_hash',
  'jwt',
  'bearer',
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api_key',
  'apikey',
  'key',
  'key_hash',

  // Crypto material
  'secret',
  'totp_secret',
  'totp',
  'dek',
  'nonce',
  'private_key',

  // Direct PII
  'email',
  'email_lookup',           // SHA-256(email) is still identifying
  'phone',
  'mobile',
  'date_of_birth',
  'dob',
  'birthday',

  // Addresses
  'address',
  'street_address',
  'registered_address',
  'delivery_address',
  'postcode',
  'zip_code',

  // Financial
  'paypal_email',
  'card_number',
  'cvv',
  'cvc',
  'iban',
  'account_number',
  'sort_code',
  'routing_number',
  'stripe_secret_key',

  // Third-party creds (user_integrations etc.)
  'credentials',
  'kms_key',

  // Identifying hashes
  'token_hash',
  'fingerprint_hash',
  'device_fingerprint_hash',
] as const;

export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

/**
 * Normalise a field name for matching: lowercase, strip `_` and `-`.
 * Public so callers can reuse the same shape when adding extras at runtime.
 */
export function normaliseField(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '');
}

/** Pre-normalised set used by the redactor for O(1) lookups. */
export const SENSITIVE_FIELD_SET: ReadonlySet<string> = new Set(
  SENSITIVE_FIELDS.map(normaliseField),
);

/** Convenience check — returns true if the (possibly mixed-case) field is sensitive. */
export function isSensitiveField(name: string, extras?: ReadonlySet<string>): boolean {
  const norm = normaliseField(name);
  return SENSITIVE_FIELD_SET.has(norm) || (extras?.has(norm) ?? false);
}
