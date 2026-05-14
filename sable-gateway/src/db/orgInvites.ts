// gateway.org_invites — pending memberships. Owner/admin issues with
// invite(); the invitee accepts via /orgs/invites/accept with the
// single-use token. Tokens stored hashed, raw value only ever lives in
// the email link.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export type InviteRole = 'admin' | 'analyst' | 'trader' | 'viewer';

export interface OrgInviteRow {
  id: string;
  org_id: string;
  invited_by_user_id: string;
  email: Buffer;                  // 🔐
  email_lookup: Buffer;           // #️⃣
  role: InviteRole;
  token_hash: Buffer;             // #️⃣
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by_user_id: string | null;
  revoked_at: Date | null;
  revoked_by_user_id: string | null;
  created_at: Date;
}

export interface CreateInviteInput {
  orgId: string;
  invitedByUserId: string;
  email: string;                  // plaintext, encrypted via enc()
  emailLookup: Buffer;
  role: InviteRole;
  tokenHash: Buffer;
  expiresAt: Date;
}

export async function create(tx: TransactionSql, input: CreateInviteInput): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.org_invites
      (org_id, invited_by_user_id, email, email_lookup, role, token_hash, expires_at)
    VALUES
      (${input.orgId},
       ${input.invitedByUserId},
       enc(${input.email}),
       ${input.emailLookup},
       ${input.role},
       ${input.tokenHash},
       ${input.expiresAt})
    RETURNING id
  `;
  return rows[0]!;
}

export async function findByHash(sql: Sql, tokenHash: Buffer): Promise<OrgInviteRow | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<OrgInviteRow[]>`
      SELECT * FROM gateway.org_invites
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function listOpenForOrg(sql: Sql, orgId: string, callerUserId: string): Promise<OrgInviteRow[]> {
  return withRequestContext(sql, { actor: 'user', userId: callerUserId, orgId }, async (tx) =>
    tx<OrgInviteRow[]>`
      SELECT * FROM gateway.org_invites
      WHERE org_id = ${orgId}
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
    `,
  );
}

export async function markAccepted(tx: TransactionSql, inviteId: string, acceptedByUserId: string): Promise<void> {
  await tx`
    UPDATE gateway.org_invites
    SET accepted_at = now(), accepted_by_user_id = ${acceptedByUserId}
    WHERE id = ${inviteId} AND accepted_at IS NULL AND revoked_at IS NULL
  `;
}

export async function revoke(sql: Sql, inviteId: string, callerUserId: string, orgId: string): Promise<void> {
  await withRequestContext(sql, { actor: 'user', userId: callerUserId, orgId }, async (tx) => {
    await tx`
      UPDATE gateway.org_invites
      SET revoked_at = now(), revoked_by_user_id = ${callerUserId}
      WHERE id = ${inviteId} AND accepted_at IS NULL AND revoked_at IS NULL
    `;
  });
}
