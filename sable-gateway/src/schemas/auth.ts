// Zod schemas for /auth/* request payloads. Controllers use shared's
// parse() to validate then hand the typed input to the service layer.

import { z } from 'sable-shared';

export const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12).max(256),
  name: z.string().min(1).max(120),
  orgName: z.string().min(2).max(150).optional(),
  referralCode: z.string().max(64).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
  platform: z.enum(['macos', 'windows', 'web']).optional(),
  deviceFingerprint: z.string().max(512).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(256),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email().max(255),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1).max(512),
  newPassword: z.string().min(12).max(256),
});

export const mfaEnrollSchema = z.object({
  password: z.string().min(1),       // re-auth before issuing a TOTP secret
});

export const mfaVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});
