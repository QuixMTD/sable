// gateway.organisations — query layer.
//
// Encrypted columns (registered_address, billing_email) write via enc()
// in SQL — caller must include `dek` in the transaction context.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export type BillingCycle = 'monthly' | 'annual';

export interface OrganisationRow {
  id: string;
  name: string;
  trading_name: string | null;
  company_reg: string | null;
  registered_address: Buffer | null;
  billing_email: Buffer | null;
  logo_url: string | null;
  active_modules: string[];
  seat_count: number;
  billing_cycle: BillingCycle | null;
  chatbot_enabled: boolean;
  referral_code: string | null;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: Date;
}

export interface CreateOrgInput {
  name: string;
  tradingName?: string;
  companyReg?: string;
  registeredAddress?: string;
  billingEmail?: string;
  referralCode: string;
}

export async function create(tx: TransactionSql, input: CreateOrgInput): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.organisations
      (name, trading_name, company_reg, registered_address, billing_email, referral_code)
    VALUES
      (${input.name},
       ${input.tradingName ?? null},
       ${input.companyReg ?? null},
       ${input.registeredAddress !== undefined ? tx`enc(${input.registeredAddress})` : null},
       ${input.billingEmail !== undefined ? tx`enc(${input.billingEmail})` : null},
       ${input.referralCode})
    RETURNING id
  `;
  return rows[0]!;
}

export async function findById(sql: Sql, id: string): Promise<OrganisationRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<OrganisationRow[]>`SELECT * FROM gateway.organisations WHERE id = ${id} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function setActiveModules(tx: TransactionSql, id: string, modules: string[]): Promise<void> {
  await tx`UPDATE gateway.organisations SET active_modules = ${modules} WHERE id = ${id}`;
}
