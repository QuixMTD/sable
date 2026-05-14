// gateway.enquiries — inbound "contact us" form submissions. Routed to
// admin support queue + Slack notification.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export type EnquiryType =
  | 'demo_request'
  | 'partnership'
  | 'press'
  | 'support'
  | 'complaint'
  | 'general';

export type EnquiryStatus = 'new' | 'contacted' | 'qualified' | 'demo_booked' | 'converted' | 'closed';

export interface EnquiryRow {
  id: string;
  name: string;
  email: Buffer;
  email_lookup: Buffer;
  phone: Buffer | null;
  firm_name: string | null;
  enquiry_type: EnquiryType;
  message: string | null;
  source: string | null;
  status: EnquiryStatus;
  assigned_to: string | null;
  internal_notes: string | null;
  created_at: Date;
}

export interface CreateEnquiryInput {
  name: string;
  email: string;
  emailLookup: Buffer;
  phone?: string;
  firmName?: string;
  enquiryType: EnquiryType;
  message?: string;
  source?: string;
}

export async function create(tx: TransactionSql, input: CreateEnquiryInput): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.enquiries
      (name, email, email_lookup, phone, firm_name, enquiry_type, message, source)
    VALUES
      (${input.name},
       enc(${input.email}),
       ${input.emailLookup},
       ${input.phone !== undefined ? tx`enc(${input.phone})` : null},
       ${input.firmName ?? null},
       ${input.enquiryType},
       ${input.message ?? null},
       ${input.source ?? null})
    RETURNING id
  `;
  return rows[0]!;
}

export async function listOpen(sql: Sql): Promise<EnquiryRow[]> {
  return withRequestContext(sql, { actor: 'admin', isAdmin: true }, async (tx) =>
    tx<EnquiryRow[]>`
      SELECT * FROM gateway.enquiries
      WHERE status IN ('new', 'contacted', 'qualified')
      ORDER BY created_at DESC
      LIMIT 500
    `,
  );
}
