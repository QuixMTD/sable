// gateway.admin_audit_log — append-only, partitioned. Records every
// admin-console mutating action (block, unblock, role change, HMAC key
// rotation, manual subscription edits).

import type { TransactionSql } from 'sable-shared';

export interface AdminAuditLogRow {
  id: string;
  admin_id: string;
  action: string;
  target_type: string;
  target_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: Date;
}

export async function append(_tx: TransactionSql, _input: Partial<AdminAuditLogRow>): Promise<void> {
  throw new Error('TODO: implement db/adminAuditLog.append');
}
