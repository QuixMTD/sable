// MFA via TOTP. The shared secret lives in users.totp_secret (🔐
// encrypted column). Enrollment returns the otpauth URL for QR display;
// verify accepts a 6-digit code and the current step.

import { AppError, type Sql } from 'sable-shared';

export interface EnrollResult {
  otpauthUrl: string;
  /** Base32 secret — show once to the user as a fallback. */
  secret: string;
}

export async function enroll(_sql: Sql, _userId: string, _accountLabel: string): Promise<EnrollResult> {
  throw new AppError('INTERNAL_ERROR', { message: 'mfa.enroll not implemented' });
}

export async function verifyEnrollment(_sql: Sql, _userId: string, _code: string): Promise<void> {
  throw new AppError('INTERNAL_ERROR', { message: 'mfa.verifyEnrollment not implemented' });
}

export async function challenge(_sql: Sql, _userId: string, _code: string): Promise<boolean> {
  throw new AppError('INTERNAL_ERROR', { message: 'mfa.challenge not implemented' });
}

export async function disable(_sql: Sql, _userId: string): Promise<void> {
  throw new AppError('INTERNAL_ERROR', { message: 'mfa.disable not implemented' });
}
