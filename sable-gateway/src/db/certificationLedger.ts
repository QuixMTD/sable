// gateway.certification_ledger — append-only, hash-chained, signed
// entries. One row per issued certificate; each row links to the
// previous via prev_hash and is signed with the platform Ed25519 key.
//
// Mutation is blocked at two layers:
//   1. RLS — no UPDATE / DELETE policies
//   2. Trigger — ledger_reject_mutation() raises an exception on any
//      UPDATE or DELETE so even a superuser can't quietly amend
//
// Writes go through the certificationLedger SERVICE, which constructs
// the canonical payload, hashes, signs, and (eventually) anchors the
// entry into a qualified TSA.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export interface LedgerEntryRow {
  id: string;
  entry_index: string;             // bigint → string
  prev_hash: Buffer;
  canonical_payload: Record<string, unknown>;
  entry_hash: Buffer;
  platform_key_id: string;
  platform_signature: Buffer;
  tsa_token: Buffer | null;
  tsa_provider: string | null;
  tsa_anchored_at: Date | null;
  created_at: Date;
}

export interface AppendInput {
  entryIndex: bigint;
  prevHash: Buffer;
  canonicalPayload: Record<string, unknown>;
  entryHash: Buffer;
  platformKeyId: string;
  platformSignature: Buffer;
}

export async function append(tx: TransactionSql, input: AppendInput): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.certification_ledger
      (entry_index, prev_hash, canonical_payload, entry_hash,
       platform_key_id, platform_signature)
    VALUES
      (${input.entryIndex.toString()},
       ${input.prevHash},
       ${JSON.stringify(input.canonicalPayload)}::jsonb,
       ${input.entryHash},
       ${input.platformKeyId},
       ${input.platformSignature})
    RETURNING id
  `;
  return rows[0]!;
}

export async function findById(sql: Sql, id: string): Promise<LedgerEntryRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<LedgerEntryRow[]>`SELECT * FROM gateway.certification_ledger WHERE id = ${id} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function latest(tx: TransactionSql): Promise<LedgerEntryRow | null> {
  const rows = await tx<LedgerEntryRow[]>`
    SELECT * FROM gateway.certification_ledger
    ORDER BY entry_index DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
