// gateway.referral_codes + gateway.referrals — referral code issuance
// and redemption tracking. One file, both row shapes — they're a tight
// pair and the code is small.

import type { Sql, TransactionSql } from 'sable-shared';

export interface ReferralCodeRow {
  id: string;
  code: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  uses_left: number | null;        // null = unlimited
  expires_at: Date | null;
  is_active: boolean;
  created_at: Date;
}

export interface ReferralRow {
  id: string;
  code_id: string;
  redeemed_by_user_id: string;
  redeemed_by_org_id: string | null;
  reward_applied: boolean;
  created_at: Date;
}

export async function findCode(_sql: Sql, _code: string): Promise<ReferralCodeRow | null> {
  throw new Error('TODO: implement db/referrals.findCode');
}

export async function recordRedemption(_tx: TransactionSql, _input: Partial<ReferralRow>): Promise<ReferralRow> {
  throw new Error('TODO: implement db/referrals.recordRedemption');
}
