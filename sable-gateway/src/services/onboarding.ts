// Onboarding service — public surface for waitlist, enquiries, referral
// redemption. Aggressively rate-limited per IP at the router layer.

import { AppError, emailLookup, getDek, withRequestContext, type Sql } from 'sable-shared';

import * as enquiriesDb from '../db/enquiries.js';
import * as waitlistDb from '../db/waitlist.js';

export interface JoinWaitlistInput {
  name: string;
  email: string;
  phone?: string;
  firmName?: string;
  aumRange?: string;
  primaryInterest?: string;
  source?: string;
}

export async function joinWaitlist(sql: Sql, input: JoinWaitlistInput): Promise<{ alreadyJoined: boolean }> {
  const hash = emailLookup(input.email);
  const existing = await waitlistDb.findByEmailLookup(sql, hash);
  if (existing !== null) return { alreadyJoined: true };

  await withRequestContext(sql, { actor: 'public', dek: getDek() }, async (tx) => {
    await waitlistDb.create(tx, {
      name: input.name,
      email: input.email,
      emailLookup: hash,
      phone: input.phone,
      firmName: input.firmName,
      aumRange: input.aumRange,
      primaryInterest: input.primaryInterest,
      source: input.source,
    });
  });
  return { alreadyJoined: false };
}

export interface SubmitEnquiryInput {
  name: string;
  email: string;
  phone?: string;
  firmName?: string;
  enquiryType: enquiriesDb.EnquiryType;
  message: string;
  source?: string;
}

export async function submitEnquiry(sql: Sql, input: SubmitEnquiryInput): Promise<{ enquiryId: string }> {
  const hash = emailLookup(input.email);
  const created = await withRequestContext(sql, { actor: 'public', dek: getDek() }, async (tx) =>
    enquiriesDb.create(tx, {
      name: input.name,
      email: input.email,
      emailLookup: hash,
      phone: input.phone,
      firmName: input.firmName,
      enquiryType: input.enquiryType,
      message: input.message,
      source: input.source,
    }),
  );
  return { enquiryId: created.id };
}

/**
 * Redeem a referral code on behalf of an authenticated user. The
 * referral_codes table is one row per owner (uses counter increments on
 * each redemption); referrals tracks who redeemed what.
 */
export async function redeemReferral(sql: Sql, code: string, userId: string): Promise<void> {
  await withRequestContext(sql, { actor: 'user', userId }, async (tx) => {
    const codeRows = await tx<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM gateway.referral_codes WHERE code = ${code} LIMIT 1
    `;
    if (codeRows.length === 0) throw new AppError('NOT_FOUND', { message: 'Unknown referral code' });
    const codeRow = codeRows[0]!;
    if (codeRow.user_id === userId) {
      throw new AppError('VALIDATION_FAILED', { message: "Can't redeem your own referral code" });
    }
    // Idempotent — a user can only redeem any given code once.
    const existing = await tx<{ id: string }[]>`
      SELECT id FROM gateway.referrals
      WHERE code_id = ${codeRow.id} AND redeemed_by_user_id = ${userId}
      LIMIT 1
    `;
    if (existing.length > 0) throw new AppError('ALREADY_EXISTS', { message: 'Already redeemed' });

    await tx`
      INSERT INTO gateway.referrals (code_id, redeemed_by_user_id)
      VALUES (${codeRow.id}, ${userId})
    `;
    await tx`
      UPDATE gateway.referral_codes
      SET uses = uses + 1
      WHERE id = ${codeRow.id}
    `;
  });
}
