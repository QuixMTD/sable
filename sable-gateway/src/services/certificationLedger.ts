// Certification ledger writer. Append-only, hash-chained, Ed25519
// signed. The hash chain is what makes any past entry tamper-evident:
// flipping one byte of a past payload would break entry_hash, which
// would invalidate every subsequent entry's prev_hash.
//
// Signing key: Ed25519 keypair loaded once from env (ED25519_PRIVATE_KEY
// + ED25519_KEY_ID, both base64 of PKCS#8 / raw bytes). Production
// should move this to GCP KMS so the private key never lives in process
// memory — for now, env-loaded is fine for MVP.
//
// RFC 3161: tsa_token + tsa_provider + tsa_anchored_at are reserved on
// the row but not yet populated. When a TSA contract is signed, fill in
// `anchorWithTsa` and call it after `appendEntry`. We have the hook,
// not the integration.

import { createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import {
  optionalEnv,
  requireEnv,
  sha256,
  type Sql,
  type TransactionSql,
} from 'sable-shared';

import * as ledgerDb from '../db/certificationLedger.js';

// ---------------------------------------------------------------------------
// Key loading
// ---------------------------------------------------------------------------

interface KeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
}

let cached: KeyMaterial | undefined;

function loadKey(): KeyMaterial {
  if (cached !== undefined) return cached;
  // Accept either a base64-encoded PKCS#8 DER blob (production) or a
  // raw 32-byte Ed25519 seed (dev convenience). The seed path goes
  // through createPrivateKey's `raw` import flag.
  const raw = requireEnv('ED25519_PRIVATE_KEY');
  const keyId = requireEnv('ED25519_KEY_ID');
  const bytes = Buffer.from(raw, 'base64');
  let privateKey: KeyObject;
  if (bytes.length === 32) {
    privateKey = createPrivateKey({ key: bytes, format: 'der', type: 'raw' as never });
  } else {
    privateKey = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  }
  const publicKey = createPublicKey(privateKey);
  cached = { privateKey, publicKey, keyId };
  return cached;
}

export function publicKeyPem(): string {
  return loadKey().publicKey.export({ format: 'pem', type: 'spki' }).toString();
}

export function activeKeyId(): string {
  return loadKey().keyId;
}

// ---------------------------------------------------------------------------
// Canonical JSON (small JCS-style serialiser — sorted keys, no whitespace).
// Sufficient for our payload shape (strings, ints, ISO dates).
// ---------------------------------------------------------------------------

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalize: non-finite numbers are not allowed');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  throw new Error(`canonicalize: unsupported value type ${typeof value}`);
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

export interface CertificationPayload {
  /** Public certificate id (also stored on `certificates.public_id`). */
  public_id: string;
  user_id: string;
  user_name: string;
  level: 'foundation' | 'professional' | 'advanced';
  score: number;
  hours_at_issue: number;
  exam_attempt_id: string;
  issued_at: string;          // ISO-8601
}

export interface AppendResult {
  /** Row id in certification_ledger. */
  ledgerEntryId: string;
  entryIndex: bigint;
  entryHash: Buffer;
  prevHash: Buffer;
  platformSignature: Buffer;
  platformKeyId: string;
}

/**
 * Append a certification payload to the ledger. MUST be called inside a
 * transaction so the previous-entry read and the new-entry write are
 * serialised — concurrent issues would otherwise produce two rows with
 * the same prev_hash.
 */
export async function appendEntry(tx: TransactionSql, payload: CertificationPayload): Promise<AppendResult> {
  const { privateKey, keyId } = loadKey();

  const prior = await ledgerDb.latest(tx);
  const prevHash = prior?.entry_hash ?? Buffer.alloc(32, 0);     // genesis = 32 zero bytes
  const entryIndex = BigInt(prior?.entry_index ?? '0') + 1n;

  // Canonical payload as a string → bytes; hash includes the prev_hash
  // for chain linkage.
  const canonicalString = canonicalize(payload);
  const canonicalBytes = Buffer.from(canonicalString, 'utf8');
  const entryHash = sha256(Buffer.concat([prevHash, canonicalBytes]));
  const platformSignature = cryptoSign(null, entryHash, privateKey);

  const inserted = await ledgerDb.append(tx, {
    entryIndex,
    prevHash,
    canonicalPayload: payload as unknown as Record<string, unknown>,
    entryHash,
    platformKeyId: keyId,
    platformSignature,
  });

  return {
    ledgerEntryId: inserted.id,
    entryIndex,
    entryHash,
    prevHash,
    platformSignature,
    platformKeyId: keyId,
  };
}

// ---------------------------------------------------------------------------
// RFC 3161 anchor — reserved.
// ---------------------------------------------------------------------------

export interface TsaConfig {
  /** Full URL of the TSA endpoint (e.g. https://freetsa.org/tsr). */
  endpoint: string;
  provider: string;                  // 'freetsa', 'digicert', ...
}

export function tsaConfig(): TsaConfig | null {
  const endpoint = optionalEnv('TSA_ENDPOINT');
  const provider = optionalEnv('TSA_PROVIDER');
  if (endpoint === undefined || provider === undefined) return null;
  return { endpoint, provider };
}

// anchorWithTsa(ledgerEntryHash, tsaConfig) → fetches a TimeStampToken,
// writes back tsa_token / tsa_provider / tsa_anchored_at. Implementation
// pending a TSA contract — the request is an ASN.1 DER-encoded
// TimeStampReq containing the sha256(entry_hash); response is a
// TimeStampToken (CMS SignedData). Once a provider is chosen, build
// the request with `asn1.js` or a TSA client lib and persist the token.
//
// The ledger column is non-null-only-with-TSA so older entries stay
// readable while the integration is wired.

// ---------------------------------------------------------------------------
// Verification helper (used by /verify route)
// ---------------------------------------------------------------------------

export interface VerificationProof {
  entry_index: string;
  prev_hash_hex: string;
  entry_hash_hex: string;
  canonical_payload: Record<string, unknown>;
  platform_key_id: string;
  platform_signature_hex: string;
  platform_public_key_pem: string;
  tsa: { provider: string; anchored_at: string } | null;
  created_at: Date;
}

export async function buildVerificationProof(sql: Sql, ledgerEntryId: string): Promise<VerificationProof | null> {
  const row = await ledgerDb.findById(sql, ledgerEntryId);
  if (row === null) return null;
  return {
    entry_index: row.entry_index,
    prev_hash_hex: row.prev_hash.toString('hex'),
    entry_hash_hex: row.entry_hash.toString('hex'),
    canonical_payload: row.canonical_payload,
    platform_key_id: row.platform_key_id,
    platform_signature_hex: row.platform_signature.toString('hex'),
    platform_public_key_pem: publicKeyPem(),
    tsa: row.tsa_provider !== null && row.tsa_anchored_at !== null
      ? { provider: row.tsa_provider, anchored_at: row.tsa_anchored_at.toISOString() }
      : null,
    created_at: row.created_at,
  };
}

