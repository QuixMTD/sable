// Transactional email sender. Wraps the underlying provider (SES via
// AWS SDK or SendGrid via fetch) and mirrors every send into
// gateway.email_logs. The recipient email itself is hashed before the
// row write so the log table holds no PII.
//
// Templates (initial set):
//   email_verification          — link to /auth/verify?token=...
//   password_reset              — link to /auth/password/reset/confirm
//   org_invite                  — link to /orgs/invites/accept
//   subscription_past_due       — payment retry CTA
//   subscription_cancelled      — cancellation confirmation
//   founding_customer_welcome   — kicked off after first paid checkout

import { AppError } from 'sable-shared';

export type EmailTemplate =
  | 'email_verification'
  | 'password_reset'
  | 'org_invite'
  | 'subscription_past_due'
  | 'subscription_cancelled'
  | 'founding_customer_welcome';

export interface SendInput {
  to: string;
  template: EmailTemplate;
  variables: Record<string, string>;
  userId?: string;
}

export async function send(_input: SendInput): Promise<{ providerMessageId: string }> {
  throw new AppError('INTERNAL_ERROR', { message: 'email.send not implemented' });
}
