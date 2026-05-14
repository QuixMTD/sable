// gateway.waitlist — pre-launch leads captured by the landing page.
// Email + firm context + interest, plus admin-side fields (status,
// assigned_to, invite_token) for the sales pipeline.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export type WaitlistStatus = 'new' | 'contacted' | 'demo_booked' | 'converted' | 'not_interested';

export interface WaitlistRow {
  id: string;
  name: string;
  email: Buffer;
  email_lookup: Buffer;
  phone: Buffer | null;
  firm_name: string | null;
  aum_range: string | null;
  primary_interest: string | null;
  source: string | null;
  notes: string | null;
  status: WaitlistStatus;
  assigned_to: string | null;
  converted_user_id: string | null;
  invite_token: string | null;
  created_at: Date;
}

export interface CreateWaitlistInput {
  name: string;
  email: string;
  emailLookup: Buffer;
  phone?: string;
  firmName?: string;
  aumRange?: string;
  primaryInterest?: string;
  source?: string;
}

export async function findByEmailLookup(sql: Sql, hash: Buffer): Promise<WaitlistRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<WaitlistRow[]>`
      SELECT * FROM gateway.waitlist WHERE email_lookup = ${hash} LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function create(tx: TransactionSql, input: CreateWaitlistInput): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.waitlist
      (name, email, email_lookup, phone, firm_name, aum_range, primary_interest, source)
    VALUES
      (${input.name},
       enc(${input.email}),
       ${input.emailLookup},
       ${input.phone !== undefined ? tx`enc(${input.phone})` : null},
       ${input.firmName ?? null},
       ${input.aumRange ?? null},
       ${input.primaryInterest ?? null},
       ${input.source ?? null})
    RETURNING id
  `;
  return rows[0]!;
}
