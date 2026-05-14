// Admin audit log writer. Called from controllers that mutate
// admin-controlled state (HMAC rotation, manual subscription edits,
// blocks/unblocks, role grants).
//
// before / after snapshots are stored so the diff survives later edits
// to the underlying row.

import { withRequestContext, type Sql } from 'sable-shared';

export interface AuditInput {
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
}

export async function record(sql: Sql, input: AuditInput): Promise<void> {
  await withRequestContext(sql, { actor: 'admin', userId: input.adminId, isAdmin: true }, async (tx) => {
    await tx`
      INSERT INTO gateway.admin_audit_log
        (admin_user_id, action, target_type, target_id, before_state, after_state, ip_address)
      VALUES
        (${input.adminId},
         ${input.action},
         ${input.targetType},
         ${input.targetId},
         ${input.before === null ? null : JSON.stringify(input.before)}::jsonb,
         ${input.after === null ? null : JSON.stringify(input.after)}::jsonb,
         ${input.ipAddress})
    `;
  });
}
