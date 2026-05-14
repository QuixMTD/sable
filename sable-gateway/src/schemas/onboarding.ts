// /public/* (onboarding) schemas — completely unauthenticated, so the
// validators are deliberately conservative.

import { z } from 'sable-shared';

export const joinWaitlistSchema = z.object({
  email: z.string().email().max(255),
  referralSource: z.string().max(120).optional(),
  notes: z.string().max(1000).optional(),
});

export const submitEnquirySchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(120),
  topic: z.string().min(1).max(120),
  message: z.string().min(1).max(5000),
});

export const redeemReferralSchema = z.object({
  code: z.string().min(1).max(64),
});
