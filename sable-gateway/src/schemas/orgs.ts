// /orgs/* schemas.

import { z } from 'sable-shared';

export const createOrgSchema = z.object({
  name: z.string().min(2).max(150),
  tradingName: z.string().min(2).max(150).optional(),
  companyReg: z.string().min(1).max(64).optional(),
  registeredAddress: z.string().min(1).max(500).optional(),
  billingEmail: z.string().email().optional(),
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'analyst', 'trader', 'viewer']),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(1).max(512),
});
