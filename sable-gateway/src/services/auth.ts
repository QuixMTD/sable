// Auth service — signup, login, logout, password reset, email verify.
//
// Encryption: signup writes plaintext email through the schema's enc()
// function. The transaction needs `dek` set so enc() can read app.dek.
//
// All flows that touch users tables run with actor='gateway' — signup
// pre-dates an authenticated user identity, and login is by definition
// not-yet-authenticated.

import { randomBytes } from 'node:crypto';
import {
  AppError,
  emailLookup,
  getDek,
  hashPassword,
  needsRehash,
  sha256,
  verifyPassword,
  withRequestContext,
  type RedisClient,
  type Sql,
} from 'sable-shared';

import * as evTokensDb from '../db/emailVerificationTokens.js';
import * as orgsDb from '../db/organisations.js';
import * as prTokensDb from '../db/passwordResetTokens.js';
import * as sessionsDb from '../db/sessions.js';
import * as usersDb from '../db/users.js';
import * as securityEventsDb from '../db/securityEvents.js';
import * as email from './email.js';
import * as security from './security.js';
import * as universities from './universities.js';
import * as sessions from './sessions.js';

const VERIFY_TOKEN_TTL_HOURS = 24;
const RESET_TOKEN_TTL_HOURS = 1;
const REFERRAL_CODE_BYTES = 6;        // 8-char base64url

export interface SignupInput {
  email: string;
  password: string;
  name: string;
  orgName?: string;
  /** Used to set ip_address on the resulting session. */
  ipAddress: string;
  platform?: 'macos' | 'windows' | 'web';
}

export interface SignupResult {
  userId: string;
  sessionToken: string;
  sessionId: string;
  expiresAt: Date;
  /** Surfaced so the controller can log the link in dev (email send is stubbed). */
  verificationToken: string;
}

export async function signup(sql: Sql, _redis: RedisClient, input: SignupInput): Promise<SignupResult> {
  const emailHash = emailLookup(input.email);

  const existing = await usersDb.findByEmailLookup(sql, emailHash);
  if (existing !== null) {
    throw new AppError('ALREADY_EXISTS', { message: 'Email is already registered' });
  }

  const passwordHash = await hashPassword(input.password);
  const verifyToken = randomBytes(32).toString('base64url');
  const verifyTokenHash = sha256(verifyToken);
  const verifyExpiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  // Two paths: with-org (user becomes 'owner', account_type 'user') or
  // solo seat (no org, account_type 'individual', role 'owner' for their
  // own resources — RLS keys off org_id IS NULL in the schema).
  const { userId } = await withRequestContext(
    sql,
    { actor: 'gateway', dek: getDek() },
    async (tx) => {
      let orgId: string | null = null;
      if (input.orgName !== undefined && input.orgName.length > 0) {
        const org = await orgsDb.create(tx, {
          name: input.orgName,
          referralCode: randomBytes(REFERRAL_CODE_BYTES).toString('base64url'),
        });
        orgId = org.id;
      }

      const user = await usersDb.create(tx, {
        orgId,
        email: input.email,
        emailLookup: emailHash,
        passwordHash,
        name: input.name,
        role: 'owner',
        accountType: orgId === null ? 'individual' : 'user',
        referralCode: randomBytes(REFERRAL_CODE_BYTES).toString('base64url'),
      });
      await evTokensDb.create(tx, user.id, verifyTokenHash, verifyExpiresAt);

      // Free student/staff licence for partner-university email domains.
      // No-op when the domain isn't on the partner list.
      await universities.applyOnSignup(tx, user.id, input.email);

      return { userId: user.id };
    },
  );

  const issued = await sessions.issue(sql, {
    userId,
    ipAddress: input.ipAddress,
    platform: input.platform,
  });

  // Fire the verification email after the user + token are committed.
  // Don't fail signup if Resend hiccups — email_logs records the
  // 'failed' row, and the user can request a resend from /auth/me.
  await email.sendVerification(sql, input.email, userId, verifyToken).catch(() => undefined);

  return {
    userId,
    sessionToken: issued.token,
    sessionId: issued.id,
    expiresAt: issued.expiresAt,
    verificationToken: verifyToken,
  };
}

// ---------------------------------------------------------------------------

export interface LoginInput {
  email: string;
  password: string;
  ipAddress: string;
  platform?: 'macos' | 'windows' | 'web';
  deviceFingerprint?: string;
}

export interface LoginResult {
  userId: string;
  sessionToken: string;
  sessionId: string;
  expiresAt: Date;
}

export async function login(sql: Sql, _redis: RedisClient, input: LoginInput): Promise<LoginResult> {
  const emailHash = emailLookup(input.email);
  const user = await usersDb.findByEmailLookup(sql, emailHash);

  if (user === null || !user.is_active) {
    await securityEventsDb.append(sql, {
      eventType: 'login_failed',
      ipAddress: input.ipAddress,
      details: { reason: 'unknown_email' },
    });
    throw new AppError('AUTH_FAILED', { message: 'Email or password is wrong' });
  }

  const ok = await verifyPassword(user.password_hash, input.password);
  if (!ok) {
    await securityEventsDb.append(sql, {
      eventType: 'login_failed',
      userId: user.id,
      ipAddress: input.ipAddress,
      details: { reason: 'wrong_password' },
    });
    throw new AppError('AUTH_FAILED', { message: 'Email or password is wrong' });
  }

  // Opportunistic rehash if Argon2 parameters have changed since enrolment.
  if (needsRehash(user.password_hash)) {
    const fresh = await hashPassword(input.password);
    await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
      usersDb.updatePasswordHash(tx, user.id, fresh),
    );
  }

  const deviceFingerprintHash = input.deviceFingerprint !== undefined ? sha256(input.deviceFingerprint) : undefined;
  const issued = await sessions.issue(sql, {
    userId: user.id,
    ipAddress: input.ipAddress,
    platform: input.platform,
    deviceFingerprintHash,
  });

  await securityEventsDb.append(sql, {
    eventType: 'login_success',
    userId: user.id,
    ipAddress: input.ipAddress,
  });

  return { userId: user.id, sessionToken: issued.token, sessionId: issued.id, expiresAt: issued.expiresAt };
}

// ---------------------------------------------------------------------------

export async function logout(
  sql: Sql,
  redis: RedisClient,
  sessionId: string,
  rawTokenHashHex: string,
): Promise<void> {
  await sessions.revoke(sql, redis, sessionId, rawTokenHashHex, 'user_logout');
}

// ---------------------------------------------------------------------------

export async function verifyEmail(sql: Sql, rawToken: string): Promise<void> {
  const hash = sha256(rawToken);
  const row = await evTokensDb.findByHash(sql, hash);
  if (row === null) throw new AppError('TOKEN_INVALID');
  if (row.used_at !== null) throw new AppError('TOKEN_INVALID', { message: 'Token already used' });
  if (row.expires_at.getTime() < Date.now()) throw new AppError('TOKEN_EXPIRED');

  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await usersDb.setEmailVerified(tx, row.user_id);
    await evTokensDb.markUsed(tx, row.id);
  });
}

// ---------------------------------------------------------------------------

export interface ChangePasswordInput {
  userId: string;
  current: string;
  next: string;
}

export async function changePassword(sql: Sql, _redis: RedisClient, input: ChangePasswordInput): Promise<void> {
  const user = await usersDb.findById(sql, input.userId);
  if (user === null) throw new AppError('AUTH_FAILED');
  const ok = await verifyPassword(user.password_hash, input.current);
  if (!ok) throw new AppError('AUTH_FAILED', { message: 'Current password incorrect' });

  const fresh = await hashPassword(input.next);
  await withRequestContext(sql, { actor: 'user', userId: input.userId }, async (tx) => {
    await usersDb.updatePasswordHash(tx, input.userId, fresh);
  });
}

// ---------------------------------------------------------------------------

export async function requestPasswordReset(sql: Sql, emailAddress: string, ipAddress: string): Promise<{ token: string | null }> {
  const emailHash = emailLookup(emailAddress);
  const user = await usersDb.findByEmailLookup(sql, emailHash);
  if (user === null) {
    // Don't leak — always behave the same to the caller.
    return { token: null };
  }

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await prTokensDb.create(tx, user.id, tokenHash, expiresAt, ipAddress);
  });

  await security.emitEvent(sql, 'password_reset_requested', { userId: user.id, ipAddress });
  await email.sendPasswordReset(sql, emailAddress, user.id, rawToken).catch(() => undefined);
  return { token: rawToken };
}

export async function confirmPasswordReset(sql: Sql, rawToken: string, newPassword: string): Promise<void> {
  const hash = sha256(rawToken);
  const row = await prTokensDb.findByHash(sql, hash);
  if (row === null) throw new AppError('TOKEN_INVALID');
  if (row.used_at !== null) throw new AppError('TOKEN_INVALID', { message: 'Token already used' });
  if (row.expires_at.getTime() < Date.now()) throw new AppError('TOKEN_EXPIRED');

  const fresh = await hashPassword(newPassword);
  await withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    await usersDb.updatePasswordHash(tx, row.user_id, fresh);
    await prTokensDb.markUsed(tx, row.id);
    // Cut every active session for the user — assume the reset is because
    // their old credential is compromised.
    await sessionsDb.revokeAllForUser(tx, row.user_id, 'password_reset');
  });
}
