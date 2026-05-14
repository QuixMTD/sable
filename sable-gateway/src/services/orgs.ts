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
  emailLookup,
  getDek,
  sha256,
  withRequestContext,
  type Sql,
  type UserRole,
} from 'sable-shared';

import * as orgInvitesDb from '../db/orgInvites.js';
import * as orgsDb from '../db/organisations.js';
import * as email from './email.js';

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

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

const INVITE_TTL_DAYS = 7;

export interface InviteMemberInput {
  orgId: string;
  inviterUserId: string;
  email: string;
  role: 'admin' | 'analyst' | 'trader' | 'viewer';
}

export interface InviteResult {
  inviteId: string;
  /** Raw token — only ever returned here, embedded in the email link. */
  token: string;
}

export async function invite(sql: Sql, input: InviteMemberInput): Promise<InviteResult> {
  const inviteeHash = emailLookup(input.email);

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Inviter must belong to the org and be owner/admin (RLS enforces the
  // org_id match; we add the role check explicitly for a friendlier error).
  const { inviteId, inviterName, orgName } = await withRequestContext(
    sql,
    { actor: 'user', userId: input.inviterUserId, orgId: input.orgId, dek: getDek() },
    async (tx) => {
      const inviter = await tx<{ name: string; role: UserRole }[]>`
        SELECT name, role FROM gateway.users
        WHERE id = ${input.inviterUserId} AND org_id = ${input.orgId} LIMIT 1
      `;
      if (inviter.length === 0) throw new AppError('FORBIDDEN');
      if (inviter[0]!.role !== 'owner' && inviter[0]!.role !== 'admin') {
        throw new AppError('INSUFFICIENT_ROLE');
      }
      const org = await tx<{ name: string }[]>`
        SELECT name FROM gateway.organisations WHERE id = ${input.orgId} LIMIT 1
      `;
      if (org.length === 0) throw new AppError('NOT_FOUND');

      // Reject duplicate open invites for the same email + org.
      const dup = await tx<{ id: string }[]>`
        SELECT id FROM gateway.org_invites
        WHERE org_id = ${input.orgId}
          AND email_lookup = ${inviteeHash}
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        LIMIT 1
      `;
      if (dup.length > 0) throw new AppError('ALREADY_EXISTS', { message: 'An open invite already exists for this email' });

      const created = await orgInvitesDb.create(tx, {
        orgId: input.orgId,
        invitedByUserId: input.inviterUserId,
        email: input.email,
        emailLookup: inviteeHash,
        role: input.role,
        tokenHash,
        expiresAt,
      });
      return { inviteId: created.id, inviterName: inviter[0]!.name, orgName: org[0]!.name };
    },
  );

  await email.sendOrgInvite(sql, input.email, inviterName, orgName, rawToken).catch(() => undefined);

  return { inviteId, token: rawToken };
}

export interface AcceptInviteInput {
  rawToken: string;
  /** The accepting user must already exist (signed up). The session cookie identifies them. */
  acceptingUserId: string;
}

export async function acceptInvite(sql: Sql, input: AcceptInviteInput): Promise<{ orgId: string }> {
  const tokenHash = sha256(input.rawToken);
  const invite = await orgInvitesDb.findByHash(sql, tokenHash);
  if (invite === null) throw new AppError('TOKEN_INVALID');
  if (invite.accepted_at !== null) throw new AppError('TOKEN_INVALID', { message: 'Invite already accepted' });
  if (invite.revoked_at !== null) throw new AppError('TOKEN_INVALID', { message: 'Invite revoked' });
  if (invite.expires_at.getTime() < Date.now()) throw new AppError('TOKEN_EXPIRED');

  return withRequestContext(
    sql,
    { actor: 'gateway' },
    async (tx) => {
      // The accepting user mustn't already belong to a different org.
      const user = await tx<{ org_id: string | null }[]>`
        SELECT org_id FROM gateway.users WHERE id = ${input.acceptingUserId} LIMIT 1
      `;
      if (user.length === 0) throw new AppError('NOT_FOUND');
      if (user[0]!.org_id !== null && user[0]!.org_id !== invite.org_id) {
        throw new AppError('CONFLICT', { message: 'User already belongs to a different organisation' });
      }

      await tx`
        UPDATE gateway.users
        SET org_id = ${invite.org_id}, role = ${invite.role}, account_type = 'user'
        WHERE id = ${input.acceptingUserId}
      `;
      await orgInvitesDb.markAccepted(tx, invite.id, input.acceptingUserId);
      return { orgId: invite.org_id };
    },
  );
}

export async function listInvites(sql: Sql, orgId: string, callerUserId: string): Promise<orgInvitesDb.OrgInviteRow[]> {
  return orgInvitesDb.listOpenForOrg(sql, orgId, callerUserId);
}

export async function revokeInvite(sql: Sql, inviteId: string, callerUserId: string, orgId: string): Promise<void> {
  await orgInvitesDb.revoke(sql, inviteId, callerUserId, orgId);
}
