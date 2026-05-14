// gateway.users — query layer.
//
// Encrypted columns (email, phone, date_of_birth) are written via the
// schema's enc() function (pgp_sym_encrypt with app.dek) and read via
// dec(). Both require the session DEK to be set on the transaction —
// pass `dek` into withRequestContext for inserts/reads that touch them.

import { withRequestContext, type Sql, type TransactionSql, type UserRole } from 'sable-shared';

export type AccountType = 'user' | 'admin' | 'individual';

export interface UserRow {
  id: string;
  org_id: string | null;
  email: Buffer;
  email_lookup: Buffer;
  email_verified: boolean;
  password_hash: string;
  phone: Buffer | null;
  name: string;
  date_of_birth: Buffer | null;
  role: UserRole;
  active_modules: string[];
  settings: Record<string, unknown>;
  referral_code: string;
  joining_date: Date;
  account_type: AccountType;
  stripe_customer_id: string | null;
  is_active: boolean;
  created_at: Date;
}

/** Public-shape row for self-profile reads — email is decrypted. */
export interface UserProfileRow {
  id: string;
  org_id: string | null;
  email: string;
  email_verified: boolean;
  name: string;
  role: UserRole;
  active_modules: string[];
  settings: Record<string, unknown>;
  joining_date: Date;
  account_type: AccountType;
  is_active: boolean;
}

export async function findById(sql: Sql, id: string): Promise<UserRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<UserRow[]>`SELECT * FROM gateway.users WHERE id = ${id} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function findByEmailLookup(sql: Sql, emailHash: Buffer): Promise<UserRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<UserRow[]>`SELECT * FROM gateway.users WHERE email_lookup = ${emailHash} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export interface CreateUserInput {
  orgId: string | null;
  email: string;              // plaintext — encrypted via enc() in SQL
  emailLookup: Buffer;
  passwordHash: string;
  name: string;
  role: UserRole;
  accountType: AccountType;
  referralCode: string;
}

/** Must run inside a transaction whose context carries `dek` set. */
export async function create(tx: TransactionSql, input: CreateUserInput): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.users
      (org_id, email, email_lookup, password_hash, name, role, account_type, referral_code)
    VALUES
      (${input.orgId},
       enc(${input.email}),
       ${input.emailLookup},
       ${input.passwordHash},
       ${input.name},
       ${input.role},
       ${input.accountType},
       ${input.referralCode})
    RETURNING id
  `;
  return rows[0]!;
}

export async function setEmailVerified(tx: TransactionSql, userId: string): Promise<void> {
  await tx`UPDATE gateway.users SET email_verified = true WHERE id = ${userId}`;
}

export async function updatePasswordHash(tx: TransactionSql, userId: string, hash: string): Promise<void> {
  await tx`UPDATE gateway.users SET password_hash = ${hash} WHERE id = ${userId}`;
}

export async function setActiveModules(tx: TransactionSql, userId: string, modules: string[]): Promise<void> {
  await tx`UPDATE gateway.users SET active_modules = ${modules} WHERE id = ${userId}`;
}

/** Decrypted profile read — requires DEK set on the transaction. */
export async function readProfile(sql: Sql, id: string, dek: string): Promise<UserProfileRow | null> {
  const rows = await withRequestContext(sql, { actor: 'user', userId: id, dek }, async (tx) =>
    tx<UserProfileRow[]>`
      SELECT
        id, org_id, dec(email) AS email, email_verified, name, role,
        active_modules, settings, joining_date, account_type, is_active
      FROM gateway.users
      WHERE id = ${id}
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}
