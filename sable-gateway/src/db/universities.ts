// gateway.universities — partner university list. Drives the self-serve
// student enrolment flow: a signup with an .edu email that matches a
// row here gets a free student licence.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export interface UniversityRow {
  id: string;
  name: string;
  country: string;
  email_domain: string;
  is_active: boolean;
  created_at: Date;
}

export async function findByDomain(sql: Sql, domain: string): Promise<UniversityRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<UniversityRow[]>`
      SELECT * FROM gateway.universities
      WHERE email_domain = ${domain.toLowerCase()} AND is_active = true
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function listActive(sql: Sql): Promise<UniversityRow[]> {
  return withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<UniversityRow[]>`
      SELECT * FROM gateway.universities WHERE is_active = true
      ORDER BY name
    `,
  );
}

export interface CreateUniversityInput {
  name: string;
  country: string;
  emailDomain: string;
}

export async function create(tx: TransactionSql, input: CreateUniversityInput): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.universities (name, country, email_domain)
    VALUES (${input.name}, ${input.country}, ${input.emailDomain.toLowerCase()})
    RETURNING id
  `;
  return rows[0]!;
}
