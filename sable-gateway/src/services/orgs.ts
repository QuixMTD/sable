// Organisation service — CRUD on the org itself plus member management.
// Only owner-or-admin within an org may mutate.
//
// Invite flow is deferred: the gateway-schema doesn't currently have a
// dedicated org_invites table (org_roles stores role definitions, not
// memberships — those live on users.org_id). Once the schema adds an
// invite table, the `invite` / `acceptInvite` stubs below get wired up
// the same way the password-reset flow works.

import { randomBytes } from 'node:crypto';
import {
  AppError,
  getDek,
  withRequestContext,
  type Sql,
  type UserRole,
} from 'sable-shared';

import * as orgsDb from '../db/organisations.js';

export interface CreateOrgInput {
  /** Caller — becomes the org's first owner. Must currently have no org_id. */
  creatorUserId: string;
  name: string;
  tradingName?: string;
  companyReg?: string;
  registeredAddress?: string;
  billingEmail?: string;
}

export async function create(sql: Sql, input: CreateOrgInput): Promise<{ orgId: string }> {
  return withRequestContext(sql, { actor: 'user', userId: input.creatorUserId, dek: getDek() }, async (tx) => {
    const existing = await tx<{ org_id: string | null }[]>`
      SELECT org_id FROM gateway.users WHERE id = ${input.creatorUserId} LIMIT 1
    `;
    if (existing.length === 0) throw new AppError('NOT_FOUND');
    if (existing[0]!.org_id !== null) {
      throw new AppError('CONFLICT', { message: 'User already belongs to an organisation' });
    }

    const org = await orgsDb.create(tx, {
      name: input.name,
      tradingName: input.tradingName,
      companyReg: input.companyReg,
      registeredAddress: input.registeredAddress,
      billingEmail: input.billingEmail,
      referralCode: randomBytes(6).toString('base64url'),
    });

    await tx`
      UPDATE gateway.users
      SET org_id = ${org.id}, role = 'owner', account_type = 'user'
      WHERE id = ${input.creatorUserId}
    `;

    return { orgId: org.id };
  });
}

export interface MemberRow {
  id: string;
  name: string;
  email: string;            // decrypted
  role: UserRole;
  email_verified: boolean;
  is_active: boolean;
  joining_date: Date;
}

export async function listMembers(sql: Sql, orgId: string, callerUserId: string): Promise<MemberRow[]> {
  return withRequestContext(sql, { actor: 'user', userId: callerUserId, orgId, dek: getDek() }, async (tx) =>
    tx<MemberRow[]>`
      SELECT id, name, dec(email) AS email, role, email_verified, is_active, joining_date
      FROM gateway.users
      WHERE org_id = ${orgId}
      ORDER BY joining_date DESC
    `,
  );
}

export async function removeMember(sql: Sql, orgId: string, targetUserId: string, callerUserId: string): Promise<void> {
  await withRequestContext(sql, { actor: 'user', userId: callerUserId, orgId }, async (tx) => {
    // Owners can't be removed via this path; transfer ownership separately.
    const target = await tx<{ role: UserRole }[]>`
      SELECT role FROM gateway.users WHERE id = ${targetUserId} AND org_id = ${orgId} LIMIT 1
    `;
    if (target.length === 0) throw new AppError('NOT_FOUND');
    if (target[0]!.role === 'owner') throw new AppError('FORBIDDEN', { message: 'Transfer ownership before removing the owner' });

    await tx`UPDATE gateway.users SET org_id = NULL WHERE id = ${targetUserId}`;
    await tx`
      UPDATE gateway.sessions SET revoked_at = now(), revoke_reason = 'org_member_removed'
      WHERE user_id = ${targetUserId} AND revoked_at IS NULL
    `;
  });
}

export async function updateMemberRole(
  sql: Sql,
  orgId: string,
  targetUserId: string,
  newRole: UserRole,
  callerUserId: string,
): Promise<void> {
  await withRequestContext(sql, { actor: 'user', userId: callerUserId, orgId }, async (tx) => {
    const target = await tx<{ role: UserRole }[]>`
      SELECT role FROM gateway.users WHERE id = ${targetUserId} AND org_id = ${orgId} LIMIT 1
    `;
    if (target.length === 0) throw new AppError('NOT_FOUND');
    if (target[0]!.role === 'owner' && newRole !== 'owner') {
      throw new AppError('FORBIDDEN', { message: 'Transfer ownership through a separate endpoint' });
    }
    await tx`UPDATE gateway.users SET role = ${newRole} WHERE id = ${targetUserId}`;
  });
}

// Invite / acceptInvite stay stubbed until the schema adds an org_invites
// table — see the file header for rationale.
export async function invite(_sql: Sql): Promise<{ inviteId: string }> {
  throw new AppError('INTERNAL_ERROR', { message: 'orgs.invite needs an org_invites schema table' });
}

export async function acceptInvite(_sql: Sql): Promise<void> {
  throw new AppError('INTERNAL_ERROR', { message: 'orgs.acceptInvite needs an org_invites schema table' });
}
