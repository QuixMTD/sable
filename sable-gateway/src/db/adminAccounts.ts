// gateway.admin_accounts — Sable-internal staff (separate identity tree
// from users / organisations).

import type { AdminRole, Sql } from 'sable-shared';

export interface AdminAccountRow {
  id: string;
  email: Buffer;          // 🔐
  email_lookup: Buffer;   // #️⃣
  name: string;
  admin_role: AdminRole;
  password_hash: string;
  totp_secret: Buffer | null;
  is_active: boolean;
  created_at: Date;
}

export async function findByEmailLookup(_sql: Sql, _emailHash: Buffer): Promise<AdminAccountRow | null> {
  throw new Error('TODO: implement db/adminAccounts.findByEmailLookup');
}
